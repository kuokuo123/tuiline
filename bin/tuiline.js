#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`tuiline — LINE in your terminal

Usage: tuiline [--demo] [--backend /path/to/line-gui]

h / l               leave / enter conversation focus
Tab                 switch sidebar / conversation scroll mode
Up/Down or j/k      navigate sidebar or select message
Enter               focus conversation; send in insert mode
l on an image       expand in right pane; h or Escape returns
r                   reply to highlighted message
@ in insert mode    search and mention group members
i                   enter insert mode
Ctrl+F / Ctrl+B     scroll conversation a full page
Ctrl+D / Ctrl+U     scroll conversation half a page
Escape              return to conversation scroll mode
PageUp/PageDown     scroll history
gg / G              jump to top / bottom
g then x            open hyperlinks in the marked message
Ctrl+R              refresh
Ctrl+S              download selected attachment in scroll mode
Ctrl+T              choose files and upload immediately
Ctrl+L              QR login / retry
Ctrl+Y              confirm login
Ctrl+X              cancel login
Ctrl+C              quit

LINE_BACKEND        path to the reference LINE backend binary
--demo              fictional data; no account needed

Legacy Telegram client: node bin/telegram.js
`);
} else if (args.includes('--version') || args.includes('-v')) {
  process.stdout.write(`${require('../package.json').version}\n`);
} else if (!process.execArgv.includes('--experimental-ffi')) {
  const result = spawnSync(
    process.execPath,
    ['--experimental-ffi', '--disable-warning=ExperimentalWarning', __filename, ...args],
    { stdio: 'inherit' },
  );
  if (result.error) process.stderr.write(`${result.error.message}\n`);
  process.exitCode = result.status ?? 1;
} else {
  require('../line-tui/app')
    .main(args)
    .catch((error) => {
      process.stderr.write(`tuiline: ${error.message}\n`);
      process.exitCode = 1;
    });
}
