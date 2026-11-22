'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createApp } = require('../line-tui/app');
const { Backend, resolveBackend } = require('../line-tui/backend');

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

test('sticker picker previews hashed images, browses packs/pages, and sends only after confirmation', async (t) => {
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
  let view = {
    chats: [{ id: 'chat', name: 'Alice' }],
    selectedId: 'chat',
    session: 'session',
    selection: 1,
    status: 'ready',
    sendStatus: 'idle',
    messages: [],
    draft: '',
    stickerImages: { '1002-hash': png },
    stickers: {
      open: true,
      status: 'ready',
      packageId: '1',
      page: 0,
      pages: 2,
      products: [
        { id: '1', name: 'First pack' },
        { id: '2', name: 'Second pack' },
      ],
      items: [
        { id: '1001', packageId: '1' },
        { id: '1002', packageId: '1', hash: 'hash' },
      ],
    },
  };
  backend.emit('state', view);
  await setup.renderOnce();
  setup.mockInput.pressKey('s');
  assert.ok(commands.some((command) => command.action === 'sticker-open'));
  assert.equal(commands.at(-1).action, 'sticker-preview');
  setup.mockInput.pressKey('l');
  assert.equal(commands.at(-1).action, 'sticker-preview');
  assert.equal(commands.at(-1).stickerId, '1002');
  const previewRequests = commands.filter((command) => command.action === 'sticker-preview').length;
  setup.mockInput.pressKey('r');
  assert.equal(commands.filter((command) => command.action === 'sticker-preview').length, previewRequests + 1);
  const highlighted = setup.renderer.root.findDescendantById('line-sticker-cell-1');
  assert.equal(setup.renderer.root.findDescendantById('line-sticker-cell-0').borderColor.slot, 0);
  assert.equal(highlighted.borderColor.slot, 2);
  assert.equal(highlighted.backgroundColor.intent, 'indexed');
  assert.equal(highlighted.backgroundColor.slot, 4);
  const preview = setup.renderer.root.findDescendantById('line-sticker-preview-1');
  await preview.loadPromise;
  await setup.renderOnce();
  assert.equal(preview.source, png);
  assert.ok(setup.captureSpans().lines.some((line) => line.spans.some((span) => span.bg.r > 0.9 && span.bg.g < 0.1)));
  setup.mockInput.pressKey(']');
  assert.equal(commands.at(-1).packageId, '2');
  setup.mockInput.pressKey('n');
  assert.equal(commands.at(-1).page, 1);
  setup.mockInput.pressEnter();
  assert.equal(commands.at(-1).action, 'sticker-choose');
  assert.equal(commands.at(-1).stickerId, '1002');
  assert.equal(
    commands.some((command) => command.action === 'sticker-send'),
    false,
  );
  view = { ...view, stickers: { ...view.stickers, open: false, selected: view.stickers.items[1], items: [] } };
  backend.emit('state', view);
  setup.mockInput.pressEnter();
  assert.deepEqual(commands.at(-1), {
    action: 'sticker-send',
    id: 'chat',
    session: 'session',
    selection: 1,
    packageId: '1',
    stickerId: '1002',
    replyTo: '',
  });
  setup.mockInput.pressEnter();
  assert.equal(commands.filter((command) => command.action === 'sticker-send').length, 1);
  backend.emit('state', { ...view, stickers: { ...view.stickers, selected: null } });
  assert.equal(setup.renderer.root.findDescendantById('line-sticker-picker').visible, false);
});

test('sticker picker preserves drafts, supports cancel, and dismisses on chat changes', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 25, kittyKeyboard: true });
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
    chats: [{ id: 'chat', name: 'Alice' }],
    selectedId: 'chat',
    session: 'session',
    selection: 1,
    status: 'ready',
    sendStatus: 'idle',
    messages: [],
    draft: 'Keep this draft',
    stickers: { status: 'ready', selected: { id: '1001', packageId: '1' } },
  };
  backend.emit('state', view);
  await setup.renderOnce();
  setup.mockInput.pressKey('s');
  setup.mockInput.pressEnter();
  assert.equal(
    commands.some((command) => command.action === 'sticker-send'),
    false,
  );
  assert.equal(app.input.value, 'Keep this draft');
  setup.mockInput.pressEscape();
  assert.equal(commands.at(-1).action, 'sticker-close');
  const overlay = setup.renderer.root.findDescendantById('line-sticker-picker');
  assert.equal(overlay.visible, false);
  setup.mockInput.pressKey('s');
  backend.emit('state', { ...view, selectedId: 'other', selection: 2 });
  assert.equal(overlay.visible, false);
});

