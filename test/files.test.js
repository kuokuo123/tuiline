'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, readFile, readdir, rm } = require('node:fs/promises');
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

for (const outcome of ['multiple', 'single', 'quit', 'empty', 'missing', 'denied', 'failed', 'interrupt', 'invalid']) {
  test(`Yazi chooser restores the terminal and removes temporary paths: ${outcome}`, async (t) => {
    const temporaryRoot = await directory(t);
    const events = [];
    const renderer = { suspend: () => events.push('suspend'), resume: () => events.push('resume') };
    const spawnPicker = (file, args, options) => {
      assert.equal(file, 'yazi');
      assert.equal(args[0], '--chooser-file');
      assert.equal(options.stdio, 'inherit');
      assert.deepEqual(events, ['suspend']);
      const child = new EventEmitter();
      process.nextTick(() => {
        if (outcome === 'multiple') writeFileSync(args[1], '/one file\n/two\n');
        if (outcome === 'single') writeFileSync(args[1], '/one file\n');
        if (outcome === 'empty') writeFileSync(args[1], '');
        if (outcome === 'invalid') writeFileSync(args[1], 'not/an/absolute/path\n');
        if (['missing', 'denied'].includes(outcome)) {
          child.emit('error', { code: outcome === 'missing' ? 'ENOENT' : 'EACCES' });
        }
        events.push('close');
        const code = outcome === 'failed' ? 1 : 0;
        child.emit('close', outcome === 'interrupt' ? 130 : code);
      });
      return child;
    };
    const result = pickFiles(renderer, undefined, { spawnPicker, temporaryRoot });
    if (outcome === 'invalid') {
      await assert.rejects(result, /invalid file path/);
    } else {
      const expected = ['missing', 'denied', 'failed'].includes(outcome) ? null : [];
      const files = await result;
      if (outcome === 'multiple') assert.deepEqual(files, ['/one file', '/two']);
      else if (outcome === 'single') assert.deepEqual(files, ['/one file']);
      else assert.deepEqual(files, expected);
    }
    assert.deepEqual(events, ['suspend', 'close', 'resume']);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
}

test('Yazi spawn exceptions restore the UI and fall back to paths', async (t) => {
  const temporaryRoot = await directory(t);
  const events = [];
  const renderer = { suspend: () => events.push('suspend'), resume: () => events.push('resume') };
  const files = await pickFiles(renderer, undefined, {
    temporaryRoot,
    spawnPicker: () => {
      throw new Error('Cannot launch');
    },
  });
  assert.equal(files, null);
  assert.deepEqual(events, ['suspend', 'resume']);
  assert.deepEqual(await readdir(temporaryRoot), []);
});

for (const destroyed of [false, true]) {
  test(`aborting Yazi waits for child close and does not resume a destroyed renderer: ${destroyed}`, async (t) => {
    const temporaryRoot = await directory(t);
    const controller = new AbortController();
    const events = [];
    const renderer = { isDestroyed: false, suspend: () => events.push('suspend'), resume: () => events.push('resume') };
    const spawned = Promise.withResolvers();
    const child = new EventEmitter();
    const result = pickFiles(renderer, controller.signal, {
      temporaryRoot,
      spawnPicker: (_file, _args, options) => {
        options.signal.addEventListener('abort', () => child.emit('error', new DOMException('Canceled', 'AbortError')));
        spawned.resolve();
        return child;
      },
    });
    await spawned.promise;
    renderer.isDestroyed = destroyed;
    controller.abort();
    assert.deepEqual(events, ['suspend']);
    events.push('close');
    child.emit('close', null, 'SIGTERM');
    await assert.rejects(result, { name: 'AbortError' });
    assert.deepEqual(events, destroyed ? ['suspend', 'close'] : ['suspend', 'close', 'resume']);
    assert.deepEqual(await readdir(temporaryRoot), []);
  });
}

test('an already canceled selection does not suspend the terminal or start Yazi', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pickFiles({ suspend: () => assert.fail() }, controller.signal), { name: 'AbortError' });
});

test('Yazi chooser reads paths from an actual child process without a shell', async (t) => {
  const temporaryRoot = await directory(t);
  const events = [];
  const renderer = { suspend: () => events.push('suspend'), resume: () => events.push('resume') };
  const files = await pickFiles(renderer, undefined, {
    temporaryRoot,
    spawnPicker: (_file, args, options) =>
      spawn(
        process.execPath,
        ['-e', 'require("node:fs").writeFileSync(process.argv.at(-1), "/one file\\n/two\\n")', '--', ...args],
        options,
      ),
  });
  assert.deepEqual(files, ['/one file', '/two']);
  assert.deepEqual(events, ['suspend', 'resume']);
  assert.deepEqual(await readdir(temporaryRoot), []);
});

