'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const configDirectory = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tuiline');
const cacheDirectory = () => path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'tuiline');
const hintsPath = () => path.join(cacheDirectory(), 'settings.json');
const legacyHintsPaths = () => [
  path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'tuiline', 'hints-hidden'),
  path.join(configDirectory(), 'hints-hidden'),
];

const privateDirectory = (directory, create) => {
  try {
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(directory);
    return info.isDirectory() && (info.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
};

function readSettings(file) {
  if (!privateDirectory(path.dirname(file), false)) {
    if (!fs.existsSync(path.dirname(file))) return { version: 1, preferences: {} };
    throw new Error('Settings directory is not private');
  }
  let info;
  try {
    info = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, preferences: {} };
    throw error;
  }
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 65536) {
    throw new Error('Settings file is not private or exceeds its size limit');
  }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc?.version !== 1 || !doc.preferences || typeof doc.preferences !== 'object' || Array.isArray(doc.preferences)) {
    throw new Error('Unsupported settings format');
  }
  return doc;
}

function writeSettings(file, doc) {
  const directory = path.dirname(file);
  if (!privateDirectory(directory, true)) return false;
  const temporary = path.join(directory, `.settings-${randomBytes(12).toString('hex')}`);
  let handle;
  try {
    const body = `${JSON.stringify(doc)}\n`;
    if (Buffer.byteLength(body) > 65536) return false;
    handle = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(handle, body);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporary, file);
    return true;
  } catch {
    return false;
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Rename already consumed the temporary file, or creation failed.
    }
  }
}

function legacyMarker(file) {
  try {
    if (!privateDirectory(path.dirname(file), false)) return false;
    const info = fs.lstatSync(file);
    return info.isFile() && (info.mode & 0o777) === 0o600 && info.size === 0;
  } catch {
    return false;
  }
}

function removeLegacyMarkers() {
  for (const file of legacyHintsPaths()) {
    if (!legacyMarker(file)) continue;
    try {
      fs.unlinkSync(file);
    } catch {
      // Preferences are already saved; cleanup can be retried next launch.
    }
  }
}

function currentSettings(file, migrate) {
  const doc = readSettings(file);
  const source = path.join(configDirectory(), 'settings.json');
  if (!migrate || source === file) return doc;
  try {
    // readSettings treats missing files as defaults; only migrate a real file.
    fs.lstatSync(source);
    const old = readSettings(source);
    const merged = { ...old, ...doc, preferences: { ...old.preferences, ...doc.preferences } };
    if (writeSettings(file, merged)) {
      try {
        fs.unlinkSync(source);
      } catch {
        // Retry cleanup next launch if the config directory is not writable.
      }
    }
    return merged;
  } catch {
    // Leave unsafe/unsupported source files and unrelated config files alone.
    return doc;
  }
}

function loadHintsVisible(file) {
  const migrate = file === undefined;
  file ??= hintsPath();
  try {
    const doc = currentSettings(file, migrate);
    if (typeof doc.preferences.hintsVisible === 'boolean') {
      if (migrate) removeLegacyMarkers();
      return doc.preferences.hintsVisible;
    }
    if (migrate && legacyHintsPaths().some(legacyMarker)) {
      doc.preferences.hintsVisible = false;
      if (writeSettings(file, doc)) removeLegacyMarkers();
      return false;
    }
  } catch {
    // Do not overwrite unsafe, corrupt, or newer settings. Retain a legacy
    // choice in memory if migration cannot be saved.
    if (migrate) {
      try {
        const old = readSettings(path.join(configDirectory(), 'settings.json'));
        if (typeof old.preferences.hintsVisible === 'boolean') return old.preferences.hintsVisible;
      } catch {
        // Ignore unsafe or unsupported legacy JSON.
      }
    }
    if (migrate && legacyHintsPaths().some(legacyMarker)) return false;
  }
  return true;
}

function saveHintsVisible(visible, file) {
  const migrate = file === undefined;
  file ??= hintsPath();
  try {
    const doc = currentSettings(file, migrate);
    doc.preferences.hintsVisible = visible;
    if (!writeSettings(file, doc)) return false;
    if (migrate) removeLegacyMarkers();
    return true;
  } catch {
    return false;
  }
}

module.exports = { loadHintsVisible, saveHintsVisible, hintsPath };
