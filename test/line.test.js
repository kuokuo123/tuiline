'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Backend, resolveBackend } = require('../line-tui/backend');
const { createApp, clean } = require('../line-tui/app');
const { loadHintsVisible } = require('../line-tui/preferences');

test('LINE mouse clicks select chats and individual messages, not pane focus', async (t) => {
  const { createTestRenderer, createMockMouse } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 110, height: 25, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', {
    mode: 'demo',
    status: 'ready',
    selectedId: 'alice',
    session: 'demo',
    selection: 1,
    chats: [
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
    ],
    messages: [
      { id: '1', sender: 'Alice', text: 'First' },
      { id: '2', sender: 'Alice', text: 'Second' },
      { id: '3', sender: 'Alice', text: 'Third' },
    ],
  });
  await setup.renderOnce();
  const mouse = createMockMouse(setup.renderer);
  const bob = setup.renderer.root.findDescendantById('line-chat-1');
  await mouse.click(bob.x + 5, bob.y);
  await setup.renderOnce();
  assert.ok(commands.some((command) => command.action === 'select' && command.id === 'bob'));
  assert.equal(bob.focused, false);
  assert.equal(bob.parent.focused, false, 'mouse selection must not focus the scrollbox');
  const first = setup.renderer.root.findDescendantById('line-message-0');
  // Click row padding rather than its text, exercising bubble and row routing.
  await mouse.click(first.x + first.width - 2, first.y);
  await setup.renderOnce();
  const hintText = () =>
    setup.renderer.root
      .findDescendantById('line-hints')
      .content.chunks.map((chunk) => chunk.text)
      .join('');
  assert.match(hintText(), /SCROLL \[1\/3\]/);
  const second = setup.renderer.root.findDescendantById('line-message-1');
  await mouse.click(second.x + 4, second.y + 1);
  await setup.renderOnce();
  assert.match(hintText(), /SCROLL \[2\/3\]/);
  setup.mockInput.pressKey('?');
  await setup.renderOnce();
  const before = commands.filter((command) => command.action === 'select').length;
  await mouse.click(bob.x + 3, bob.y);
  assert.equal(commands.filter((command) => command.action === 'select').length, before);
});

test('LINE Ctrl+I selects photo upload while Tab keeps pane navigation', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 160, height: 25, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  const state = {
    mode: 'demo',
    status: 'ready',
    selectedId: 'alice',
    session: 'demo',
    selection: 1,
    chats: [{ id: 'alice', name: 'Alice' }],
    messages: [],
  };
  backend.command = (command) => {
    commands.push(command);
    if (command.action === 'attach') {
      backend.emit('state', { ...state, fileStatus: 'pending' });
      backend.emit('state', { ...state, attachment: { id: 'photo', name: 'photo.png', image: true } });
    }
    if (command.action === 'send') {
      backend.emit('state', { ...state, sendStatus: 'pending' });
      backend.emit('state', { ...state, sendStatus: 'idle' });
    }
  };
  backend.close = () => {};
  let picks = 0;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tuiline-photo-test-'));
  const photo = path.join(directory, 'photo.png');
  fs.writeFileSync(photo, 'backend validates image bytes');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const app = await createApp(setup.renderer, backend, {
    pickFiles: async () => {
      picks++;
      return [photo];
    },
  });
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', state);
  await setup.renderOnce();
  setup.mockInput.pressKey('tab');
  assert.equal(picks, 0);
  setup.mockInput.pressKey('i', { ctrl: true });
  await new Promise((resolve) => {
    backend.once('state', resolve);
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(picks, 1);
  assert.equal(commands.find((command) => command.action === 'attach').mode, 'image');
  assert.ok(commands.some((command) => command.action === 'send'));
  setup.mockInput.pressKey('i', { ctrl: true });
  await new Promise((resolve) => {
    backend.once('state', resolve);
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(picks, 2, 'a confirmed photo upload must immediately release Ctrl+I');
  assert.equal(commands.filter((command) => command.action === 'attach')[1].mode, 'image');
  setup.mockInput.pressKey('t', { ctrl: true });
  await new Promise((resolve) => {
    backend.once('state', resolve);
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(picks, 3);
  assert.equal(commands.filter((command) => command.action === 'attach')[2].mode, undefined);
});

test('LINE backend streams demo state and sends text without an account', async (t) => {
  let binary;
  try {
    binary = resolveBackend();
  } catch {
    t.skip('Reference LINE backend is not installed');
    return;
  }
  const backend = new Backend(binary, 'demo');
  t.after(() => backend.close());
  const wait = (predicate) =>
    new Promise((resolve, reject) => {
      const listener = (view) => {
        if (!predicate(view)) return;
        // eslint-disable-next-line no-use-before-define
        clearTimeout(timer);
        backend.off('state', listener);
        resolve(view);
      };
      const timer = setTimeout(() => {
        backend.off('state', listener);
        reject(new Error('LINE demo timeout'));
      }, 5000);
      backend.on('state', listener);
    });
  const ready = await wait((view) => view.chats.length && view.selectedId && view.status === 'ready');
  const context = { id: ready.selectedId, session: ready.session, selection: ready.selection };
  const sent = wait((view) => view.messages.some((message) => message.text === 'Terminal demo test'));
  backend.command({ action: 'draft', ...context, text: 'Terminal demo test', sequence: 1 });
  backend.command({ action: 'send', ...context, text: 'Terminal demo test' });
  const final = await sent;
  assert.equal(final.sendStatus, 'idle');
  assert.equal(final.draft, '');
});

test('LINE UI places incoming messages left and own messages right', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 30 });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', {
    chats: [],
    selectedId: 'chat',
    messages: [
      { id: '1', own: true, text: 'Outgoing message', replyTo: '2' },
      { id: '2', own: false, sender: 'Alice', text: 'Incoming message' },
      { id: '3', own: true, text: 'Short' },
      { id: '4', own: true, text: 'A long outgoing message '.repeat(5) },
    ],
  });
  await setup.renderOnce();
  const lines = setup.captureCharFrame().split('\n');
  const outgoing = lines.find((line) => line.includes('Outgoing message'));
  const incoming = lines.find((line) => line.includes('Incoming message'));
  assert.ok(outgoing);
  assert.ok(incoming);
  assert.ok(outgoing.indexOf('Outgoing message') > incoming.indexOf('Incoming message'));
  const short = lines.find((line) => line.includes('Short'));
  assert.ok(short);
  assert.equal(short.indexOf('Short'), outgoing.indexOf('Outgoing message'));
  const history = setup.renderer.root.findDescendantById('line-history');
  const ownContent = setup.renderer.root.findDescendantById('line-message-0').getChildren()[1];
  assert.equal(ownContent.width, 40);
  assert.equal(ownContent.x + ownContent.width, history.viewport.x + history.viewport.width);
});