test('path prompt accepts quoted names, home paths and multiple files without shell execution', () => {
  assert.deepEqual(parsePaths('"~/my file" /tmp/two'), [path.join(homedir(), 'my file'), '/tmp/two']);
  assert.deepEqual(parsePaths('~/photo.jpg "/home/me/my report.pdf" \'./another file.zip\''), [
    path.join(homedir(), 'photo.jpg'),
    '/home/me/my report.pdf',
    path.resolve('another file.zip'),
  ]);
  assert.deepEqual(parsePaths('"/tmp/$(touch marker)" /tmp/*.zip'), ['/tmp/$(touch marker)', '/tmp/*.zip']);
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
    if (uncertain) await assert.rejects(result, /Delivery unconfirmed/);
    else await result;
    assert.deepEqual(
      commands.map((command) => command.action),
      uncertain ? ['attach', 'send'] : ['attach', 'send', 'attach', 'send'],
    );
    assert.equal(backend.listenerCount('state'), 0);
  });
}

test('upload acknowledgement completes even when the pending frame is coalesced', async (t) => {
  const dir = await directory(t);
  const files = [path.join(dir, 'one'), path.join(dir, 'two')];
  await Promise.all(files.map((file) => writeFile(file, 'data')));
  const backend = new EventEmitter();
  let sends = 0;
  let attachmentId;
  backend.command = (command) => {
    if (command.action === 'attach') {
      attachmentId = `attachment-${sends}`;
      backend.emit('state', { ...state, attachment: { id: attachmentId } });
    }
    if (command.action === 'send') {
      sends++;
      // Neither a stale idle state nor an unrelated receipt is confirmation.
      backend.emit('state', { ...state, sendStatus: 'idle', sentAttachmentId: 'unrelated' });
      backend.emit('state', { ...state, sendStatus: 'idle', sentAttachmentId: attachmentId });
    }
  };
  await uploadFiles(backend, context, files, { timeoutMs: 1000 });
  assert.equal(sends, 2);
  assert.equal(backend.listenerCount('state'), 0);
  assert.equal(backend.listenerCount('failure'), 0);
});

test('upload timeout releases listeners, stops the queue, and never replays a send', async (t) => {
  const dir = await directory(t);
  const files = [path.join(dir, 'one'), path.join(dir, 'two')];
  await Promise.all(files.map((file) => writeFile(file, 'data')));
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => {
    commands.push(command);
    if (command.action === 'attach') backend.emit('state', { ...state, attachment: { id: 'attachment' } });
    if (command.action === 'send') backend.emit('state', { ...state, sendStatus: 'pending' });
  };
  await assert.rejects(uploadFiles(backend, context, files, { timeoutMs: 15 }), /Delivery unconfirmed/);
  backend.emit('state', { ...state, sendStatus: 'idle', sentAttachmentId: 'attachment' });
  assert.deepEqual(
    commands.map((command) => command.action),
    ['attach', 'send'],
  );
  assert.equal(backend.listenerCount('state'), 0);
  assert.equal(backend.listenerCount('failure'), 0);
});

test('photo upload failures retain the backend safe operation stage', async (t) => {
  const dir = await directory(t);
  const file = path.join(dir, 'photo.png');
  await writeFile(file, 'validated by backend');
  const backend = new EventEmitter();
  let sends = 0;
  const note = 'Delivery unconfirmed: upload original (plain): request failed; check LINE before retrying';
  backend.command = (command) => {
    if (command.action === 'attach') backend.emit('state', { ...state, attachment: { id: 'photo' } });
    if (command.action === 'send') {
      sends++;
      backend.emit('state', { ...state, sendStatus: 'uncertain', sendNote: note });
    }
  };
  await assert.rejects(uploadFiles(backend, context, [file, file], { image: true }), { message: note });
  assert.equal(sends, 1);
  assert.equal(backend.listenerCount('state'), 0);
});