test('reference LINE demo backend loads owned stickers and sends a selected sticker', async (t) => {
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
      const timer = setTimeout(() => {
        // eslint-disable-next-line no-use-before-define
        backend.off('state', listener);
        reject(new Error('Sticker demo timeout'));
      }, 5000);
      const listener = (view) => {
        if (!predicate(view)) return;
        clearTimeout(timer);
        backend.off('state', listener);
        resolve(view);
      };
      backend.on('state', listener);
    });
  const ready = await wait((view) => view.status === 'ready' && view.selectedId);
  assert.equal(ready.statusText, '模擬對話 · 示範模式');
  const context = { id: ready.selectedId, session: ready.session, selection: ready.selection };
  const loaded = wait((view) => view.stickers?.status === 'ready' && view.stickers.items.length);
  backend.command({ action: 'sticker-open', ...context });
  const catalog = await loaded;
  const sticker = catalog.stickers.items[0];
  const chosen = wait((view) => view.stickers?.selected?.id === sticker.id);
  backend.command({ action: 'sticker-choose', ...context, packageId: sticker.packageId, stickerId: sticker.id });
  await chosen;
  const sent = wait((view) => view.messages.some((message) => message.own && message.sticker?.id === sticker.id));
  backend.command({ action: 'sticker-send', ...context, packageId: sticker.packageId, stickerId: sticker.id });
  const result = await sent;
  assert.equal(result.sendStatus, 'idle');
  assert.equal(result.stickers.selected, null);
});

test('n/p crosses sticker pack boundaries and shows the total page count in Chinese', async (t) => {
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
  let view = {
    chats: [{ id: 'chat', name: 'Alice' }],
    selectedId: 'chat',
    session: 'session',
    selection: 1,
    status: 'ready',
    messages: [],
    draft: '',
    stickers: {
      open: true,
      status: 'ready',
      packageId: '1',
      page: 0,
      pages: 1,
      products: [
        { id: '1', name: 'Frogs', count: 24 },
        { id: '2', name: 'Cats', count: 48 },
      ],
      items: [{ id: '1001', packageId: '1' }],
    },
  };
  backend.emit('state', view);
  await setup.renderOnce();
  setup.mockInput.pressKey('s');
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /貼圖包 1\/2/);
  assert.match(setup.captureCharFrame(), /第 1\/3 頁/);
  setup.mockInput.pressKey('n');
  assert.equal(commands.at(-1).packageId, '2');
  assert.equal(commands.at(-1).page, 0);
  view = { ...view, stickers: { ...view.stickers, packageId: '2', page: 0, pages: 2 } };
  backend.emit('state', view);
  setup.mockInput.pressKey('p');
  assert.equal(commands.at(-1).packageId, '1');
  assert.equal(commands.at(-1).page, 0);
  view = { ...view, stickers: { ...view.stickers, packageId: '2', page: 1 } };
  backend.emit('state', view);
  setup.mockInput.pressKey('n');
  assert.equal(commands.at(-1).packageId, '1');
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /第 3\/3 頁/);
});

