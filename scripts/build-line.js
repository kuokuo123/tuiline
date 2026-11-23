'use strict';

const { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const { patchFile } = require('./line-patches');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = path.resolve(__dirname, '..');
const output = path.resolve(__dirname, '../backend-bin/line-gui');
mkdirSync(path.dirname(output), { recursive: true });
// Apply TUI patches to the bundled backend through Go's overlay support.
const temporary = mkdtempSync(path.join(os.tmpdir(), 'tuiline-line-build-'));
try {
  const replace = {};
  for (const name of [
    'internal/gui/direct.go',
    'internal/gui/lifecycle.go',
    'internal/gui/engine.go',
    'internal/gui/receive.go',
    'internal/gui/receipts.go',
    'internal/gui/features.go',
    'internal/events/watch.go',
    'pkg/line/client.go',
    'internal/gui/locale.go',
    'internal/gui/images.go',
    'internal/gui/photos.go',
    'internal/gui/stickers.go',
    'internal/gui/profiles.go',
    'pkg/line/structs.go',
    'internal/messaging/client.go',
    'internal/messaging/files.go',
  ]) {
    const original = path.resolve(source, 'backend', name);
    const patched = path.join(temporary, name.replaceAll('/', '-'));
    const content = patchFile(name, readFileSync(original, 'utf8'))
      .replace(/(len\([^\n]+?\)\s*(?:>=|>)\s*)500\b/g, (_match, comparison) => `${comparison}5000`)
      .replace('Up to 500 chats can be loaded.', 'Up to 5000 chats can be loaded.');
    writeFileSync(patched, content);
    replace[original] = patched;
  }
  replace[path.resolve(source, 'backend/internal/gui/tuiline_read_receipts.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/read_receipts.go',
  );
  replace[path.resolve(source, 'backend/internal/gui/tuiline_history_cache.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/history_cache.go',
  );
  replace[path.resolve(source, 'backend/internal/gui/tuiline_media_cache.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/media_cache.go',
  );
  const testing = process.argv.includes('--test');
  replace[path.resolve(source, 'backend/internal/gui/tuiline_preferences.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/preferences.go',
  );
  replace[path.resolve(source, 'backend/internal/gui/tuiline_media_events.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/media_events.go',
  );
  replace[path.resolve(source, 'backend/internal/gui/tuiline_photo_upload.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/gui_photo_upload.go',
  );
  replace[path.resolve(source, 'backend/internal/messaging/tuiline_photo_upload.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/photo_upload.go',
  );
  replace[path.resolve(source, 'backend/internal/gui/tuiline_chat_settings.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/chat_settings.go',
  );
  replace[path.resolve(source, 'backend/pkg/line/tuiline_chat_settings.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/line_chat_settings.go',
  );
  replace[path.resolve(source, 'backend/internal/gui/tuiline_incoming_activity.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/incoming_activity.go',
  );
  replace[path.resolve(source, 'backend/internal/gui/tuiline_notifications.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/notifications.go',
  );
  replace[path.resolve(source, 'backend/internal/gui/tuiline_sticker_cache.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/sticker_cache.go',
  );
  replace[path.resolve(source, 'backend/internal/gui/tuiline_chinese_locale.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/chinese_locale.go',
  );
  replace[path.resolve(source, 'backend/pkg/line/tuiline_download_progress.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/download_progress.go',
  );
  replace[path.resolve(source, 'backend/internal/gui/tuiline_download_progress.go')] = path.resolve(
    __dirname,
    '../line-tui/backend/gui_download_progress.go',
  );
  if (testing) {
    replace[path.resolve(source, 'backend/internal/gui/tuiline_preferences_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/preferences_test.go',
    );
    replace[path.resolve(source, 'backend/internal/gui/tuiline_media_events_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/media_events_test.go',
    );
    replace[path.resolve(source, 'backend/internal/events/tuiline_media_watch_events_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/media_watch_events_test.go',
    );
    replace[path.resolve(source, 'backend/pkg/line/tuiline_photo_upload_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/line_photo_upload_test.go',
    );
    replace[path.resolve(source, 'backend/internal/gui/tuiline_photo_upload_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/gui_photo_upload_test.go',
    );
    replace[path.resolve(source, 'backend/internal/messaging/tuiline_photo_upload_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/photo_upload_test.go',
    );
    replace[path.resolve(source, 'backend/internal/gui/tuiline_chat_settings_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/chat_settings_test.go',
    );
    replace[path.resolve(source, 'backend/pkg/line/tuiline_chat_settings_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/line_chat_settings_test.go',
    );
    replace[path.resolve(source, 'backend/internal/gui/tuiline_incoming_activity_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/incoming_activity_test.go',
    );
    replace[path.resolve(source, 'backend/internal/gui/tuiline_notifications_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/notifications_test.go',
    );
    replace[path.resolve(source, 'backend/internal/gui/tuiline_history_cache_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/history_cache_test.go',
    );
    replace[path.resolve(source, 'backend/internal/gui/tuiline_media_cache_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/media_cache_test.go',
    );
    replace[path.resolve(source, 'backend/internal/gui/tuiline_sticker_cache_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/sticker_cache_test.go',
    );
    replace[path.resolve(source, 'backend/internal/gui/tuiline_chinese_locale_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/chinese_locale_test.go',
    );
    replace[path.resolve(source, 'backend/internal/gui/tuiline_download_progress_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/download_progress_test.go',
    );
    replace[path.resolve(source, 'backend/internal/events/tuiline_read_events_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/read_events_test.go',
    );
    replace[path.resolve(source, 'backend/internal/gui/tuiline_read_receipts_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/read_receipts_test.go',
    );
    replace[path.resolve(source, 'backend/internal/gui/tuiline_chat_limit_test.go')] = path.resolve(
      __dirname,
      '../test/line-backend/chat_limit_test.go',
    );
  }
  const overlay = path.join(temporary, 'overlay.json');
  writeFileSync(overlay, JSON.stringify({ Replace: replace }));
  const args = testing
    ? [
        'test',
        '-timeout',
        '30s',
        '-overlay',
        overlay,
        ...process.argv.slice(3),
        './internal/gui',
        './internal/events',
        './internal/messaging',
        './internal/session',
        './pkg/line',
      ]
    : ['build', '-overlay', overlay, '-trimpath', '-buildvcs=false', '-o', output, './cmd/line-gui'];
  const result = spawnSync('go', args, {
    cwd: path.join(source, 'backend'),
    stdio: 'inherit',
    env: {
      ...process.env,
      CGO_ENABLED: '0',
      GOCACHE: process.env.GOCACHE || path.join(os.tmpdir(), 'tuiline-go-cache'),
    },
  });
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