test('LINE media cache controls are scoped to a signed-in live account', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 30 });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', {
    mode: 'live',
    account: { id: 'user', name: 'Me' },
    mediaCacheEnabled: true,
    mediaCacheBytes: 1048576,
    autoImages: true,
    chats: [],
    messages: [],
  });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /cached on 1 MiB · preview: auto/);
  backend.emit('state', {
    mode: 'live',
    account: { id: 'user', name: 'Me' },
    mediaCacheEnabled: false,
    mediaCacheBytes: 0,
    autoImages: false,
    chats: [],
    messages: [],
  });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /cached off 0 MiB · preview: selected/);
  setup.mockInput.pressKey('e', { ctrl: true });
  setup.mockInput.pressKey('k', { ctrl: true });
  assert.deepEqual(
    commands.slice(-2).map(({ action }) => action),
    ['media-cache-toggle', 'media-cache-clear'],
  );
  backend.emit('state', { mode: 'demo', account: {}, chats: [], messages: [] });
  setup.mockInput.pressKey('e', { ctrl: true });
  assert.equal(commands.length, 2);
});

test('LINE status and notes share one row unless a reply needs its banner', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 95, height: 20 });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tuiline-status-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend, { hintsFile: path.join(directory, 'tuiline', 'hints-hidden') });
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const status = setup.renderer.root.findDescendantById('line-status');
  const view = {
    mode: 'demo',
    statusText: '已連線',
    sendNote: 'Cache cleared',
    chats: [],
    messages: [],
  };
  backend.emit('state', view);
  await setup.renderOnce();
  assert.equal(status.height, 1);
  let lines = setup.captureCharFrame().split('\n');
  const statusLine = lines.findIndex((line) => line.includes('已連線'));
  assert.match(lines[statusLine], /已連線 · Cache cleared/);
  assert.match(lines[statusLine + 1], /\^E cache/);
  backend.emit('state', { ...view, sendNote: '', historyNote: 'History updated', sendStatus: 'pending' });
  await setup.renderOnce();
  lines = setup.captureCharFrame().split('\n');
  assert.match(
    lines.find((line) => line.includes('已連線')),
    /已連線 · History updated · Sending…/,
  );
  backend.emit('state', {
    ...view,
    reply: { id: '1', sender: 'Alice', text: 'Reply target' },
  });
  await setup.renderOnce();
  assert.equal(status.height, 2);
  lines = setup.captureCharFrame().split('\n');
  const replyLine = lines.findIndex((line) => line.includes('Reply to Alice'));
  assert.match(lines[replyLine + 1], /已連線 · Cache cleared/);
  assert.match(lines[replyLine + 2], /\^E cache/);
  backend.emit('state', {
    ...view,
    notificationNote: 'Notifications: desktop bus unavailable',
  });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Notifications: desktop bus unavailable/);
});

test('Ctrl+N requests a desktop notification test in live mode', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 20, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', { mode: 'live', chats: [], messages: [] });
  setup.mockInput.pressKey('n', { ctrl: true });
  assert.deepEqual(commands, [{ action: 'notification-test' }]);
  backend.emit('state', { mode: 'demo', chats: [], messages: [] });
  setup.mockInput.pressKey('n', { ctrl: true });
  assert.equal(commands.length, 1);
});

test('chat reorder preserves the sidebar selection by chat ID', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 22 });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const a = { id: 'a', name: 'Alice' };
  const b = { id: 'b', name: 'Bob' };
  backend.emit('state', { selectedId: 'a', chats: [a, b], messages: [] });
  await setup.renderOnce();
  backend.emit('state', { selectedId: 'a', chats: [b, a], messages: [] });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /› Alice/);
  setup.mockInput.pressKey('k');
  assert.deepEqual(commands.at(-1), { action: 'select', id: 'b' });
});

test('read receipts require loaded visible messages and focused conversation, not sidebar or overlays', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 22, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const view = {
    mode: 'live',
    status: 'ready',
    historyStatus: 'loading',
    selectedId: 'chat',
    session: 'session',
    selection: 1,
    chats: [{ id: 'chat', name: 'Alice', unread: 30 }],
    messages: Array.from({ length: 30 }, (_, i) => ({ id: String(101 + i), text: `Message ${i + 1}` })),
  };
  const reads = () => commands.filter(({ action }) => action === 'read-visible');
  backend.emit('state', view);
  setup.mockInput.pressEnter();
  await setup.renderOnce();
  assert.equal(reads().length, 0, 'cached messages displayed while history loads must not mark read');
  backend.emit('state', { ...view, historyStatus: 'ready' });
  await setup.renderOnce();
  assert.equal(reads().at(-1).messageId, '130');
  assert.equal(reads().at(-1).focused, true);
  const count = reads().length;
  await setup.renderOnce();
  assert.equal(reads().length, count, 'same visible cursor should not resend');
  setup.renderer.emit('blur');
  assert.equal(reads().at(-1).focused, false);
  await setup.renderOnce();
  assert.equal(reads().length, count + 1);
  setup.renderer.emit('focus');
  await setup.renderOnce();
  assert.equal(reads().at(-1).focused, true);
  const history = setup.renderer.root.findDescendantById('line-history');
  history.scrollTo(0);
  await setup.renderOnce();
  assert.ok(Number(reads().at(-1).messageId) < 130, 'offscreen newest message must not be marked');
  setup.mockInput.pressKey('?');
  await setup.renderOnce();
  assert.equal(reads().at(-1).focused, false);
  setup.mockInput.pressEscape();
  await setup.renderOnce();
  assert.equal(reads().at(-1).focused, true);
  setup.mockInput.pressKey('h');
  await setup.renderOnce();
  assert.equal(reads().at(-1).focused, false);
});

