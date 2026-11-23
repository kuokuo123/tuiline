'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createApp } = require('../line-tui/app');

async function editor(t, { width = 120, height = 25, extra = {}, options = {} } = {}) {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width, height, kittyKeyboard: true });
  const backend = new EventEmitter();
  const commands = [];
  backend.command = (command) => commands.push(command);
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend, options);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const view = {
    mode: 'live',
    status: 'ready',
    statusText: '已連線',
    session: 'test',
    selection: 1,
    selectedId: 'chat',
    chats: [{ id: 'chat', name: 'Chat' }],
    messages: [],
    draft: '',
    ...extra,
  };
  backend.emit('state', view);
  setup.mockInput.pressKey('i');
  await setup.renderOnce();
  return { ...setup, app, backend, commands, view };
}

test('Shift+Enter edits multiple lines; Enter sends the entire draft once', async (t) => {
  const e = await editor(t);
  await e.mockInput.typeText('第一行');
  e.app.input.insertText('😀');
  e.mockInput.pressEnter({ shift: true });
  await e.mockInput.typeText('Second line');
  assert.equal(e.app.input.value, '第一行😀\nSecond line');
  assert.equal(e.commands.filter((command) => command.action === 'send').length, 0);
  await e.renderOnce();
  assert.equal(e.app.input.height, 2);
  e.backend.emit('state', { ...e.view, watching: true });
  assert.equal(e.app.input.value, '第一行😀\nSecond line', 'unacknowledged edits survive backend frames');
  e.mockInput.pressEnter();
  const sends = e.commands.filter((command) => command.action === 'send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].text, '第一行😀\nSecond line');
  const draft = e.commands.findLast((command) => command.action === 'draft');
  assert.equal(draft.text, sends[0].text);
  e.backend.emit('state', { ...e.view, draftAck: draft.sequence, draft: '' });
  await e.renderOnce();
  assert.equal(e.app.input.value, '');
  assert.equal(e.app.input.height, 1);
});

test('multiline paste, vertical editing, and undo preserve line breaks', async (t) => {
  const e = await editor(t);
  await e.mockInput.pasteBracketedText('one\r\ntwo\n\nthree');
  assert.equal(e.app.input.value, 'one\ntwo\n\nthree');
  e.app.input.setCursor(1, 0);
  await e.mockInput.typeText('X');
  assert.equal(e.app.input.value, 'one\nXtwo\n\nthree');
  e.mockInput.pressKey('z', { ctrl: true });
  assert.equal(e.app.input.value, 'one\ntwo\n\nthree');
  e.mockInput.pressKey('z', { ctrl: true, shift: true });
  assert.equal(e.app.input.value, 'one\nXtwo\n\nthree');
  // Arrow keys navigate the editor, not the conversation.
  e.app.input.setCursor(3, 0);
  e.mockInput.pressArrow('up');
  assert.equal(e.app.input.logicalCursor.row, 2);
  e.mockInput.pressEnter({ shift: true });
  assert.equal(e.commands.filter((command) => command.action === 'send').length, 0);
  assert.ok(e.app.input.value.includes('\n\n\n'));
});

test('composer grows to five rows, scrolls, and stays inside its pane after resize', async (t) => {
  const e = await editor(t);
  e.app.input.value = Array.from({ length: 8 }, (_, i) => `Line ${i}`).join('\n');
  for (const width of [120, 65, 150]) {
    e.resize(width, 25);
    await e.renderOnce();
    await e.renderOnce();
    assert.equal(e.app.input.height, 5);
    assert.ok(e.app.input.scrollY > 0);
    assert.equal(e.app.input.logicalCursor.row, 7);
    const pane = e.app.input.parent;
    assert.equal(e.app.input.x + e.app.input.width, pane.x + pane.width - 1);
    assert.ok(e.app.input.y + e.app.input.height <= pane.y + pane.height - 1);
  }
  e.app.input.value = 'short';
  await e.renderOnce();
  assert.equal(e.app.input.height, 1);
  e.app.input.value = 'wrapped message '.repeat(50);
  await e.renderOnce();
  assert.equal(e.app.input.height, 5);
});

test('composer enforces the UTF-16 length limit, including selection replacement', async (t) => {
  const e = await editor(t);
  e.app.input.value = `${'a'.repeat(9999)}😀`;
  assert.equal(e.app.input.value.length, 9999, 'truncation must not leave half an emoji');
  e.app.input.insertText('😀');
  assert.equal(e.app.input.value.length, 9999);
  e.mockInput.pressEnter({ shift: true });
  assert.equal(e.app.input.value.length, 10000);
  e.app.input.selectAll();
  await e.mockInput.pasteBracketedText('😀\nreplacement');
  assert.equal(e.app.input.value, '😀\nreplacement');
});

test('multiline drafts survive sidebar navigation and are restored for their own chat', async (t) => {
  const e = await editor(t, {
    extra: {
      chats: [
        { id: 'chat', name: 'First' },
        { id: 'other', name: 'Other' },
      ],
    },
  });
  const drafts = new Map([['other', 'Other\nsaved draft']]);
  let ack = 0;
  e.backend.command = (command) => {
    e.commands.push(command);
    if (command.action === 'draft') {
      drafts.set(command.id, command.text);
      ack = command.sequence;
    }
    if (command.action === 'select') {
      e.backend.emit('state', {
        ...e.view,
        selectedId: command.id,
        selection: command.id === 'other' ? 2 : 3,
        draft: drafts.get(command.id) || '',
        draftAck: ack,
      });
    }
  };
  await e.mockInput.pasteBracketedText('First\nsaved draft');
  e.mockInput.pressEscape();
  e.mockInput.pressKey('h');
  e.mockInput.pressKey('j');
  assert.equal(e.app.input.value, 'Other\nsaved draft');
  e.mockInput.pressKey('k');
  assert.equal(e.app.input.value, 'First\nsaved draft');
  e.mockInput.pressKey('i');
  e.mockInput.pressEnter({ shift: true });
  await e.mockInput.typeText('continued');
  e.mockInput.pressEnter();
  assert.equal(e.commands.findLast((command) => command.action === 'send').text, 'First\nsaved draft\ncontinued');
});

test('mentions retain UTF-16 ranges after newlines and Shift+Enter does not choose a member', async (t) => {
  const e = await editor(t, {
    extra: {
      chats: [{ id: 'chat', name: 'Group', group: true }],
      membersStatus: 'ready',
      members: [{ id: 'ualice', name: '小明' }],
    },
  });
  const prefix = '第一行😀\n\n你好 ';
  e.app.input.value = prefix;
  await e.mockInput.typeText('@小');
  const popup = e.renderer.root.findDescendantById('line-mention-picker');
  assert.equal(popup.visible, true);
  e.mockInput.pressEnter();
  assert.equal(e.app.input.value, `${prefix}@小明 `);
  await e.mockInput.typeText('hello');
  e.mockInput.pressEnter();
  assert.deepEqual(e.commands.findLast((command) => command.action === 'send').mentions, [
    { id: 'ualice', start: prefix.length, end: prefix.length + 3 },
  ]);
  e.app.input.value = '@';
  assert.equal(popup.visible, true);
  const sent = e.commands.filter((command) => command.action === 'send').length;
  e.mockInput.pressEnter({ shift: true });
  assert.equal(e.app.input.value, '@\n');
  assert.equal(e.commands.filter((command) => command.action === 'send').length, sent);
  assert.equal(popup.visible, false);
});

test('upload progress and local notices share the connection row, including during replies', async (t) => {
  const picker = Promise.withResolvers();
  const e = await editor(t, { width: 180, options: { pickFiles: () => picker.promise } });
  const status = e.renderer.root.findDescendantById('line-status');
  e.mockInput.pressKey('i', { ctrl: true });
  await e.renderOnce();
  let row = e.captureCharFrame().split('\n')[status.y];
  assert.match(row, /已連線.*Choose PNG\/JPEG/);
  assert.equal(status.height, 1);
  e.backend.emit('state', { ...e.view, reply: { id: '1', sender: 'Alice', text: 'first\nsecond' } });
  await e.renderOnce();
  assert.equal(status.height, 2, 'only a genuine reply gets its separate banner');
  const rows = e.captureCharFrame().split('\n');
  assert.match(rows[status.y], /Reply to Alice/);
  assert.match(rows[status.y + 1], /已連線.*Choose PNG\/JPEG/);
  picker.resolve([]);
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  await e.renderOnce();
  row = e.captureCharFrame().split('\n')[status.y + 1];
  assert.match(row, /已連線.*Upload canceled/);
});
