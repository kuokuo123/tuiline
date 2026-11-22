'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const channel = require('../bin/channel');

const root = path.resolve(__dirname, '..');

test('package, lockfile and executable consistently identify as tuiline', () => {
  const pkg = require('../package.json');
  const lock = require('../package-lock.json');
  assert.equal(pkg.name, 'tuiline');
  assert.deepEqual(pkg.bin, { tuiline: 'bin/tuiline.js' });
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.deepEqual(lock.packages[''].bin, pkg.bin);
  const cli = path.join(root, pkg.bin.tuiline);
  assert.ok(existsSync(cli));
  const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.match(help, /^tuiline — LINE/);
  assert.match(help, /Usage: tuiline /);
  assert.doesNotMatch(help, /tuigram/);
  assert.equal(execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim(), pkg.version);
});

test('npm and mise upgrade plans target tuiline, not the upstream package', () => {
  const directory = '/opt/npm/lib/node_modules/tuiline';
  assert.equal(channel.detect(directory), 'npm');
  assert.equal(channel.npmPrefix(directory), '/opt/npm');
  const plan = channel.upgradePlan(directory, '2.0.0');
  assert.equal(plan.manualCommand, 'npm i -g tuiline@2.0.0');
  assert.ok(plan.steps[0].args.includes('tuiline@2.0.0'));
  const mise = channel.upgradePlan('/opt/mise/installs/npm-tuiline/1/node_modules/tuiline', '2.0.0');
  assert.deepEqual(mise.steps[0].args, ['upgrade', 'npm:tuiline']);
});

test('renamed Telegram credentials retain legacy environment compatibility without mixing keys', () => {
  const source = readFileSync(path.join(root, 'src/01-config/02-credentials.js'), 'utf8');
  const resolve = (env) =>
    runInNewContext(source, {
      process: { env },
      config: {},
      Result: { from: () => ({ ok: false }) },
    });
  assert.equal(resolve({ TUIGRAM_API_ID: '1', TUIGRAM_API_HASH: 'old' }).apiHash, 'old');
  const renamed = resolve({
    TUILINE_API_ID: '2',
    TUILINE_API_HASH: 'new',
    TUIGRAM_API_ID: '1',
    TUIGRAM_API_HASH: 'old',
  });
  assert.equal(renamed.apiId, '2');
  assert.equal(renamed.apiHash, 'new');
  assert.equal(resolve({ TUILINE_API_ID: '2', TUIGRAM_API_HASH: 'old' }).source, undefined);
});