test('Ctrl+O gates read receipts and Ctrl+M toggles LINE mute with header, hints and help indicators', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 130, height: 24, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const view = {
    mode: 'live',
    status: 'ready',
    historyStatus: 'ready',
    account: { id: 'account', name: 'Me' },
    selectedId: 'chat',
    session: 'session',
    selection: 1,
    markReadEnabled: true,
    chats: [{ id: 'chat', name: 'Alice', muted: false }],
    messages: [{ id: '101', text: 'Hello' }],
  };
  backend.emit('state', view);
  setup.mockInput.pressEnter();
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /mark read: on/);
  assert.ok(commands.some(({ action, focused }) => action === 'read-visible' && focused));
  setup.mockInput.pressKey('o', { ctrl: true });
  assert.equal(commands.at(-1).action, 'mark-read-toggle');
  backend.emit('state', { ...view, markReadEnabled: false });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /mark read: off/);
  const count = commands.filter(({ action, focused }) => action === 'read-visible' && focused).length;
  await setup.renderOnce();
  assert.equal(commands.filter(({ action, focused }) => action === 'read-visible' && focused).length, count);
  setup.mockInput.pressKey('m', { ctrl: true });
  assert.deepEqual(commands.at(-1), {
    action: 'chat-mute-toggle',
    id: 'chat',
    session: 'session',
    selection: 1,
  });
  backend.emit('state', { ...view, markReadEnabled: false, chats: [{ ...view.chats[0], muted: true }] });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Alice /);
  const hints = setup.renderer.root.findDescendantById('line-hints').plainText;
  assert.match(hints, /\^O read.*\^M mute/);
  setup.mockInput.pressKey('?');
  const help = setup.renderer.root.findDescendantById('line-keybind-text').plainText;
  assert.match(help, /Ctrl\+O.*read receipts/);
  assert.match(help, /Ctrl\+M.*LINE/);
});

test('Ctrl+H reclaims the hint row and saves visibility independently of the media cache', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tuiline-hints-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const hintsFile = path.join(directory, 'tuiline', 'hints-hidden');
  const makeApp = async () => {
    const setup = await createTestRenderer({ width: 90, height: 18, kittyKeyboard: true });
    const backend = new EventEmitter();
    backend.command = () => {};
    backend.close = () => {};
    const app = await createApp(setup.renderer, backend, { hintsFile });
    backend.emit('state', { mode: 'demo', chats: [], messages: [] });
    await setup.renderOnce();
    return { setup, app };
  };
  const first = await makeApp();
  const hints = first.setup.renderer.root.findDescendantById('line-hints');
  const history = first.setup.renderer.root.findDescendantById('line-history');
  const height = history.viewport.height;
  assert.equal(hints.visible, true);
  assert.match(
    first.setup.captureCharFrame(),
    /\^E cache · \^K clear · \^P preview · \^O read · \^M mute · \^H hints · \? help/,
  );
  first.setup.mockInput.pressKey('h', { ctrl: true });
  await first.setup.renderOnce();
  assert.equal(hints.visible, false);
  assert.ok(history.viewport.height >= height + 1, 'hiding hints should enlarge the conversation viewport');
  assert.equal(loadHintsVisible(hintsFile), false);
  assert.equal(fs.statSync(hintsFile).mode & 0o777, 0o600);
  first.app.dispose();
  first.setup.renderer.destroy();
  const second = await makeApp();
  t.after(() => {
    second.app.dispose();
    second.setup.renderer.destroy();
  });
  const restoredHints = second.setup.renderer.root.findDescendantById('line-hints');
  assert.equal(restoredHints.visible, false);
  second.setup.mockInput.pressKey('h', { ctrl: true });
  await second.setup.renderOnce();
  assert.equal(restoredHints.visible, true);
  assert.equal(loadHintsVisible(hintsFile), true);
  second.setup.mockInput.pressKey('i');
  second.setup.mockInput.pressKey('h', { ctrl: true });
  assert.equal(restoredHints.visible, true, 'Ctrl+H must not toggle hints in insert mode');
  second.setup.mockInput.pressKey('?');
  assert.equal(second.setup.renderer.root.findDescendantById('line-keybind-help').visible, false);
  assert.match(second.app.input.value, /\?$/, '? should remain ordinary text in insert mode');
});

test('keybind help scrolls with Vim and page keys without changing conversation state', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 80, height: 16, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', {
    mode: 'demo',
    selectedId: 'chat',
    session: 'session',
    chats: [],
    messages: Array.from({ length: 25 }, (_, i) => ({ id: String(i + 1), text: `Message ${i + 1}` })),
    draft: 'Unsent draft',
  });
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  const history = setup.renderer.root.findDescendantById('line-history');
  history.scrollTo(0);
  await setup.renderOnce();
  const top = history.scrollTop;
  const draft = app.input.value;
  setup.mockInput.pressKey('?');
  await setup.renderOnce();
  const help = setup.renderer.root.findDescendantById('line-keybind-help');
  const scroll = setup.renderer.root.findDescendantById('line-keybind-scroll');
  assert.equal(help.visible, true);
  assert.match(setup.captureCharFrame(), /NAVIGATION/);
  setup.mockInput.pressKey('j');
  assert.ok(scroll.scrollTop > 0);
  setup.mockInput.pressKey('f', { ctrl: true });
  assert.ok(scroll.scrollTop > 1);
  setup.mockInput.pressKey('b', { ctrl: true });
  setup.mockInput.pressKey('d', { ctrl: true });
  setup.mockInput.pressKey('u', { ctrl: true });
  setup.mockInput.pressKey('pagedown');
  setup.mockInput.pressKey('pageup');
  setup.mockInput.pressKey('down');
  setup.mockInput.pressKey('up');
  setup.mockInput.pressKey('k');
  setup.mockInput.pressEscape();
  assert.equal(help.visible, false);
  assert.equal(history.scrollTop, top);
  assert.equal(app.input.value, draft);
  assert.equal(commands.length, 0);
  setup.mockInput.pressKey('?');
  assert.equal(help.visible, true);
  setup.mockInput.pressKey('?');
  assert.equal(help.visible, false);
});

test('j reveals the complete last message', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 20 });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', {
    chats: [],
    selectedId: 'chat',
    messages: Array.from({ length: 20 }, (_, index) => ({
      id: String(index),
      text:
        index === 19
          ? `Last message\n${Array.from({ length: 30 }, (_, line) => `Long line ${line}`).join('\n')}\nFinal line`
          : `Message ${index}`,
    })),
  });
  await setup.renderOnce();
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Final line/);
  setup.mockInput.pressKey('h');
  setup.mockInput.pressKey('l');
  await setup.mockInput.pressKeys(['g', 'g']);
  await setup.renderOnce();
  assert.doesNotMatch(setup.captureCharFrame(), /Final line/);
  setup.mockInput.pressKey('h');
  setup.mockInput.pressKey('l');
  await setup.renderOnce();
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Final line/);
  assert.match(setup.captureCharFrame(), /SCROLL \[20\/20\]/);
  setup.mockInput.pressEnter();
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Final line/);
  await setup.mockInput.pressKeys(['g', 'g']);
  await setup.renderOnce();
  for (let index = 0; index < 100; index++) {
    setup.mockInput.pressKey('j');
    await setup.renderOnce();
  }
  assert.match(setup.captureCharFrame(), /Final line/);
});

