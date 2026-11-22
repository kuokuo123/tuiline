'use strict';

// Keep terminal color intent instead of copying RGB values from a palette snapshot.
async function terminalTheme() {
  const { RGBA } = await import('@opentui/core');
  return {
    background: RGBA.defaultBackground(),
    foreground: RGBA.defaultForeground(),
    accent: RGBA.fromIndex(2),
    muted: RGBA.fromIndex(8),
    border: RGBA.fromIndex(0),
    selectionBackground: RGBA.fromIndex(4),
    selectionForeground: RGBA.fromIndex(0),
    chatSelectionBackground: RGBA.fromIndex(4),
    messageSelectionBackground: RGBA.fromIndex(4),
    scrollbar: {
      trackOptions: { backgroundColor: RGBA.defaultBackground(), foregroundColor: RGBA.fromIndex(0) },
      arrowOptions: { backgroundColor: RGBA.defaultBackground(), foregroundColor: RGBA.fromIndex(0) },
    },
    // SGR 30/90 foreground slots correspond to SGR 40/100 when used as backgrounds.
    replyPalette: [0, 8].map((slot) => [RGBA.fromIndex(slot), RGBA.fromIndex(7)]),
  };
}

module.exports = { terminalTheme };
