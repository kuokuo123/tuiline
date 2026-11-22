'use strict';

const { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, writeSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const loginLogPath = (cacheHome = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')) =>
  path.join(cacheHome, 'tuiline', 'tuiline-login.log');

function createLoginLog({ file = loginLogPath(), now = () => new Date() } = {}) {
  const entries = [];
  let previous = '';
  let writeError = '';
  let printed = false;
  return {
    record(view) {
      const login = view.login;
      if (!login?.stage || login.stage === 'idle') return;
      // Log application-generated progress only, never the full backend state.
      // PIN, QR image, login attempt IDs, account data and messages are excluded.
      const text = String([login.statusText, view.authDiagnostic].filter(Boolean).join(' · '))
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
        .slice(0, 1000);
      const key = JSON.stringify([login.stage, text, view.status]);
      if (key === previous) return;
      previous = key;
      const line = `${now().toISOString()} [login:${login.stage}] ${text} (backend: ${view.status || 'unknown'})`;
      entries.push(line);
      if (entries.length > 100) entries.shift();
      try {
        const directory = path.dirname(file);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const dirInfo = lstatSync(directory);
        if (!dirInfo.isDirectory() || (dirInfo.mode & 0o777) !== 0o700) {
          throw new Error('Login log directory is not private');
        }
        const fd = openSync(
          file,
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0),
          0o600,
        );
        try {
          const info = fstatSync(fd);
          if (!info.isFile() || (info.mode & 0o777) !== 0o600) {
            throw new Error('Login log file is not private');
          }
          writeSync(fd, `${line}\n`);
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        writeError = error.code || 'write failed';
      }
    },
    print(stream = process.stderr) {
      if (printed || !entries.length) return;
      printed = true;
      stream.write(`\nLINE login diagnostics:\n${entries.join('\n')}\n`);
      stream.write(writeError ? `Could not write login log: ${writeError}\n` : `Login log: ${file}\n`);
    },
  };
}

module.exports = { createLoginLog, loginLogPath };