test('LINE UI renders history, composes, and preserves unacknowledged drafts', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 30 });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const view = {
    mode: 'demo',
    statusText: 'Ready',
    chats: [{ id: 'demo-0', name: 'Alice', preview: 'Hello', unread: 2 }],
    messages: [{ id: '1', sender: 'Alice', text: 'Hello from LINE', time: '12:00' }],
    selectedId: 'demo-0',
    session: 'session',
    selection: 1,
    draft: '',
    account: { name: 'Me' },
  };
  backend.emit('state', view);
  await setup.renderOnce();
  const frame = setup.captureCharFrame();
  assert.match(frame, /Alice/);
  assert.match(frame, /Hello from LINE/);
  setup.mockInput.pressKey('i');
  assert.equal(app.input.value, '');
  app.input.value = 'My draft';
  backend.emit('state', { ...view, watching: true });
  assert.equal(app.input.value, 'My draft');
  setup.mockInput.pressEnter();
  assert.equal(commands.at(-1).action, 'send');
  assert.equal(commands.at(-2).action, 'draft');
  assert.equal(commands.at(-1).text, 'My draft');
  backend.emit('state', { ...view, draftAck: 1 });
  assert.equal(app.input.value, '');
  backend.emit('state', {
    ...view,
    login: {
      active: true,
      statusText: 'Confirm on your phone',
      pin: '123456',
      canConfirm: true,
      attempt: 'login-1',
    },
  });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /123456/);
  setup.mockInput.pressKey('y', { ctrl: true });
  assert.deepEqual(commands.at(-1), { action: 'login-confirm', attempt: 'login-1' });
  backend.emit('failure', 'Disconnected');
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Disconnected/);
});

test('LINE protocol rejects malformed frames and strips terminal controls', () => {
  const backend = Object.create(Backend.prototype);
  EventEmitter.call(backend);
  backend.buffer = '';
  let failure;
  backend.fail = (message) => {
    failure = message;
  };
  backend.consume('{"type":"state",');
  assert.equal(failure, undefined);
  backend.consume('"view":{}}\n');
  assert.match(failure, /Invalid/);
  assert.equal(clean('hello\x1b[2J\x07'), 'hello[2J');
});

test('chat navigation keeps wrapped rows and their marker visible throughout the list', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 90, height: 20 });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const chats = Array.from({ length: 60 }, (_, index) => ({
    id: `chat-${index}`,
    name: `Chat ${index} 永慶房屋團隊 很長的群組名稱`,
    preview: 'A preview that wraps over multiple lines in a narrow terminal',
  }));
  backend.emit('state', { chats, messages: [], selectedId: chats[0].id, session: 'test' });
  await setup.renderOnce();
  const assertSelectedVisible = (index) => {
    const frame = setup.captureCharFrame();
    assert.match(frame, new RegExp(`› Chat ${index} `));
    assert.equal((frame.match(/›/g) || []).length, 1);
  };
  assertSelectedVisible(0);
  for (let index = 1; index < chats.length; index++) {
    setup.mockInput.pressKey('j');
    await setup.renderOnce();
    assertSelectedVisible(index);
  }
  setup.resize(65, 16);
  await setup.renderOnce();
  await setup.renderOnce();
  assertSelectedVisible(59);
  for (let index = 58; index >= 0; index--) {
    setup.mockInput.pressKey('k');
    await setup.renderOnce();
    assertSelectedVisible(index);
  }
});

test('l/L opens one hyperlink and provides a keyboard picker for multiple links', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 30 });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const opened = [];
  const app = await createApp(setup.renderer, backend, { openLink: (url) => opened.push(url) });
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const view = { chats: [], messages: [{ text: 'Visit https://example.com.' }], selectedId: 'test' };
  backend.emit('state', view);
  setup.mockInput.pressEnter();
  setup.mockInput.pressKey('L');
  assert.deepEqual(opened, ['https://example.com']);
  backend.emit('state', { ...view, messages: [{ text: 'https://example.com https://example.org' }] });
  setup.mockInput.pressKey('L');
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Open link/);
  setup.mockInput.pressKey('J');
  setup.mockInput.pressKey('K');
  setup.mockInput.pressKey('J');
  setup.mockInput.pressKey('L');
  assert.equal(opened.at(-1), 'https://example.org');
  setup.mockInput.pressKey('L');
  setup.mockInput.pressEscape();
  assert.equal(opened.length, 2);
});

test('conversation focus starts in scroll mode and Escape restores Vim scrolling from insert', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 24, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', {
    chats: [
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
    ],
    messages: Array.from({ length: 70 }, (_, i) => ({ id: String(i), text: `Message ${i}` })),
    selectedId: 'alice',
    session: 'test',
  });
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /SCROLL/);
  const history = setup.renderer.root.findDescendantById('line-history');
  const selected = () => {
    const marked = Array.from({ length: 70 }, (_, index) =>
      setup.renderer.root.findDescendantById(`line-message-${index}`),
    ).find(
      (row) =>
        row
          .getChildren()[0]
          .chunks.map((chunk) => chunk.text)
          .join('') === '›',
    );
    return Number(marked.id.split('-').at(-1));
  };
  assert.equal(selected(), 69);
  setup.mockInput.pressKey('k');
  assert.equal(selected(), 68);
  setup.mockInput.pressKey('j');
  assert.equal(selected(), 69);
  setup.mockInput.pressKey('u', { ctrl: true });
  assert.ok(selected() < 69);
  const halfPageTarget = selected();
  setup.mockInput.pressKey('d', { ctrl: true });
  assert.ok(selected() > halfPageTarget);
  assert.equal(commands.filter((command) => command.action === 'select').length, 0);
  const beforeInsert = selected();
  const beforeScroll = history.scrollTop;
  setup.mockInput.pressKey('i');
  await setup.mockInput.typeText('jk');
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /INSERT/);
  assert.equal(app.input.value, 'jk');
  assert.equal(history.scrollTop, beforeScroll);
  setup.mockInput.pressEscape();
  setup.mockInput.pressKey('k');
  assert.equal(selected(), beforeInsert - 1);
  assert.equal(app.input.value, 'jk');
  setup.mockInput.pressTab();
  setup.mockInput.pressKey('j');
  assert.deepEqual(commands.at(-1), { action: 'select', id: 'bob' });
  setup.mockInput.pressTab();
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /SCROLL/);
});

