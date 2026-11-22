'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLoginLog, loginLogPath } = require('../line-tui/login-log');

test('login progress is saved and printed after exit without QR, PIN, or account data', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tuiline-login-log-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'login.log');
  const logger = createLoginLog({ file, now: () => new Date('2026-11-17T00:00:00Z') });
  const view = {
    status: 'idle',
    account: { name: 'PRIVATE-NAME' },
    messages: [{ text: 'PRIVATE-TEXT' }],
    login: {
      stage: 'phone',
      statusText: '請在手機上確認登入',
      pin: '123456',
      image: 'PRIVATE-QR',
      attempt: 'PRIVATE-ID',
    },
  };
  logger.record(view);
  logger.record(view);
  logger.record({ ...view, login: { ...view.login, stage: 'uncertain', statusText: '無法儲存登入資料' } });
  logger.record({
    ...view,
    status: 'unauthenticated',
    authDiagnostic: '載入失敗 [profile: session-invalidated]',
    login: { stage: 'success', statusText: '登入資訊已儲存' },
  });
  const saved = readFileSync(file, 'utf8');
  assert.equal(saved.trim().split('\n').length, 3);
  assert.match(saved, /profile: session-invalidated/);
  assert.match(saved, /login:phone/);
  assert.match(saved, /無法儲存登入資料/);
  assert.doesNotMatch(saved, /123456|PRIVATE/);
  let output = '';
  logger.print({
    write: (value) => {
      output += value;
    },
  });
  assert.match(output, /LINE login diagnostics/);
  assert.match(output, /無法儲存登入資料/);
  const once = output;
  logger.print({
    write: (value) => {
      output += value;
    },
  });
  assert.equal(output, once);
});

test('unwritable login log retains diagnostics for the terminal', () => {
  const logger = createLoginLog({ file: '/dev/null/login.log' });
  logger.record({ login: { stage: 'error', statusText: '登入失敗' } });
  let output = '';
  logger.print({
    write: (value) => {
      output += value;
    },
  });
  assert.match(output, /登入失敗/);
  assert.match(output, /Could not write login log/);
});

test('login log defaults to a private XDG cache directory, not the working directory', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tuiline-login-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  let logger;
  try {
    logger = createLoginLog();
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
  }
  logger.record({ login: { stage: 'phone', statusText: 'Checking login' } });
  const file = loginLogPath(dir);
  assert.equal(path.dirname(file), path.join(dir, 'tuiline'));
  assert.ok(existsSync(file));
  assert.equal(lstatSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(lstatSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, 'utf8'), /Checking login/);
});

test('login log refuses unsafe files instead of following a symlink', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tuiline-login-unsafe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'target');
  const file = path.join(dir, 'login.log');
  writeFileSync(target, 'keep');
  symlinkSync(target, file);
  const logger = createLoginLog({ file });
  logger.record({ login: { stage: 'error', statusText: 'No login' } });
  assert.equal(readFileSync(target, 'utf8'), 'keep');
  rmSync(file);
  writeFileSync(file, 'private?', { mode: 0o600 });
  chmodSync(file, 0o644);
  logger.record({ login: { stage: 'uncertain', statusText: 'Still no login' } });
  assert.equal(readFileSync(file, 'utf8'), 'private?');
});
