'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { terminalTheme } = require('../line-tui/theme');
const { createApp } = require('../line-tui/app');

test('theme retains terminal defaults and ANSI slots rather than fixed RGB colors', async () => {
  const theme = await terminalTheme();
  assert.equal(theme.foreground.intent, 'default');
  assert.equal(theme.background.intent, 'default');
  assert.equal(theme.accent.intent, 'indexed');
  assert.equal(theme.accent.slot, 2);
  assert.equal(theme.selectionBackground.slot, 7);
  assert.equal(theme.selectionForeground.slot, 0);
  assert.equal(theme.messageSelectionBackground.slot, 4);
  assert.deepEqual(
    theme.replyPalette.map(([background, foreground]) => [background.slot, foreground.slot]),
    [
      [7, 15],
      [8, 15],
    ],
  );
  for (const pair of theme.replyPalette) {
    for (const color of pair) {
      assert.equal(color.intent, 'indexed');
      assert.ok(color.slot >= 0 && color.slot < 16);
    }
  }
});

test('UI keeps terminal color intent through focus, selections, overlays and reply threads', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true });
  const backend = new EventEmitter();
  backend.command = () => {};
  backend.close = () => {};
  const app = await createApp(setup.renderer, backend);
  t.after(() => {
    app.dispose();
    setup.renderer.destroy();
  });
  const node = (id) => setup.renderer.root.findDescendantById(id);
  const state = {
    selectedId: 'chat',
    session: 'test',
    selection: 1,
    status: 'ready',
    draft: 'draft',
    chats: [{ id: 'chat', name: 'Chat', group: true }],
    messages: [
      { id: '1', text: 'Original' },
      { id: '2', text: 'Reply', replyTo: '1' },
      { id: '3', text: 'Ordinary message' },
    ],
  };
  backend.emit('state', state);
  await setup.renderOnce();
  for (const id of ['line-expanded-view', 'line-video-view', 'line-sticker-picker']) {
    assert.equal(node(id).backgroundColor.intent, 'default');
  }
  const text = (index) => node(`line-message-${index}`).getChildren()[1].getChildren()[0];
  assert.equal(text(2).fg.intent, 'default');
  assert.equal(node('line-message-marker-2').fg.slot, 2);
  assert.equal(node('line-message-0').backgroundColor.intent, 'indexed');
  assert.deepEqual(node('line-message-0').backgroundColor, node('line-message-1').backgroundColor);
  assert.equal(text(0).fg.slot, 15);
  setup.mockInput.pressEnter();
  assert.equal(node('line-message-2').backgroundColor.slot, 4);
  assert.equal(text(2).fg.slot, 0);
  setup.mockInput.pressKey('i');
  assert.equal(app.input.textColor.intent, 'default');
  assert.equal(app.input.backgroundColor.intent, 'default');
  assert.equal(text(2).fg.intent, 'default');
  assert.equal(node('line-file-paths').textColor.intent, 'default');
  assert.equal(node('line-mention-picker').fg.slot, 0);
  assert.equal(node('line-mention-picker').bg.slot, 7);
  const history = node('line-history');
  assert.equal(history.verticalScrollBar.slider.backgroundColor.intent, 'default');
  assert.equal(history.verticalScrollBar.slider.foregroundColor.slot, 8);
  backend.emit('state', {
    ...state,
    messages: [
      ...state.messages,
      { id: '4', text: 'Second original' },
      { id: '5', text: 'Second reply', replyTo: '4' },
      { id: '6', text: 'Third original' },
      { id: '7', text: 'Third reply', replyTo: '6' },
      { id: '8', text: 'Nested reply', replyTo: '2' },
    ],
  });
  assert.deepEqual(
    [0, 3, 5].map((index) => node(`line-message-${index}`).backgroundColor.slot),
    [7, 8, 7],
  );
  assert.equal(node('line-message-7').backgroundColor.slot, 7);
  assert.equal(text(7).fg.slot, 15);
  setup.mockInput.pressEscape();
  setup.mockInput.pressKey('G');
  assert.equal(node('line-message-7').backgroundColor.slot, 7);
  assert.equal(text(7).fg.slot, 15);
});