test('message cursor scopes l/L and sent ticks change only with a read receipt', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const opened = [];
  const app = await createApp(setup.renderer, backend, { openLink: (url) => opened.push(url) });
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const view = {
    status: 'ready',
    selectedId: 'chat',
    session: 'test',
    chats: [],
    messages: [
      { id: '1', own: true, status: 'ok', text: 'https://first.example' },
      { id: '2', sender: 'Alice', text: 'https://second.example' },
    ],
  };
  backend.emit('state', view);
  setup.mockInput.pressEnter();
  setup.mockInput.pressKey('k');
  setup.mockInput.pressKey('L');
  assert.deepEqual(opened, ['https://first.example']);
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /You ✓/);
  assert.doesNotMatch(setup.captureCharFrame(), /✓✓/);
  backend.emit('state', { ...view, messages: [{ ...view.messages[0], read: true }, view.messages[1]] });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /You ✓✓/);
  setup.mockInput.pressKey('L');
  assert.equal(opened.at(-1), 'https://first.example');
});

test('selected photos and supplied stickers load as native terminal images; stale previews are ignored', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 35, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const png = [
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1Pe',
    'AAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  ].join('');
  const view = {
    status: 'ready',
    selectedId: 'chat',
    session: 'test',
    selection: 1,
    chats: [],
    messages: [
      { id: '1', text: '[Sticker]', sticker: { id: '123', hash: 'abc' } },
      { id: '2', text: '[Image]', contentType: 1, downloadable: true },
    ],
    stickerImages: { '123-abc': png },
  };
  backend.emit('state', view);
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  assert.deepEqual(commands.at(-1), { action: 'preview', id: 'chat', session: 'test', selection: 1, messageId: '2' });
  backend.emit('state', { ...view, preview: png, previewMessageId: '2' });
  const photo = setup.renderer.root.findDescendantById('line-image-1');
  const sticker = setup.renderer.root.findDescendantById('line-image-0');
  await Promise.all([photo.loadPromise, sticker.loadPromise]);
  assert.equal(photo.visible, true);
  assert.equal(sticker.visible, true);
  assert.ok(photo.image, String(photo.loadError));
  assert.ok(sticker.image, String(sticker.loadError));
  await setup.renderOnce();
  backend.emit('state', { ...view, selectedId: 'other', preview: png, previewMessageId: '2' });
  const stalePhoto = setup.renderer.root.findDescendantById('line-image-1');
  assert.equal(stalePhoto.visible, false);
});

test('automatic image previews follow the viewport and Ctrl+P switches to selected-only', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 20, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const view = {
    mode: 'live',
    status: 'ready',
    account: { id: 'account', name: 'Me' },
    selectedId: 'chat',
    session: 'session',
    selection: 1,
    autoImages: true,
    chats: [],
    messages: Array.from({ length: 30 }, (_, i) => ({
      id: String(i + 1),
      text: `Photo ${i + 1}`,
      contentType: 1,
      downloadable: true,
    })),
  };
  backend.emit('state', view);
  await setup.renderOnce();
  const initial = commands.filter(({ action }) => action === 'photos-visible').at(-1)?.messageIds;
  assert.ok(initial?.length > 0 && initial.length <= 8, 'only visible images should be requested');
  const history = setup.renderer.root.findDescendantById('line-history');
  history.scrollTo(0);
  await setup.renderOnce();
  const older = commands.filter(({ action }) => action === 'photos-visible').at(-1)?.messageIds;
  assert.ok(older?.length > 0 && older.length <= 8);
  assert.notDeepEqual(older, initial, 'scrolling should request the new viewport');
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1Pe' +
    'AAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const thumbnail = { [older[0]]: { status: 'ready', data: png } };
  backend.emit('state', { ...view, photoThumbnails: thumbnail });
  const photo = setup.renderer.root.findDescendantById(`line-image-${Number(older[0]) - 1}`);
  assert.equal(photo.visible, true, 'a cached thumbnail should display without hovering');
  setup.mockInput.pressEnter();
  assert.equal(commands.filter(({ action }) => action === 'preview').length, 0);
  setup.mockInput.pressKey('p', { ctrl: true });
  assert.deepEqual(
    commands.slice(-2).map(({ action }) => action),
    ['auto-images', 'photos-hide'],
  );
  backend.emit('state', { ...view, autoImages: false, photoThumbnails: thumbnail });
  await setup.renderOnce();
  assert.equal(photo.visible, false);
  const before = commands.filter(({ action }) => action === 'photos-visible').length;
  history.scrollTo(history.scrollHeight);
  await setup.renderOnce();
  assert.equal(commands.filter(({ action }) => action === 'photos-visible').length, before);
  setup.mockInput.pressKey('p', { ctrl: true });
  assert.equal(commands.at(-1).action, 'auto-images');
  backend.emit('state', view);
  await setup.renderOnce();
  assert.ok(commands.filter(({ action }) => action === 'photos-visible').length > before);
});

test('full-page and half-page scrolling work inside a single long message', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 80, height: 20, kittyKeyboard: true });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', {
    chats: [],
    selectedId: 'chat',
    messages: [{ id: '1', text: Array.from({ length: 60 }, (_, index) => `Line ${index}`).join('\n') }],
  });
  await setup.renderOnce();
  setup.mockInput.pressEnter();
  const history = setup.renderer.root.findDescendantById('line-history');
  history.scrollTo(0);
  const fullPage = history.viewport.height;
  const halfPage = Math.max(1, Math.floor(fullPage / 2));
  setup.mockInput.pressKey('d', { ctrl: true });
  assert.equal(history.scrollTop, halfPage);
  setup.mockInput.pressKey('u', { ctrl: true });
  assert.equal(history.scrollTop, 0);
  setup.mockInput.pressKey('f', { ctrl: true });
  assert.equal(history.scrollTop, fullPage);
  setup.mockInput.pressKey('b', { ctrl: true });
  assert.equal(history.scrollTop, 0);
  setup.mockInput.pressKey('u', { ctrl: true });
  assert.equal(history.scrollTop, 0);
  setup.mockInput.pressKey('b', { ctrl: true });
  assert.equal(history.scrollTop, 0);
});

test('large chat lists survive repeated backend frames without exhausting native text resources', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 120, height: 35 });
  const backend = Object.create(Backend.prototype);
  EventEmitter.call(backend);
  backend.mode = 'live';
  backend.buffer = '';
  backend.command = () => {};
  backend.close = () => {};
  backend.fail = (message) => assert.fail(message);
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const chats = Array.from({ length: 1141 }, (_, index) => ({
    id: `chat-${index}`,
    name: `Chat ${index} 女主微`,
    preview: 'Open chat',
  }));
  for (let update = 0; update < 10; update++) {
    const frame = `${JSON.stringify({
      type: 'state',
      view: {
        mode: 'live',
        status: 'ready',
        selectedId: 'chat-0',
        session: 'test',
        chats: chats.map((chat, index) => ({ ...chat, unread: index === 0 ? update : 0 })),
        messages: [{ id: '1', text: `Message update ${update}` }],
      },
    })}\n`;
    // Include fragmented frames as seen with large real account snapshots.
    backend.consume(frame.slice(0, 70000));
    backend.consume(frame.slice(70000));
    await setup.renderOnce();
    assert.match(setup.captureCharFrame(), new RegExp(`Message update ${update}`));
    assert.match(setup.captureCharFrame(), /Chats \(1141\)/);
  }
});