test('sticker grid has four columns, highlights selection, and scrolls after resizing', async (t) => {
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
  const items = Array.from({ length: 40 }, (_, index) => ({ id: String(1000 + index), packageId: '1' }));
  const view = {
    chats: [{ id: 'chat', name: 'Alice' }],
    selectedId: 'chat',
    session: 'session',
    selection: 1,
    status: 'ready',
    messages: [],
    draft: '',
    stickerImages: Object.fromEntries(items.map((item) => [item.id, png])),
    stickers: {
      open: true,
      status: 'ready',
      packageId: '1',
      page: 0,
      pages: 1,
      products: [{ id: '1', name: 'Grid pack', count: 40 }],
      items,
    },
  };
  backend.emit('state', view);
  await setup.renderOnce();
  setup.mockInput.pressKey('s');
  await setup.renderOnce();
  await setup.renderOnce();
  const find = (id) => setup.renderer.root.findDescendantById(id);
  const screenSize = Math.max(1, Math.floor(find('line-sticker-grid').height / 7)) * 4;
  const pageCount = Math.ceil(items.length / screenSize);
  assert.match(setup.captureCharFrame(), new RegExp(`本包 1/${pageCount} 頁`));
  await Promise.all(
    Array.from({ length: screenSize }, (_, index) => find(`line-sticker-preview-${index}`)?.loadPromise),
  );
  setup.mockInput.pressKey('n');
  await setup.renderOnce();
  await Promise.all(
    Array.from({ length: screenSize }, (_, index) => find(`line-sticker-preview-${screenSize + index}`)?.loadPromise),
  );
  assert.match(setup.captureCharFrame(), new RegExp(`本包 2/${pageCount} 頁`));
  assert.ok(find(`line-sticker-cell-${screenSize}`));
  setup.mockInput.pressKey('p');
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), new RegExp(`本包 1/${pageCount} 頁`));
  const cards = [0, 1, 2, 3].map((index) => find(`line-sticker-cell-${index}`));
  assert.equal(new Set(cards.map((card) => card.y)).size, 1);
  assert.equal(new Set(cards.map((card) => card.x)).size, 4);
  assert.equal(find('line-sticker-cell-4').y, cards[0].y + 7);
  const images = [0, 1, 2, 3].map((index) => find(`line-sticker-preview-${index}`));
  await Promise.all(images.map((image) => image.loadPromise));
  assert.ok(images.every((image) => image.image && image.height <= 4));
  backend.emit('state', { ...view, stickerImages: {} });
  assert.ok(
    images.every((image) => image.source === png),
    'visible thumbnails survive backend cache eviction',
  );
  setup.mockInput.pressKey('l');
  await setup.renderOnce();
  assert.match(setup.captureCharFrame(), /› 2 · 1001/);
  assert.equal(commands.at(-1).stickerId, '1001');
  setup.mockInput.pressKey('h');
  assert.equal(commands.at(-1).stickerId, '1000');
  assert.equal(find('line-sticker-picker').visible, true);
  setup.mockInput.pressKey('j');
  assert.equal(commands.at(-1).stickerId, '1004');
  setup.mockInput.pressKey('k');
  assert.equal(commands.at(-1).stickerId, '1000');
  // Moving past the top or left edge keeps the current column and selection.
  setup.mockInput.pressKey('l');
  setup.mockInput.pressKey('k');
  assert.equal(commands.at(-1).stickerId, '1001');
  for (let index = 0; index < 7; index++) setup.mockInput.pressKey('j');
  await setup.renderOnce();
  setup.resize(70, 20);
  await setup.renderOnce();
  await setup.renderOnce();
  const grid = find('line-sticker-grid');
  const highlighted = find('line-sticker-cell-29');
  assert.ok(highlighted.y >= grid.y);
  assert.ok(highlighted.y + highlighted.height <= grid.y + grid.height);
  assert.ok(highlighted.x + highlighted.width <= grid.x + grid.width);
  setup.mockInput.pressEnter();
  assert.equal(commands.at(-1).action, 'sticker-choose');
  assert.equal(commands.at(-1).stickerId, '1029');
});

test('missing highlighted sticker retries three times, reports failure, and allows manual retry', async (t) => {
  const { createTestRenderer } = await import('@opentui/core/testing');
  const setup = await createTestRenderer({ width: 100, height: 30, kittyKeyboard: true });
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
    chats: [],
    messages: [],
    selectedId: 'chat',
    session: 'test',
    selection: 1,
    status: 'ready',
    sendStatus: 'idle',
    stickerImages: {},
    stickers: {
      status: 'ready',
      open: true,
      packageId: '1',
      page: 0,
      pages: 1,
      products: [{ id: '1', name: 'Test' }],
      items: [{ id: '1001', packageId: '1' }],
    },
  };
  backend.emit('state', view);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  setup.mockInput.pressKey('s');
  const requests = () => commands.filter((command) => command.action === 'sticker-preview').length;
  const initial = requests();
  for (let attempt = 0; attempt < 3; attempt++) t.mock.timers.tick(1500);
  assert.equal(requests(), initial + 3);
  assert.match(setup.renderer.root.findDescendantById('line-sticker-note').plainText, /載入失敗/);
  t.mock.timers.tick(10000);
  assert.equal(requests(), initial + 3);
  setup.mockInput.pressKey('r');
  assert.equal(requests(), initial + 4);
  backend.emit('state', { ...view, stickerImages: { 1001: png } });
  const preview = setup.renderer.root.findDescendantById('line-sticker-preview-0');
  await preview.loadPromise;
  assert.equal(preview.source, png);
  t.mock.timers.tick(10000);
  assert.equal(requests(), initial + 4);
});
