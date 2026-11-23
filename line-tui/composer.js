'use strict';

// Keep the small value/input/enter interface used by drafts and mentions, while
// letting OpenTUI's textarea handle multiline cursor movement, selection and undo.
async function createComposer(renderer, options) {
  const { TextareaRenderable } = await import('@opentui/core');
  const limit = 10000;
  const bounded = (text, length = limit) => {
    const value = text.replace(/\r\n?/g, '\n').slice(0, length);
    // Never leave half a surrogate pair at the LINE UTF-16 length boundary.
    return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
  };
  class Composer extends TextareaRenderable {
    constructor() {
      super(renderer, {
        ...options,
        height: 'auto',
        minHeight: 1,
        maxHeight: 5,
        flexShrink: 0,
        wrapMode: 'word',
        keyBindings: [
          ...['return', 'kpenter', 'linefeed'].flatMap((name) => [
            { name, action: 'submit' },
            { name, shift: true, action: 'newline' },
          ]),
          { name: 'z', ctrl: true, action: 'undo' },
          { name: 'z', ctrl: true, shift: true, action: 'redo' },
        ],
      });
    }

    get value() {
      return this.plainText;
    }

    set value(text) {
      const value = bounded(text);
      if (value === this.plainText) return;
      super.setText(value);
      this.gotoBufferEnd();
      this.emit('input', this.plainText);
    }

    insertText(text) {
      const remaining = limit - this.plainText.length + this.getSelectedText().length;
      const value = bounded(text, Math.max(0, remaining));
      if (value) {
        super.insertText(value);
        this.emit('input', this.plainText);
      }
    }

    newLine() {
      this.insertText('\n');
      return true;
    }

    submit() {
      this.emit('enter', this.plainText);
      return true;
    }
  }
  // Native content-change callbacks arrive later. Publish editor commands
  // synchronously so a concurrent backend frame cannot overwrite a fresh draft.
  for (const method of [
    'deleteChar',
    'deleteCharBackward',
    'deleteLine',
    'deleteWordBackward',
    'deleteWordForward',
    'deleteToLineStart',
    'deleteToLineEnd',
    'deleteSelection',
    'undo',
    'redo',
  ]) {
    const edit = TextareaRenderable.prototype[method];
    Composer.prototype[method] = function publishEdit(...args) {
      const before = this.plainText;
      const result = edit.apply(this, args);
      if (before !== this.plainText) this.emit('input', this.plainText);
      return result;
    };
  }
  return new Composer();
}

module.exports = { createComposer };