test('a UI listener exception is never misreported as invalid backend JSON', () => {
  const backend = Object.create(Backend.prototype);
  EventEmitter.call(backend);
  backend.mode = 'live';
  backend.buffer = '';
  backend.fail = (message) => assert.fail(message);
  backend.on('state', () => {
    throw new Error('UI rendering failed');
  });
  assert.throws(
    () =>
      backend.consume(
        `${JSON.stringify({
          type: 'state',
          view: {
            mode: 'live',
            chats: [],
            messages: [],
          },
        })}\n`,
      ),
    /UI rendering failed/,
  );
});

test('gg and G jump to list boundaries without interfering with l/L or insert mode', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 25, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const opened = [];
  const app = await createApp(setup.renderer, backend, { openLink: (url) => opened.push(url) });
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', {
    chats: Array.from({ length: 30 }, (_, index) => ({ id: `chat-${index}`, name: `Chat ${index}` })),
    messages: Array.from({ length: 50 }, (_, index) => ({
      id: String(index),
      text: `Message ${index} https://example.com/${index}`,
    })),
    selectedId: 'chat-0',
    session: 'test',
  });
  await setup.renderOnce();
  setup.mockInput.pressKey('g', { shift: true });
  assert.deepEqual(commands.at(-1), { action: 'select', id: 'chat-29' });
  await setup.mockInput.pressKeys(['g', 'g']);
  assert.deepEqual(commands.at(-1), { action: 'select', id: 'chat-0' });
  setup.mockInput.pressEnter();
  await setup.mockInput.pressKeys(['g', 'g']);
  const history = setup.renderer.root.findDescendantById('line-history');
  assert.equal(history.scrollTop, 0);
  setup.mockInput.pressKey('L');
  assert.equal(opened.at(-1), 'https://example.com/0');
  setup.mockInput.pressKey('g', { shift: true });
  assert.equal(history.scrollTop, Math.max(0, history.scrollHeight - history.viewport.height));
  setup.mockInput.pressKey('L');
  assert.equal(opened.at(-1), 'https://example.com/49');
  setup.mockInput.pressKey('i');
  await setup.mockInput.typeText('ggG');
  assert.equal(app.input.value, 'ggG');
});

test('h leaves conversation focus and l enters scroll mode while insert mode keeps both as text', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 110, height: 25, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', {
    chats: [
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
    ],
    messages: [
      { id: '1', text: 'First' },
      { id: '2', text: 'Second' },
    ],
    selectedId: 'alice',
    session: 'test',
  });
  await setup.renderOnce();
  setup.mockInput.pressKey('L');
  setup.mockInput.pressKey('K');
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /SCROLL/);
  assert.equal(commands.length, 0);
  setup.mockInput.pressKey('H');
  setup.mockInput.pressKey('J');
  assert.deepEqual(commands.at(-1), { action: 'select', id: 'bob' });
  setup.mockInput.pressKey('L');
  setup.mockInput.pressKey('i');
  await setup.mockInput.typeText('hlJKHL');
  assert.equal(app.input.value, 'hlJKHL');
  setup.mockInput.pressEscape();
  setup.mockInput.pressKey('H');
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /CHATS/);
  setup.mockInput.pressKey('l', { ctrl: true });
  assert.equal(commands.at(-1).action, 'login');
});

test('l expands the selected image and h or Escape restores the conversation', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const png = [
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1Pe',
    'AAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  ].join('');
  const view = {
    chats: [{ id: 'chat', name: 'Alice' }],
    selectedId: 'chat',
    session: 'test',
    selection: 1,
    status: 'ready',
    messages: [
      ...Array.from({ length: 20 }, (_, index) => ({ id: String(index), text: `Message ${index}` })),
      { id: '123', text: '[Image]', contentType: 1, downloadable: true },
    ],
    draft: 'saved draft',
  };
  backend.emit('state', view);
  await setup.renderOnce();
  setup.mockInput.pressKey('l');
  const history = setup.renderer.root.findDescendantById('line-history');
  setup.mockInput.pressKey('l');
  await setup.renderOnce();
  const overlay = setup.renderer.root.findDescendantById('line-expanded-view');
  const image = setup.renderer.root.findDescendantById('line-expanded-image');
  assert.equal(overlay.visible, true);
  assert.match(setup.captureCharFrame(), /Loading image/);
  backend.emit('state', { ...view, preview: png, previewMessageId: '123' });
  await image.loadPromise;
  await setup.renderOnce();
  await setup.renderOnce();
  const imageScroll = setup.renderer.root.findDescendantById('line-expanded-scroll');
  assert.ok(image.image);
  assert.equal(image.height, imageScroll.viewport.height);
  assert.match(setup.captureCharFrame(), /Full height/);
  setup.mockInput.pressKey('l');
  await setup.renderOnce();
  await setup.renderOnce();
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Full width/);
  assert.ok(
    setup.captureSpans().lines[image.y + 2].spans.some((span) => span.bg.r > 0.9 && span.bg.g < 0.1),
    'expanded image pixels must be visible near the top of the pane',
  );
  assert.equal(image.width, imageScroll.viewport.width);
  assert.equal(image.height, Math.ceil(image.width / image.cellAspectRatio));
  assert.ok(image.height > imageScroll.viewport.height);
  const historyTop = history.scrollTop;
  setup.mockInput.pressKey('j');
  await setup.renderOnce();
  assert.equal(imageScroll.scrollTop, 1);
  setup.mockInput.pressKey('k');
  await setup.renderOnce();
  assert.equal(imageScroll.scrollTop, 0);
  assert.equal(history.scrollTop, historyTop);
  assert.ok(image.width >= history.viewport.width);
  assert.ok(image.height >= history.viewport.height - 1);
  setup.resize(85, 24);
  await setup.renderOnce();
  await setup.renderOnce();
  assert.equal(image.height, Math.ceil(image.width / image.cellAspectRatio));
  assert.ok(image.width >= history.viewport.width);
  assert.ok(image.height >= history.viewport.height - 1);
  const scrollTop = history.scrollTop;
  setup.mockInput.pressKey('i');
  assert.equal(app.input.value, 'saved draft');
  setup.mockInput.pressKey('h');
  await setup.renderOnce();
  assert.equal(overlay.visible, false);
  assert.equal(image.source, undefined);
  assert.equal(app.input.value, 'saved draft');
  assert.equal(history.scrollTop, scrollTop);
  assert.match(setup.captureCharFrame(), /SCROLL/);
  setup.mockInput.pressKey('l');
  assert.equal(overlay.visible, true);
  await setup.renderOnce();
  await setup.renderOnce();
  assert.equal(image.height, imageScroll.viewport.height);
  setup.mockInput.pressEscape();
  assert.equal(overlay.visible, false);
  setup.mockInput.pressEnter();
  assert.equal(overlay.visible, false);
  setup.mockInput.pressKey('l');
  assert.equal(overlay.visible, true);
  backend.emit('state', { ...view, selectedId: 'other' });
  assert.equal(overlay.visible, false);
});

