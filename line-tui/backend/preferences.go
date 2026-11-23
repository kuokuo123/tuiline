package gui

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// The frontend's global settings.json uses this same versioned format.
// Account preferences are separate files so frontend and backend writes never
// overwrite one another. Serialize read/modify/write across cache instances.
var preferencesMu sync.Mutex

type preferenceStore struct {
	file       string
	legacy     string
	configFile string
}

type preferenceDocument map[string]json.RawMessage

func accountPreferences(account, legacy string) *preferenceStore {
	if !fullID.MatchString(account) {
		return nil
	}
	base, err := os.UserCacheDir()
	if err != nil || os.MkdirAll(base, 0700) != nil {
		return nil
	}
	root := filepath.Join(base, "tuiline")
	accounts := filepath.Join(root, "accounts")
	dir := filepath.Join(accounts, historyHash(account))
	for _, path := range []string{root, accounts, dir} {
		if privateDir(path) != nil {
			return nil
		}
	}
	p := &preferenceStore{file: filepath.Join(dir, "settings.json"), legacy: legacy}
	if config, err := os.UserConfigDir(); err == nil {
		p.configFile = filepath.Join(config, "tuiline", "accounts", historyHash(account), "settings.json")
		if p.configFile == p.file {
			p.configFile = ""
		}
	}
	return p
}

func readPreferences(file string) (preferenceDocument, map[string]json.RawMessage, error) {
	dir, err := os.Lstat(filepath.Dir(file))
	if err != nil {
		return nil, nil, err
	}
	if !dir.IsDir() || dir.Mode().Perm() != 0700 {
		return nil, nil, errors.New("settings directory is not private")
	}
	info, err := os.Lstat(file)
	if errors.Is(err, os.ErrNotExist) {
		return preferenceDocument{"version": json.RawMessage("1")}, map[string]json.RawMessage{}, nil
	}
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 65536 {
		return nil, nil, errors.New("settings file is not private or exceeds its size limit")
	}
	body, err := os.ReadFile(file)
	if err != nil {
		return nil, nil, err
	}
	var doc preferenceDocument
	if json.Unmarshal(body, &doc) != nil || string(doc["version"]) != "1" {
		return nil, nil, errors.New("unsupported settings format")
	}
	var values map[string]json.RawMessage
	if json.Unmarshal(doc["preferences"], &values) != nil || values == nil {
		return nil, nil, errors.New("invalid preferences")
	}
	return doc, values, nil
}

func writePreferences(file string, doc preferenceDocument, values map[string]json.RawMessage) bool {
	prefs, err := json.Marshal(values)
	if err != nil {
		return false
	}
	doc["preferences"] = prefs
	body, err := json.Marshal(doc)
	if err != nil || len(body)+1 > 65536 {
		return false
	}
	tmp, err := os.CreateTemp(filepath.Dir(file), ".settings-*")
	if err != nil {
		return false
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(append(body, '\n'))
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	return err == nil && closeErr == nil && os.Rename(tmp.Name(), file) == nil
}

var preferenceKeys = map[string]string{
	"auto-images-off": "autoImages",
	"mark-read-off":   "markReadEnabled",
	"disabled":        "mediaCacheEnabled",
}

func preferenceBoolean(value json.RawMessage) bool {
	return string(value) == "true" || string(value) == "false"
}

func (p *preferenceStore) legacyMarker(flag string) bool {
	if p == nil || p.legacy == "" {
		return false
	}
	dir, err := os.Lstat(p.legacy)
	if err != nil || !dir.IsDir() || dir.Mode().Perm() != 0700 {
		return false
	}
	info, err := os.Lstat(filepath.Join(p.legacy, flag))
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm() == 0600 && info.Size() == 0
}

// Run with preferencesMu held. New settings always take precedence. A failed
// migration leaves old markers intact and their choices effective in memory.
func (p *preferenceStore) migrate() {
	doc, values, err := readPreferences(p.file)
	if err != nil {
		return
	}
	changed := false
	fromConfig := false
	if p.configFile != "" {
		if info, err := os.Lstat(p.configFile); err == nil && info.Mode().IsRegular() {
			if old, oldValues, err := readPreferences(p.configFile); err == nil {
				for key, value := range old {
					if _, ok := doc[key]; !ok {
						doc[key] = value
					}
				}
				for key, value := range oldValues {
					if _, ok := values[key]; !ok {
						values[key] = value
					}
				}
				changed, fromConfig = true, true
			}
		}
	}
	for flag, key := range preferenceKeys {
		if !preferenceBoolean(values[key]) && p.legacyMarker(flag) {
			values[key] = json.RawMessage("false")
			changed = true
		}
	}
	if changed && !writePreferences(p.file, doc, values) {
		return
	}
	if fromConfig {
		_ = os.Remove(p.configFile)
	}
	for flag, key := range preferenceKeys {
		if preferenceBoolean(values[key]) && p.legacyMarker(flag) {
			_ = os.Remove(filepath.Join(p.legacy, flag))
		}
	}
}

func (p *preferenceStore) enabled(flag string) bool {
	if p == nil {
		return true
	}
	preferencesMu.Lock()
	defer preferencesMu.Unlock()
	p.migrate()
	_, values, err := readPreferences(p.file)
	var enabled bool
	if err == nil {
		if value, ok := values[preferenceKeys[flag]]; ok &&
			preferenceBoolean(value) && json.Unmarshal(value, &enabled) == nil {
			return enabled
		}
	}
	if p.configFile != "" {
		_, oldValues, oldErr := readPreferences(p.configFile)
		if oldErr == nil {
			if value := oldValues[preferenceKeys[flag]]; preferenceBoolean(value) {
				return string(value) == "true"
			}
		}
	}
	return !p.legacyMarker(flag)
}

func (p *preferenceStore) setEnabled(flag string, enabled bool) bool {
	if p == nil {
		return false
	}
	key, ok := preferenceKeys[flag]
	if !ok {
		return false
	}
	preferencesMu.Lock()
	defer preferencesMu.Unlock()
	p.migrate()
	doc, values, err := readPreferences(p.file)
	if err != nil {
		return false
	}
	value, _ := json.Marshal(enabled)
	values[key] = value
	if !writePreferences(p.file, doc, values) {
		return false
	}
	// Other successfully migrated markers were removed by migrate().
	if p.legacyMarker(flag) {
		_ = os.Remove(filepath.Join(p.legacy, flag))
	}
	return true
}
