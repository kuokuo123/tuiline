'use strict';

// Keep terminal color intent instead of copying RGB values from a palette snapshot.
async function terminalTheme() {
  const { RGBA } = await import('@opentui/core');
  return {
    background: RGBA.defaultBackground(),
    foreground: RGBA.defaultForeground(),
    accent: RGBA.fromIndex(2),
    muted: RGBA.fromIndex(8),
    selectionBackground: RGBA.fromIndex(7),
    selectionForeground: RGBA.fromIndex(0),
    messageSelectionBackground: RGBA.fromIndex(4),
    scrollbar: {
      trackOptions: { backgroundColor: RGBA.defaultBackground(), foregroundColor: RGBA.fromIndex(8) },
      arrowOptions: { backgroundColor: RGBA.defaultBackground(), foregroundColor: RGBA.fromIndex(8) },
    },
    replyPalette: [7, 8].map((slot) => [RGBA.fromIndex(slot), RGBA.fromIndex(15)]),
  };
}

module.exports = { terminalTheme };