test('LINE input stays inside the message border after resizing', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 25 });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  for (const width of [100, 65, 150]) {
    setup.resize(width, 25);
    app.input.focus();
    app.input.value = 'A long message '.repeat(30);
    await setup.renderOnce();
    await setup.renderOnce();
    const pane = app.input.parent;
    assert.equal(app.input.x, pane.x + 1);
    assert.equal(app.input.x + app.input.width, pane.x + pane.width - 1);
    assert.equal(setup.captureCharFrame().split('\n')[app.input.y][pane.x + pane.width - 1], '│');
  }
});

test('Escape from insert preserves the viewport when selection is off screen', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 25, kittyKeyboard: true });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', {
    chats: [{ id: 'chat', name: 'Alice' }],
    selectedId: 'chat',
    messages: Array.from({ length: 50 }, (_, index) => ({ id: String(index), text: `Message ${index}` })),
  });
  await setup.renderOnce();
  setup.mockInput.pressKey('l');
  setup.mockInput.pressKey('g');
  setup.mockInput.pressKey('g');
  await setup.renderOnce();
  const history = setup.renderer.root.findDescendantById('line-history');
  history.scrollTo(history.scrollHeight);
  await setup.renderOnce();
  const scrollTop = history.scrollTop;
  assert.ok(scrollTop > 0);
  setup.mockInput.pressKey('i');
  await setup.mockInput.typeText('draft');
  setup.mockInput.pressEscape();
  await setup.renderOnce();
  assert.equal(history.scrollTop, scrollTop);
  assert.equal(app.input.value, 'draft');
  assert.match(setup.captureCharFrame(), /SCROLL \[1\/50\]/);
});

test('l plays video inside the pane with pause, seek, and return controls', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 25, kittyKeyboard: true });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const calls = [];
  let finish;
  const app = await createApp(setup.renderer, backend, {
    playVideo: (...args) => {
      calls.push(args);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', {
    chats: [{ id: 'chat', name: 'Alice' }],
    selectedId: 'chat',
    session: 'session',
    selection: 1,
    status: 'ready',
    draft: 'saved draft',
    messages: [{ id: '123', contentType: 2, text: '[Video]', downloadable: true }],
  });
  await setup.renderOnce();
  setup.mockInput.pressKey('l');
  setup.mockInput.pressKey('l');
  setup.mockInput.pressKey('l');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][2], { id: 'chat', session: 'session', selection: 1 });
  assert.equal(calls[0][3], '123');
  assert.equal(app.input.value, 'saved draft');
  const controls = [];
  calls[0][4].onProgress({ received: 5 * 1048576, total: 10 * 1048576, stage: 'downloading' });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /50%/);
  assert.match(setup.captureCharFrame(), /5\.0 MiB \/ 10\.0 MiB/);
  calls[0][4].onProgress({ received: 1048576, total: -1, stage: 'downloading' });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /size unknown/);
  calls[0][4].onProgress({ stage: 'preparing' });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Preparing video/);
  calls[0][4].onReady({ togglePause: () => controls.push('pause'), seek: (seconds) => controls.push(seconds) });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64',
  );
  calls[0][4].onFrame(png);
  const videoImage = setup.renderer.root.findDescendantById('line-video-image');
  await videoImage.loadPromise;
  await setup.renderOnce();
  const videoView = setup.renderer.root.findDescendantById('line-video-view');
  assert.equal(videoView.visible, true);
  assert.ok(videoImage.x >= videoView.x);
  assert.ok(videoImage.x + videoImage.width <= videoView.x + videoView.width);
  assert.match(setup.captureCharFrame(), /Alice/);
  assert.ok(setup.captureSpans().lines.some((line) => line.spans.some((span) => span.bg.r > 0.9 && span.bg.g < 0.1)));
  setup.mockInput.pressKey(' ');
  setup.mockInput.pressArrow('left');
  setup.mockInput.pressArrow('right');
  assert.deepEqual(controls, ['pause', -5, 5]);
  finish();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  assert.equal(videoView.visible, false);
  assert.equal(videoImage.source, undefined);
  setup.mockInput.pressKey('l');
  assert.equal(calls.length, 2);
  setup.mockInput.pressEscape();
  assert.equal(calls[1][4].signal.aborted, true);
  finish();
});

test('history starts at newest after delayed load and r replies to the highlighted LINE message', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const base = { chats: [], messages: [], selectedId: 'chat', session: 'test', selection: 1 };
  backend.emit('state', base);
  const messages = ['100', '101', '102'].map((id) => ({ id, sender: 'Alice', text: `Message ${id}` }));
  backend.emit('state', { ...base, messages });
  setup.mockInput.pressKey('i');
  setup.mockInput.pressEscape();
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /SCROLL \[3\/3\]/);
  setup.mockInput.pressKey('k');
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /SCROLL \[2\/3\]/);
  setup.mockInput.pressKey('r');
  assert.deepEqual(commands.at(-1), {
    action: 'reply',
    id: 'chat',
    session: 'test',
    selection: 1,
    messageId: '101',
  });
  backend.emit('state', { ...base, messages, reply: { id: '101', sender: 'Alice', text: 'Message 101' } });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Reply to Alice: Message 101/);
  assert.match(setup.captureCharFrame(), /INSERT/);
  app.input.value = 'A reply';
  setup.mockInput.pressEnter();
  assert.equal(commands.at(-1).action, 'send');
  assert.equal(commands.at(-1).text, 'A reply');
  assert.equal(commands.at(-1).replyTo, '101');
  setup.mockInput.pressEscape();
  setup.mockInput.pressEscape();
  assert.equal(commands.at(-1).action, 'reply-cancel');
});

