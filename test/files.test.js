'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { writeFileSync } = require('node:fs');
const { tmpdir, homedir } = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { pickFiles, parsePaths, downloadsDirectory, uploadFiles, downloadFile } = require('../line-tui/files');

const context = { id: 'chat', session: 'session', selection: 1 };
const state = { ...context, selectedId: 'chat' };
async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tuiline-files-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('file picker falls back, supports multiple paths, and distinguishes cancellation', async () => {
  assert.equal(await pickFiles(undefined, {}, () => assert.fail()), null);
  const calls = [];
  const files = await pickFiles(undefined, { DISPLAY: ':0' }, async (file) => {
    calls.push(file);
    return file === 'zenity' ? { error: { code: 'ENOENT' } } : { stdout: '/one file\n/two\n' };
  });
  assert.deepEqual(calls, ['zenity', 'kdialog']);
  assert.deepEqual(files, ['/one file', '/two']);
  assert.deepEqual(await pickFiles(undefined, { DISPLAY: ':0' }, async () => ({ error: { code: 1 } })), []);
  assert.equal(
    await pickFiles(undefined, { DISPLAY: ':0' }, async () => ({ error: { code: 1 }, stderr: 'Cannot open display' })),
    null,
  );
});

test('path prompt accepts quoted names, home paths and multiple files without shell execution', () => {
  assert.deepEqual(parsePaths('"~/my file" /tmp/two'), [path.join(homedir(), 'my file'), '/tmp/two']);
  assert.throws(() => parsePaths('"unclosed'), /quote/);
  assert.deepEqual(parsePaths(''), []);
});

test('downloads use the system XDG download directory', async (t) => {
  const dir = await directory(t);
  const target = path.join(dir, '下載');
  assert.equal(await downloadsDirectory({}, async () => ({ stdout: `${target}\n` })), target);
});

test('downloads sanitize filenames and preserve existing files', async (t) => {
  const dir = await directory(t);
  await writeFile(path.join(dir, 'report.txt'), 'old');
  const backend = new EventEmitter();
  backend.command = (command) => {
    assert.equal(command.action, 'download');
    backend.emit('state', { ...state, fileStatus: 'pending' });
    writeFileSync(fileURLToPath(command.url), 'new');
    backend.emit('state', { ...state, fileStatus: 'idle' });
  };
  const saved = await downloadFile(backend, context, { id: '1', fileName: '../../report.txt' }, { directory: dir });
  assert.equal(saved, path.join(dir, 'report (1).txt'));
  assert.equal(await readFile(path.join(dir, 'report.txt'), 'utf8'), 'old');
  assert.equal(await readFile(saved, 'utf8'), 'new');
  assert.equal(backend.listenerCount('state'), 0);
});

for (const uncertain of [false, true]) {
  test(`uploads send sequentially and stop on uncertainty: ${uncertain}`, async (t) => {
    const dir = await directory(t);
    const files = [path.join(dir, 'one'), path.join(dir, 'two')];
    await Promise.all(files.map((file) => writeFile(file, 'data')));
    const backend = new EventEmitter();
    const commands = [];
    backend.command = (command) => {
      commands.push(command);
      if (command.action === 'attach') backend.emit('state', { ...state, attachment: { id: 'attachment' } });
      if (command.action === 'send') {
        assert.equal(command.text, '');
        assert.equal(command.attachmentId, 'attachment');
        backend.emit('state', { ...state, sendStatus: 'pending' });
        backend.emit('state', { ...state, sendStatus: uncertain ? 'uncertain' : 'idle' });
      }
    };
    const result = uploadFiles(backend, context, files);
    if (uncertain) await assert.rejects(result, /uncertain/);
    else await result;
    assert.deepEqual(
      commands.map((command) => command.action),
      uncertain ? ['attach', 'send'] : ['attach', 'send', 'attach', 'send'],
    );
    assert.equal(backend.listenerCount('state'), 0);
  });
}

