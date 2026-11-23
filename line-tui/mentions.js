'use strict';

const { terminalTheme } = require('./theme');

// LINE mention ranges count UTF-16 units, matching JavaScript string offsets.
function editMentions(previous, next, mentions) {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let oldEnd = previous.length;
  let newEnd = next.length;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const delta = newEnd - oldEnd;
  return mentions.flatMap((mention) => {
    if (oldEnd <= mention.start) return [{ ...mention, start: mention.start + delta, end: mention.end + delta }];
    if (start >= mention.end) return [mention];
    return [];
  });
}

async function createMentionPicker(renderer, backend, { parent, input, getView, getContext, isInsert }) {
  const { TextRenderable: Text } = await import('@opentui/core');
  const theme = await terminalTheme();
  const { default: stringWidth } = await import('string-width');
  const popup = new Text(renderer, {
    id: 'line-mention-picker',
    visible: false,
    height: 1,
    minHeight: 0,
    flexShrink: 0,
    fg: theme.selectionForeground,
    bg: theme.selectionBackground,
  });
  // The picker occupies rows immediately above the composer.
  parent.insertBefore(popup, input);
  const drafts = new Map();
  let scope = '';
  let text = '';
  let mentions = [];
  let candidates = [];
  let cursor = 0;
  let trigger = null;
  let dismissed = '';
  let loadingScope = '';
  const close = () => {
    trigger = null;
    popup.visible = false;
  };
  const group = () => getView().chats?.some((chat) => chat.id === getView().selectedId && chat.group);
  const request = () => {
    const view = getView();
    const requestScope = JSON.stringify(getContext());
    if (view.status !== 'ready' || (loadingScope === requestScope && view.membersStatus !== 'error')) return;
    loadingScope = requestScope;
    backend.command({ action: 'members', ...getContext() });
  };
  const reconcile = () => {
    const nextScope = `${getView().session}:${getView().selectedId}`;
    if (nextScope !== scope) {
      if (scope) drafts.set(scope, { text, mentions });
      const saved = drafts.get(nextScope);
      scope = nextScope;
      text = saved?.text || '';
      mentions = saved?.mentions || [];
      dismissed = '';
      close();
      if (drafts.size > 50) drafts.delete(drafts.keys().next().value);
    }
    mentions = editMentions(text, input.value, mentions);
    text = input.value;
  };
  const sizePopup = (requested) => {
    const height = Math.min(requested, Math.max(0, parent.height - 3));
    popup.height = height;
    popup.visible = height > 0;
    return height;
  };
  const paintCandidates = () => {
    if (!trigger) return;
    if (getView().membersStatus !== 'ready') {
      sizePopup(1);
      return;
    }
    const header = ` @ 群組成員 (${candidates.length}) · ↑/↓ 選擇 · Enter/Tab 插入 · Esc 關閉`;
    // Reserve the pane's borders and one editable row. The remaining rows can
    // show candidates; omit the header when only one candidate row fits.
    const height = sizePopup(Math.min(candidates.length + 1, 7));
    if (height === 0) return;
    const count = Math.min(6, Math.max(1, height - 1));
    const first = Math.max(0, cursor - count + 1);
    const visible = candidates.slice(first, first + count);
    const body = visible.length
      ? visible.map((member, index) => ` ${first + index === cursor ? '›' : ' '} ${member.name}`).join('\n')
      : ' 沒有符合的成員';
    const content = height > 1 ? `${header}\n${body}` : body;
    if (popup.plainText !== content) popup.content = content;
  };
  popup.renderBefore = paintCandidates;
  const resizeParent = parent.onSizeChange;
  parent.onSizeChange = () => {
    resizeParent?.call(parent);
    paintCandidates();
  };
  const paint = () => {
    reconcile();
    if (!isInsert() || !group()) {
      close();
      return;
    }
    if (mentions.length && !['ready', 'error'].includes(getView().membersStatus)) request();
    // The editor uses display columns; LINE ranges use UTF-16 string offsets.
    const { row, col } = input.logicalCursor;
    const offset = input.getTextRangeByCoords(0, 0, row, col).length;
    const prefix = input.value.slice(0, offset);
    const match = /(?:^|\s)@([^\s@]*)$/u.exec(prefix);
    if (!match || mentions.some((mention) => offset > mention.start && offset <= mention.end)) {
      close();
      return;
    }
    const start = offset - match[1].length - 1;
    const key = `${scope}:${start}:${prefix}`;
    if (dismissed === key) {
      close();
      return;
    }
    if (!trigger || trigger.start !== start || trigger.query !== match[1]) cursor = 0;
    trigger = { start, end: offset, query: match[1], key };
    popup.visible = true;
    const view = getView();
    if (view.membersStatus !== 'ready') {
      if (view.membersStatus !== 'error') request();
      sizePopup(1);
      popup.content =
        view.membersStatus === 'error' ? ' 無法載入群組成員 · Ctrl+R 重試 · Esc 關閉' : ' 正在載入群組成員…';
      candidates = [];
      return;
    }
    const query = match[1].toLocaleLowerCase();
    candidates = (view.members || []).filter((member) => member.name.toLocaleLowerCase().includes(query));
    cursor = Math.max(0, Math.min(cursor, candidates.length - 1));
    paintCandidates();
  };
  const choose = () => {
    if (!trigger || !candidates[cursor]) return;
    if (mentions.length >= 20) {
      popup.content = ' 每則訊息最多標註 20 位成員 · Esc 關閉';
      return;
    }
    const member = candidates[cursor];
    const { start, end } = trigger;
    const label = `@${member.name}`;
    const next = `${text.slice(0, start) + label} ${text.slice(end)}`;
    const adjusted = editMentions(text, next, mentions);
    close();
    input.value = next;
    const beforeCursor = next.slice(0, start + label.length + 1).split('\n');
    // OpenTUI gives each tab a configurable fixed cell width. stringWidth alone
    // treats tabs as zero-width and would place the caret inside the mention.
    const tab = ' '.repeat(input.editBuffer.getTabWidth());
    input.setCursor(beforeCursor.length - 1, stringWidth(beforeCursor.at(-1).replaceAll('\t', tab)));
    text = next;
    mentions = [...adjusted, { id: member.id, start, end: start + label.length }].sort((a, b) => a.start - b.start);
    paint();
  };
  return {
    get active() {
      return Boolean(trigger);
    },
    get mentions() {
      reconcile();
      return mentions.map((mention) => ({ ...mention }));
    },
    update: paint,
    close,
    choose,
    handleKey(key) {
      if (!trigger) return false;
      if (key.ctrl && key.name === 'r') {
        loadingScope = '';
        request();
        return true;
      }
      if (key.ctrl || key.meta) return false;
      if (key.shift && ['return', 'kpenter', 'linefeed'].includes(key.name)) {
        close();
        return false;
      }
      if (['up', 'down'].includes(key.name)) {
        cursor = Math.max(0, Math.min(candidates.length - 1, cursor + (key.name === 'down' ? 1 : -1)));
        paint();
        return true;
      }
      if (['return', 'tab'].includes(key.name)) {
        choose();
        return true;
      }
      if (key.name === 'escape') {
        dismissed = trigger.key;
        close();
        return true;
      }
      return false;
    },
  };
}

module.exports = { createMentionPicker, editMentions };