test('r and Enter send a native reply through the bundled LINE demo backend', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const backend = new Backend(resolveBackend(), 'demo');
  t.after(() => {
    backend.close();
    setup.renderer.destroy();
  });
  const wait = (predicate) =>
    new Promise((resolve, reject) => {
      const listener = (view) => {
        if (!predicate(view)) return;
        // eslint-disable-next-line no-use-before-define
        clearTimeout(timer);
        backend.off('state', listener);
        resolve(view);
      };
      const timer = setTimeout(() => {
        backend.off('state', listener);
        reject(new Error('Reply was not sent by the LINE demo backend'));
      }, 5000);
      backend.on('state', listener);
    });
  const ready = await wait((view) => view.status === 'ready' && view.messages.length);
  const app = await createApp(setup.renderer, backend);
  t.after(() => app.dispose());
  backend.emit('state', ready);
  setup.mockInput.pressKey('l');
  const target = ready.messages.at(-1).id;
  const replying = wait((view) => view.reply?.id === target);
  setup.mockInput.pressKey('r');
  await replying;
  app.input.value = 'Native reply regression test';
  const sent = wait((view) => view.messages.some((message) => message.text === 'Native reply regression test'));
  setup.mockInput.pressEnter();
  const result = await sent;
  assert.equal(result.messages.find((message) => message.text === 'Native reply regression test').replyTo, target);
  assert.equal(result.sendStatus, 'idle');
  assert.equal(result.draft, '');
  assert.equal(result.reply, null);
});

test('reply pairs stay highlighted after sending, navigation, and sidebar focus', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const base = { chats: [], selectedId: 'chat', session: 'test', selection: 1 };
  const messages = [
    { id: '100', sender: 'Alice', text: 'Original' },
    { id: '101', sender: 'Alice', text: 'Unrelated' },
  ];
  backend.emit('state', { ...base, messages });
  setup.mockInput.pressKey('l');
  setup.mockInput.pressKey('k');
  setup.mockInput.pressKey('r');
  backend.emit('state', { ...base, messages, reply: { id: '100', sender: 'Alice', text: 'Original' } });
  const node = (index) => setup.renderer.root.findDescendantById(`line-message-${index}`);
  const marker = (index) => setup.renderer.root.findDescendantById(`line-message-marker-${index}`).plainText;
  assert.equal(marker(0), '↪');
  // Follow the newest message, as after sending from the bottom of a conversation.
  setup.mockInput.pressEscape();
  setup.mockInput.pressKey('G');
  setup.mockInput.pressKey('i');
  backend.emit('state', {
    ...base,
    reply: null,
    messages: [...messages, { id: '102', own: true, text: 'The reply', replyTo: '100' }],
  });
  assert.equal(marker(0), '↪');
  assert.equal(marker(2), '↪');
  assert.deepEqual(node(0).backgroundColor, node(2).backgroundColor);
  assert.notDeepEqual(node(0).backgroundColor, node(1).backgroundColor);
  setup.mockInput.pressEscape();
  setup.mockInput.pressKey('k');
  assert.equal(marker(0), '↪');
  assert.equal(marker(2), '↪');
  assert.equal(marker(1), '›');
  setup.mockInput.pressKey('h');
  assert.equal(marker(0), '↪');
  assert.equal(marker(2), '↪');
  assert.deepEqual(node(0).backgroundColor, node(2).backgroundColor);
});

test('separate reply threads use different stable colors and nested replies keep their thread color', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const state = {
    chats: [],
    selectedId: 'chat',
    session: 'test',
    selection: 1,
    messages: [
      { id: '100', text: 'First original' },
      { id: '101', text: 'Second original' },
      { id: '102', text: 'First reply', replyTo: '100' },
      { id: '103', text: 'Second reply', replyTo: '101' },
      { id: '104', text: 'Nested reply', replyTo: '102' },
    ],
  };
  backend.emit('state', state);
  const color = (index) => setup.renderer.root.findDescendantById(`line-message-${index}`).backgroundColor;
  assert.deepEqual(color(0), color(2));
  assert.deepEqual(color(2), color(4));
  assert.deepEqual(color(1), color(3));
  assert.notDeepEqual(color(0), color(1));
  const originalColor = color(0);
  backend.emit('state', { ...state, messages: [{ id: '99', text: 'Earlier' }, ...state.messages] });
  assert.deepEqual(color(1), originalColor);
  assert.deepEqual(color(1), color(3));
});

test('Ctrl+L opens login from insert and sticker views, retries errors, and explains busy states', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const view = {
    mode: 'live',
    chats: [{ id: 'chat', name: 'Alice' }],
    messages: [],
    selectedId: 'chat',
    session: 'test',
    selection: 1,
    status: 'ready',
    draft: '',
    stickers: { status: 'ready', items: [], products: [] },
  };
  backend.emit('state', view);
  setup.mockInput.pressKey('i');
  setup.mockInput.pressKey('l', { ctrl: true });
  assert.equal(commands.at(-1).action, 'login');
  assert.match(commands.at(-1).request, /^ui-[a-z0-9]+$/);
  assert.ok(commands.at(-1).request.length <= 15);
  setup.mockInput.pressKey('s');
  assert.equal(setup.renderer.root.findDescendantById('line-sticker-picker').visible, true);
  setup.mockInput.pressKey('l', { ctrl: true });
  assert.equal(commands.at(-1).action, 'login');
  assert.equal(setup.renderer.root.findDescendantById('line-sticker-picker').visible, false);
  backend.emit('state', { ...view, login: { canRetry: true } });
  setup.mockInput.pressKey('l', { ctrl: true });
  assert.equal(commands.at(-1).action, 'login-retry');
  const count = commands.length;
  backend.emit('state', { ...view, busy: true });
  setup.mockInput.pressKey('l', { ctrl: true });
  await setup.renderOnce();
  assert.equal(commands.length, count);
  assert.match(setup.captureCharFrame(), /請稍候再按 Ctrl\+L/);
  backend.emit('state', { ...view, login: { active: true, canConfirm: true } });
  setup.mockInput.pressKey('l', { ctrl: true });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /Ctrl\+Y/);
  assert.equal(commands.length, count);
});

test('login outcome uncertainty stays visible after phone confirmation', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 110, height: 30, kittyKeyboard: true });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  backend.emit('state', {
    chats: [],
    messages: [],
    statusText: '請按 Ctrl+L 登入 LINE',
    login: { stage: 'uncertain', active: false, canRetry: false, statusText: 'LINE 已核准登入，但無法儲存登入資料。' },
  });
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /LINE 已核准登入/);
  assert.match(setup.captureCharFrame(), /Ctrl\+R 檢查/);
  assert.match(setup.captureCharFrame(), /Ctrl\+L 登入 LINE/);
});