test('uploads validate the whole selection before sending', async (t) => {
  const dir = await directory(t);
  const backend = new EventEmitter();
  backend.command = () => assert.fail('must not send');
  const file = path.join(dir, 'valid');
  await writeFile(file, 'data');
  await assert.rejects(uploadFiles(backend, context, [file, dir]), /regular files/);
});

test('uploads ignore stale notes and stop if attachment preparation fails', async (t) => {
  const dir = await directory(t);
  const file = path.join(dir, 'file');
  await writeFile(file, 'data');
  const backend = new EventEmitter();
  backend.command = (command) => {
    assert.equal(command.action, 'attach');
    backend.emit('state', { ...state, fileStatus: 'idle', sendNote: 'old note' });
    backend.emit('state', { ...state, fileStatus: 'pending', sendNote: '' });
    backend.emit('state', { ...state, fileStatus: 'idle', sendNote: 'File changed while attaching' });
  };
  await assert.rejects(uploadFiles(backend, context, [file]), /File changed/);
  assert.equal(backend.listenerCount('state'), 0);
});

test('transfer cancellation removes backend listeners', async (t) => {
  const dir = await directory(t);
  const backend = new EventEmitter();
  const controller = new AbortController();
  backend.command = () => controller.abort();
  await assert.rejects(downloadFile(backend, context, { id: '1' }, { directory: dir, signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.equal(backend.listenerCount('state'), 0);
});

test('Ctrl+S downloads the cursor-selected message; Ctrl+T falls back to a path prompt', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const { createApp } = require('../line-tui/app');
  const setup = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const saved = [];
  const app = await createApp(setup.renderer, backend, {
    pickFiles: async () => null,
    downloadFile: async (_backend, _context, message) => {
      saved.push(message.id);
      return '/Downloads/report.txt';
    },
  });
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', {
    ...state,
    status: 'ready',
    chats: [{ id: 'chat', name: 'Chat' }],
    draft: 'keep draft',
    messages: [
      { id: '1', text: 'first file', contentType: 14, downloadable: true },
      { id: '2', text: 'second file', contentType: 14, downloadable: true },
    ],
  });
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  setup.mockInput.pressKey('k');
  setup.mockInput.pressKey('s', { ctrl: true });
  await setup.renderOnce();
  assert.deepEqual(saved, ['1']);
  setup.mockInput.pressKey('t', { ctrl: true });
  await setup.renderOnce();
  const prompt = setup.renderer.root.findDescendantById('line-file-paths');
  assert.equal(prompt.visible, true);
  assert.equal(app.input.value, 'keep draft');
  setup.mockInput.pressEscape();
  await setup.renderOnce();
  assert.equal(prompt.visible, false);
  assert.equal(
    commands.some((command) => command.action === 'send'),
    false,
  );
  assert.equal(app.input.value, 'keep draft');

  const dir = await directory(t);
  const file = path.join(dir, 'upload file.txt');
  await writeFile(file, 'upload');
  const frame = {
    ...state,
    status: 'ready',
    chats: [{ id: 'chat', name: 'Chat' }],
    draft: 'keep draft',
    messages: [{ id: '1', text: 'file', contentType: 14, downloadable: true }],
  };
  backend.command = (command) => {
    commands.push(command);
    if (command.action === 'attach') backend.emit('state', { ...frame, attachment: { id: 'file' } });
    if (command.action === 'send') {
      backend.emit('state', { ...frame, sendStatus: 'pending', attachment: { id: 'file' } });
      backend.emit('state', { ...frame, sendStatus: 'idle' });
    }
  };
  setup.mockInput.pressKey('t', { ctrl: true });
  await setup.renderOnce();
  prompt.value = `"${file}"`;
  setup.mockInput.pressEnter();
  for (let attempt = 0; attempt < 100 && !commands.some((command) => command.action === 'send'); attempt++) {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  assert.equal(commands.filter((command) => command.action === 'send').length, 1);
  assert.equal(prompt.visible, false);
  assert.equal(app.input.value, 'keep draft');
});
