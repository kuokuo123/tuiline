'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createApp } = require('../line-tui/app');
const { editMentions } = require('../line-tui/mentions');

test('mention ranges follow edits and disappear when their text is changed', () => {
  const mention = { id: 'u-alice', start: 3, end: 9 };
  assert.deepEqual(editMentions('Hi @Alice!', 'Hello @Alice!', [mention]), [{ ...mention, start: 6, end: 12 }]);
  assert.deepEqual(editMentions('Hi @Alice!', 'Hi @Ali!', [mention]), []);
  assert.deepEqual(editMentions('Hi @Alice!', 'Hi @Alice! later', [mention]), [mention]);
});

test('@ opens group members, filters, inserts and sends native mentions without sending on picker Enter', async (t) => {
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
    chats: [{ id: 'group', name: 'Friends', group: true }],
    messages: [],
    selectedId: 'group',
    session: 'test',
    selection: 1,
    status: 'ready',
    draft: '',
    membersStatus: 'idle',
    members: [],
  };
  backend.emit('state', view);
  setup.mockInput.pressKey('i');
  await setup.mockInput.typeText('@');
  await setup.renderOnce();
  const popup = setup.renderer.root.findDescendantById('line-mention-picker');
  assert.equal(popup.visible, true);
  assert.equal(commands.at(-1).action, 'members');
  const loaded = {
    ...view,
    membersStatus: 'ready',
    members: [
      { id: 'u-alice', name: '小明' },
      { id: 'u-bob', name: 'Bob' },
    ],
  };
  backend.emit('state', loaded);
  await setup.renderOnce();
  assert.match(popup.plainText, /小明/);
  assert.match(popup.plainText, /Bob/);
  setup.mockInput.pressArrow('down');
  setup.mockInput.pressEnter();
  assert.equal(
    commands.some((command) => command.action === 'send'),
    false,
  );
  assert.equal(app.input.value, '@Bob ');
  await setup.mockInput.typeText('hello');
  setup.mockInput.pressEnter();
  assert.deepEqual(commands.at(-1), {
    action: 'send',
    id: 'group',
    session: 'test',
    selection: 1,
    text: '@Bob hello',
    replyTo: '',
    mentions: [{ id: 'u-bob', start: 0, end: 4 }],
  });
  // Editing inside a mention removes its native target instead of mentioning the wrong text.
  app.input.value = '@Rob hello';
  setup.mockInput.pressEnter();
  assert.equal(commands.at(-1).mentions, undefined);
});

test('mentions use UTF-16 ranges after Chinese and emoji text; private chats keep @ as text', async (t) => {
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
    chats: [{ id: 'group', name: 'Friends', group: true }],
    messages: [],
    draft: '',
    selectedId: 'group',
    session: 'test',
    selection: 1,
    status: 'ready',
    membersStatus: 'ready',
    members: [{ id: 'u-alice', name: '小明' }],
  };
  backend.emit('state', view);
  setup.mockInput.pressKey('i');
  app.input.insertText('你好😀 ');
  await setup.mockInput.typeText('@小');
  await setup.renderOnce();
  const popup = setup.renderer.root.findDescendantById('line-mention-picker');
  assert.equal(popup.visible, true);
  assert.match(popup.plainText, /小明/);
  setup.mockInput.pressEnter();
  assert.equal(app.input.value, '你好😀 @小明 ');
  await setup.mockInput.typeText('hi');
  assert.equal(app.input.value, '你好😀 @小明 hi');
  setup.mockInput.pressEnter();
  assert.deepEqual(commands.at(-1).mentions, [{ id: 'u-alice', start: 5, end: 8 }]);
  backend.emit('state', { ...view, chats: [{ id: 'direct', group: false }], selectedId: 'direct', selection: 2 });
  await setup.mockInput.typeText('@');
  assert.equal(popup.visible, false);
  setup.mockInput.pressEnter();
  assert.equal(commands.at(-1).mentions, undefined);
});

for (const prefix of ['\t', 'A\t', '第一行😀\n你好\t']) {
  test(`mention insertion respects tab-expanded cursor columns: ${JSON.stringify(prefix)}`, async (t) => {
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
    backend.emit('state', {
      chats: [{ id: 'group', name: 'Group', group: true }],
      messages: [],
      draft: '',
      selectedId: 'group',
      session: 'test',
      selection: 1,
      status: 'ready',
      membersStatus: 'ready',
      members: [{ id: 'u-alice', name: 'Alice' }],
    });
    setup.mockInput.pressKey('i');
    app.input.editBuffer.setTabWidth(4);
    app.input.value = `${prefix}@Al tail`;
    const { row, col } = app.input.logicalCursor;
    app.input.setCursor(row, col - 5);
    await setup.renderOnce();
    assert.equal(setup.renderer.root.findDescendantById('line-mention-picker').visible, true);
    setup.mockInput.pressEnter();
    await setup.mockInput.typeText('hello');
    assert.equal(app.input.value, `${prefix}@Alice hello tail`);
    setup.mockInput.pressEnter();
    const sent = commands.findLast((command) => command.action === 'send');
    assert.deepEqual(sent.mentions, [{ id: 'u-alice', start: prefix.length, end: prefix.length + 6 }]);
  });
}
