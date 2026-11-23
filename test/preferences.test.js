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
    cache: path.join(process.env.XDG_CACHE_HOME, 'tuiline', 'hints-hidden'),
    legacyConfig: path.join(process.env.XDG_CONFIG_HOME, 'tuiline', 'hints-hidden'),
    configSettings: path.join(process.env.XDG_CONFIG_HOME, 'tuiline', 'settings.json'),
    config: hintsPath(),
  };
}

function privateFile(file, body = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, body, { mode: 0o600 });
}

for (const existing of [false, true]) {
  test(`config JSON moves to cache, preserving settings and cache precedence: existing=${existing}`, (t) => {
    const { configSettings, config } = isolatedXdg(t);
    const old = { version: 1, extra: 'keep', preferences: { hintsVisible: false, other: false } };
    privateFile(configSettings, JSON.stringify(old));
    if (existing) privateFile(config, JSON.stringify({ version: 1, preferences: { hintsVisible: true } }));
    assert.equal(loadHintsVisible(), existing);
    assert.equal(fs.existsSync(configSettings), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(config)), {
      ...old,
      preferences: { ...old.preferences, hintsVisible: existing },
    });
    assert.equal(config, path.join(process.env.XDG_CACHE_HOME, 'tuiline', 'settings.json'));
    assert.equal(loadHintsVisible(), existing);
  });
}

test('failed config JSON migration keeps the source and refuses to overwrite the target', (t) => {
  const { configSettings, config } = isolatedXdg(t);
  privateFile(configSettings, JSON.stringify({ version: 1, preferences: { hintsVisible: false } }));
  privateFile(config, '{');
  assert.equal(loadHintsVisible(), false);
  assert.equal(saveHintsVisible(true), false);
  assert.equal(fs.existsSync(configSettings), true);
  assert.equal(fs.readFileSync(config, 'utf8'), '{');
});

test('unsafe config JSON sources are left untouched', (t) => {
  const { configSettings, config } = isolatedXdg(t);
  const target = path.join(path.dirname(configSettings), 'target');
  privateFile(target, JSON.stringify({ version: 1, preferences: { hintsVisible: false } }));
  fs.symlinkSync(target, configSettings);
  assert.equal(loadHintsVisible(), true);
  assert.equal(fs.lstatSync(configSettings).isSymbolicLink(), true);
  assert.equal(fs.existsSync(config), false);
});

for (const source of ['cache', 'legacyConfig']) {
  test(`hidden hints migrate from ${source} to versioned cache settings`, (t) => {
    const files = isolatedXdg(t);
    privateFile(files[source]);
    assert.equal(loadHintsVisible(), false);
    assert.equal(fs.lstatSync(files.config).mode & 0o777, 0o600);
    assert.equal(fs.lstatSync(path.dirname(files.config)).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(fs.readFileSync(files.config)), { version: 1, preferences: { hintsVisible: false } });
    assert.equal(fs.existsSync(files[source]), false);
    assert.equal(saveHintsVisible(true), true);
    assert.equal(loadHintsVisible(), true);
    assert.equal(JSON.parse(fs.readFileSync(files.config)).preferences.hintsVisible, true);
  });
}

test('new config wins over stale markers and preserves unrelated settings and files', (t) => {
  const { cache, legacyConfig, config } = isolatedXdg(t);
  privateFile(cache);
  privateFile(legacyConfig);
  privateFile(config, JSON.stringify({ version: 1, extra: 'keep', preferences: { hintsVisible: true, other: false } }));
  const unrelated = path.join(path.dirname(config), 'keep-me');
  privateFile(unrelated, 'user data');
  assert.equal(loadHintsVisible(), true);
  assert.equal(fs.existsSync(cache), false);
  assert.equal(fs.existsSync(legacyConfig), false);
  assert.equal(saveHintsVisible(false), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(config)), {
    version: 1,
    extra: 'keep',
    preferences: { hintsVisible: false, other: false },
  });
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'user data');
});

test('deleting media does not change hints; deleting all cache resets them', (t) => {
  const { cache } = isolatedXdg(t);
  assert.equal(loadHintsVisible(), true);
  assert.equal(saveHintsVisible(false), true);
  fs.mkdirSync(path.dirname(cache), { recursive: true, mode: 0o700 });
  const media = path.join(path.dirname(cache), 'media');
  fs.mkdirSync(media, { mode: 0o700 });
  fs.rmSync(media, { recursive: true });
  assert.equal(loadHintsVisible(), false);
  assert.equal(fs.existsSync(cache), false);
  fs.rmSync(process.env.XDG_CACHE_HOME, { recursive: true });
  assert.equal(loadHintsVisible(), true);
});

test('unsafe legacy markers are not followed or deleted', (t) => {
  const { cache, config } = isolatedXdg(t);
  const target = path.join(path.dirname(cache), 'target');
  privateFile(target);
  fs.symlinkSync(target, cache);
  assert.equal(loadHintsVisible(), true);
  assert.equal(fs.lstatSync(cache).isSymbolicLink(), true);
  assert.equal(fs.existsSync(config), false);
});

for (const kind of ['symlink', 'permissions', 'corrupt', 'newer']) {
  test(`unsafe or unsupported settings are not overwritten: ${kind}`, (t) => {
    const { config, cache } = isolatedXdg(t);
    privateFile(cache);
    const body = kind === 'corrupt' ? '{' : JSON.stringify({ version: kind === 'newer' ? 2 : 1, preferences: {} });
    if (kind === 'symlink') {
      const target = path.join(path.dirname(config), 'target');
      privateFile(target, body);
      fs.symlinkSync(target, config);
    } else {
      privateFile(config, body);
      if (kind === 'permissions') fs.chmodSync(config, 0o644);
    }
    assert.equal(loadHintsVisible(), false, 'failed migration retains the old choice');
    assert.equal(saveHintsVisible(true), false);
    assert.equal(fs.existsSync(cache), true);
    assert.equal(fs.readFileSync(config, 'utf8'), body);
    if (kind === 'symlink') assert.equal(fs.lstatSync(config).isSymbolicLink(), true);
  });
}

test('settings directory symlinks are refused', (t) => {
  const { config } = isolatedXdg(t);
  const target = path.join(process.env.XDG_CACHE_HOME, 'target');
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.symlinkSync(target, path.dirname(config));
  assert.equal(saveHintsVisible(false), false);
  assert.equal(fs.existsSync(path.join(target, 'settings.json')), false);
});
