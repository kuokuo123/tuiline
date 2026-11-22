'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { homedir } = require('node:os');
const { pathToFileURL } = require('node:url');

function run(file, args, signal) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', maxBuffer: 65536, signal }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// null means no usable picker; [] means the user canceled.
async function pickFiles(signal, env = process.env, execute = run) {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  for (const [file, args] of [
    ['zenity', ['--file-selection', '--multiple', '--separator=\n', '--title=Upload files to LINE']],
    [
      'kdialog',
      ['--getopenfilename', homedir(), '*', '--multiple', '--separate-output', '--title', 'Upload files to LINE'],
    ],
  ]) {
    const { error, stdout, stderr } = await execute(file, args, signal);
    signal?.throwIfAborted();
    if (!error) return stdout.split('\n').filter(Boolean);
    if (error.code === 1 && !error.killed && !stderr?.trim()) return [];
  }
  return null;
}

async function downloadsDirectory(env = process.env, execute = run) {
  const { error, stdout } = await execute('xdg-user-dir', ['DOWNLOAD']);
  const configured = stdout.trim();
  let directory = !error && path.isAbsolute(configured) ? configured : '';
  if (!directory) {
    try {
      const config = await fs.readFile(
        path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'user-dirs.dirs'),
        'utf8',
      );
      const match = config.match(/^XDG_DOWNLOAD_DIR="([^"\n]+)"/m);
      const value = match?.[1].replace(/^\$HOME(?=\/|$)/, homedir());
      if (value && path.isAbsolute(value)) directory = value;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  directory ||= path.join(homedir(), 'Downloads');
  await fs.mkdir(directory, { recursive: true });
  // The backend intentionally refuses symlinked path components.
  return fs.realpath(directory);
}

function parsePaths(value) {
  const paths = [];
  let token = '',
    quote = '';
  for (const char of value.trim()) {
    if (quote) {
      if (char === quote) quote = '';
      else token += char;
      // eslint-disable-next-line quotes
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (token) paths.push(token);
      token = '';
    } else {
      token += char;
    }
  }
  if (quote) throw new Error('Close the quote around the file path.');
  if (token) paths.push(token);
  return paths.map((file) => path.resolve(file.replace(/^~(?=\/|$)/, homedir())));
}

function waitForState(backend, context, signal, command, check) {
  return new Promise((resolve, reject) => {
    let timer; // eslint-disable-line prefer-const
    const finish = (error, value) => {
      clearTimeout(timer);
      backend.off('state', onState); // eslint-disable-line no-use-before-define
      backend.off('failure', onFailure); // eslint-disable-line no-use-before-define
      signal?.removeEventListener('abort', onAbort); // eslint-disable-line no-use-before-define
      if (error) reject(error);
      else resolve(value);
    };
    const onFailure = () => finish(new Error('Backend disconnected. Check LINE before retrying an upload.'));
    const onAbort = () => finish(new DOMException('File transfer canceled', 'AbortError'));
    const onState = (view) => {
      if (view.session !== context.session || view.selectedId !== context.id || view.selection !== context.selection) {
        finish(new Error('Conversation changed; remaining files were not sent.'));
        return;
      }
      try {
        const result = check(view);
        if (result) finish(null, result);
      } catch (error) {
        finish(error);
      }
    };
    backend.on('state', onState);
    backend.on('failure', onFailure);
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(new Error('Transfer timed out. Check LINE before retrying an upload.')), 135000);
    if (signal?.aborted) onAbort();
    else backend.command(command);
  });
}

async function uploadFiles(backend, context, files, { signal, replyTo = '', onProgress = () => {} } = {}) {
  // Validate the whole selection before sending anything.
  const resolved = [];
  for (const file of files) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) {
      throw new Error('Choose regular files up to 20 MiB each (not symlinks).');
    }
    resolved.push(await fs.realpath(file));
  }
  for (const [index, file] of resolved.entries()) {
    signal?.throwIfAborted();
    onProgress(`Uploading ${index + 1}/${files.length}: ${path.basename(file)}`);
    let attaching = false;
    const attachment = await waitForState(
      backend,
      context,
      signal,
      { action: 'attach', ...context, url: pathToFileURL(file).href },
      (view) => {
        if (view.fileStatus === 'pending') attaching = true;
        if (view.attachment) return view.attachment;
        if (attaching && view.fileStatus === 'idle' && view.sendNote) throw new Error(view.sendNote);
        return null;
      },
    );
    let pending = false;
    await waitForState(
      backend,
      context,
      signal,
      { action: 'send', ...context, text: '', attachmentId: attachment.id, replyTo: index === 0 ? replyTo : '' },
      (view) => {
        if (view.sendStatus === 'pending') pending = true;
        if (view.sendStatus === 'uncertain') {
          throw new Error('Upload result uncertain. Check LINE before retrying; remaining files were not sent.');
        }
        return pending && view.sendStatus === 'idle' && !view.attachment;
      },
    );
  }
}

async function downloadFile(backend, context, message, { signal, directory, onProgress = () => {} } = {}) {
  directory ||= await downloadsDirectory();
  const extensions = { 1: '.jpg', 2: '.mp4', 3: '.m4a' };
  // Never treat a sender-supplied filename as a path.
  const name = path
    .basename(
      (message.fileName || `LINE-${message.id}${extensions[message.contentType] || '.bin'}`).replaceAll('\\', '/'),
    )
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '_');
  const safe = name === '.' || name === '..' || !name ? `LINE-${message.id}.bin` : name;
  const extension = path.extname(safe);
  const stem = path.basename(safe, extension).slice(0, 60);
  let file;
  for (let index = 0; ; index++) {
    file = path.join(directory, `${stem}${index ? ` (${index})` : ''}${extension.slice(0, 16)}`);
    try {
      await fs.lstat(file);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
  }
  let pending = false;
  await waitForState(
    backend,
    context,
    signal,
    { action: 'download', ...context, messageId: message.id, url: pathToFileURL(file).href },
    (view) => {
      if (view.fileStatus === 'pending') pending = true;
      const total = view.downloadTotal ? ` / ${view.downloadTotal}` : '';
      onProgress(`Downloading… ${view.downloadReceived || 0}${total} bytes · Esc cancel`);
      return pending && view.fileStatus === 'idle';
    },
  );
  await fs.access(file);
  return file;
}

module.exports = { pickFiles, downloadsDirectory, parsePaths, uploadFiles, downloadFile };
