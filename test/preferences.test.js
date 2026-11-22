'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hintsPath, loadHintsVisible, saveHintsVisible } = require('../line-tui/preferences');

function isolatedXdg(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tuiline-xdg-preferences-'));
  const oldCache = process.env.XDG_CACHE_HOME;
  const oldConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CACHE_HOME = path.join(home, 'cache');
  process.env.XDG_CONFIG_HOME = path.join(home, 'config');
  t.after(() => {
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCache;
    if (oldConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = oldConfig;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return {
    cache: hintsPath(),
    config: path.join(process.env.XDG_CONFIG_HOME, 'tuiline', 'hints-hidden'),
  };
}

test('hidden hints migrate from private config into cache and leave config clean', (t) => {
  const { cache, config } = isolatedXdg(t);
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  fs.writeFileSync(config, '', { mode: 0o600 });
  assert.equal(loadHintsVisible(), false);
  assert.equal(fs.lstatSync(cache).mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(path.dirname(cache)).mode & 0o777, 0o700);
  assert.equal(fs.existsSync(path.dirname(config)), false);
  assert.equal(saveHintsVisible(true), true);
  assert.equal(loadHintsVisible(), true);
  assert.equal(fs.existsSync(cache), false);
  assert.equal(fs.existsSync(path.dirname(config)), false);
});

test('migration leaves unrelated config files in place', (t) => {
  const { cache, config } = isolatedXdg(t);
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  fs.writeFileSync(config, '', { mode: 0o600 });
  const unrelated = path.join(path.dirname(config), 'keep-me');
  fs.writeFileSync(unrelated, 'user data', { mode: 0o600 });
  assert.equal(loadHintsVisible(), false);
  assert.equal(fs.existsSync(config), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'user data');
  assert.equal(fs.existsSync(cache), true);
});

test('empty legacy config directory is removed even when hints are already visible', (t) => {
  const { config } = isolatedXdg(t);
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  assert.equal(loadHintsVisible(), true);
  assert.equal(fs.existsSync(path.dirname(config)), false);
});

test('unsafe legacy preferences are not followed or deleted', (t) => {
  const { cache, config } = isolatedXdg(t);
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 });
  const target = path.join(path.dirname(config), 'target');
  fs.writeFileSync(target, '', { mode: 0o600 });
  fs.symlinkSync(target, config);
  assert.equal(loadHintsVisible(), true);
  assert.equal(fs.lstatSync(config).isSymbolicLink(), true);
  assert.equal(fs.existsSync(cache), false);
});