for (const outcome of ['success', 'uncertain', 'cancel', 'navigate']) {
  test(`photo uploads leave navigation responsive during and after ${outcome}`, { timeout: 5000 }, async (t) => {
    const { createTestRenderer } = await import('@opentui/core/testing');
    const { createApp } = require('../line-tui/app');
    const dir = await directory(t);
    const file = path.join(dir, 'photo.png');
    await writeFile(file, 'image validated by backend');
    const setup = await createTestRenderer({ width: 110, height: 24, kittyKeyboard: true });
    const backend = new EventEmitter();
    const started = Promise.withResolvers();
    const commands = [];
    let frame = {
      ...state,
      status: 'ready',
      sendStatus: 'idle',
      chats: [
        { id: context.id, name: 'First' },
        { id: 'other', name: 'Other' },
      ],
      messages: Array.from({ length: 30 }, (_, index) => ({ id: `${index + 1}`, text: `Message ${index}` })),
    };
    backend.command = (command) => {
      commands.push(command);
      if (command.action === 'attach') {
        frame = { ...frame, attachment: { id: 'photo' } };
        backend.emit('state', frame);
      }
      if (command.action === 'send') {
        frame = { ...frame, sendStatus: 'pending', uploadPending: true };
        backend.emit('state', frame);
        started.resolve();
      }
      if (command.action === 'select') {
        frame = { ...frame, selectedId: command.id, selection: frame.selection + 1 };
        backend.emit('state', frame);
      }
    };
    backend.close = () => {};
    const app = await createApp(setup.renderer, backend, {
      pickFiles: async () => (outcome === 'success' ? [file] : [file, file]),
      hintsFile: path.join(dir, 'preferences', 'hidden'),
    });
    t.after(() => {
      app.dispose();
      setup.renderer.destroy();
    });
    backend.emit('state', frame);
    setup.mockInput.pressKey('l');
    setup.mockInput.pressKey('i', { ctrl: true });
    await started.promise;
    await setup.renderOnce();
    const history = setup.renderer.root.findDescendantById('line-history');
    const before = history.scrollTop;
    setup.mockInput.pressKey('k');
    setup.mockInput.pressKey('b', { ctrl: true });
    await setup.renderOnce();
    assert.ok(history.scrollTop < before, 'upload must not block scrolling');
    const hintText = () =>
      setup.renderer.root
        .findDescendantById('line-hints')
        .content.chunks.map((chunk) => chunk.text)
        .join('');
    setup.mockInput.pressKey('h');
    assert.match(hintText(), /CHATS/);
    setup.mockInput.pressKey('t', { ctrl: true });
    assert.equal(commands.filter((command) => command.action === 'attach').length, 1, 'no overlapping upload');
    if (outcome === 'navigate') {
      setup.mockInput.pressKey('j');
      assert.equal(frame.selectedId, 'other');
    } else if (outcome === 'cancel') {
      setup.mockInput.pressEscape();
    } else {
      frame = {
        ...frame,
        uploadPending: false,
        sendStatus: outcome === 'success' ? 'idle' : 'uncertain',
        attachment: outcome === 'success' ? undefined : { id: 'photo' },
        sentAttachmentId: outcome === 'success' ? 'photo' : '',
      };
      backend.emit('state', frame);
    }
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    await setup.renderOnce();
    assert.match(hintText(), /CHATS/, 'completion must not restore stale conversation focus');
    setup.mockInput.pressKey('l');
    assert.match(hintText(), /SCROLL/);
    assert.equal(commands.filter((command) => command.action === 'send').length, 1, 'no duplicate or queued send');
    if (outcome === 'uncertain') assert.match(setup.captureCharFrame(), /Delivery unconfirmed/);
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
    pickFiles: async (renderer, signal) => {
      assert.equal(renderer, setup.renderer);
      assert.ok(signal instanceof AbortSignal);
      return null;
    },
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

for (const canceled of [false, true]) {
  test(
    `Ctrl+T uploads Yazi selections immediately without showing the path prompt: canceled=${canceled}`,
    { timeout: 5000 },
    async (t) => {
      const { createTestRenderer } = await import('@opentui/core/testing');
      const { createApp } = require('../line-tui/app');
      const dir = await directory(t);
      const files = [path.join(dir, 'one file'), path.join(dir, 'two')];
      await Promise.all(files.map((file) => writeFile(file, 'data')));
      const setup = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true });
      const backend = new EventEmitter();
      const sent = Promise.withResolvers();
      const commands = [];
      const frame = {
        ...state,
        status: 'ready',
        chats: [{ id: 'chat', name: 'Chat' }],
        messages: [],
        draft: 'keep draft',
      };
      backend.command = (command) => {
        commands.push(command);
        if (command.action === 'attach') backend.emit('state', { ...frame, attachment: { id: 'attachment' } });
        if (command.action === 'send') {
          backend.emit('state', { ...frame, sendStatus: 'pending', attachment: { id: 'attachment' } });
          backend.emit('state', { ...frame, sendStatus: 'idle' });
          if (commands.filter((item) => item.action === 'send').length === 2) sent.resolve();
        }
      };
      backend.close = () => {};
      const app = await createApp(setup.renderer, backend, { pickFiles: async () => (canceled ? [] : files) });
      t.after(() => {
        app.dispose();
        setup.renderer.destroy();
      });
      backend.emit('state', frame);
      setup.mockInput.pressKey('t', { ctrl: true });
      if (!canceled) await sent.promise;
      await setup.renderOnce();
      assert.equal(setup.renderer.root.findDescendantById('line-file-paths').visible, false);
      assert.equal(commands.filter((item) => item.action === 'send').length, canceled ? 0 : 2);
      assert.equal(app.input.value, 'keep draft');
    },
  );
}
