'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hintsPath = () =>
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'tuiline', 'hints-hidden');

const legacyHintsPath = () =>
  path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tuiline', 'hints-hidden');

const privateDirectory = (directory, create) => {
  try {
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(directory);
    return info.isDirectory() && (info.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
};

function migrateHints(file) {
  const legacy = legacyHintsPath();
  if (legacy === file) return;
  const directory = path.dirname(legacy);
  if (!privateDirectory(directory, false)) return;
  try {
    const info = fs.lstatSync(legacy);
    // Only remove the known preference. Never touch an unfamiliar or unsafe file.
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size !== 0) return;
    if (!saveHintsVisible(false, file)) return;
    fs.unlinkSync(legacy);
  } catch (error) {
    if (error.code !== 'ENOENT') return;
  }
  // Leave other user files in the legacy directory alone.
  try {
    fs.rmdirSync(directory);
  } catch {
    // Not empty, or another process still uses it.
  }
}

function loadHintsVisible(file) {
  if (file === undefined) {
    file = hintsPath();
    migrateHints(file);
  }
  try {
    if (!privateDirectory(path.dirname(file), false)) return true;
    const info = fs.lstatSync(file);
    return !(info.isFile() && (info.mode & 0o777) === 0o600 && info.size === 0);
  } catch {
    return true;
  }
}

function saveHintsVisible(visible, file = hintsPath()) {
  const directory = path.dirname(file);
  if (!privateDirectory(directory, true)) return false;
  try {
    if (visible) {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== 'ENOENT') return false;
      }
      return true;
    }
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || (info.mode & 0o777) !== 0o600) return false;
      if (info.size !== 0) fs.truncateSync(file, 0);
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') return false;
    }
    const handle = fs.openSync(file, 'wx', 0o600);
    fs.closeSync(handle);
    return true;
  } catch {
    return false;
  }
}

module.exports = { loadHintsVisible, saveHintsVisible, hintsPath };
