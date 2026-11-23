package gui

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAccountPreferencesMigrationAndCacheRemoval(t *testing.T) {
	cacheHome := t.TempDir()
	t.Setenv("XDG_CACHE_HOME", cacheHome)
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	root := filepath.Join(t.TempDir(), "tuiline", "media")
	account := "u" + strings.Repeat("a", 43)
	dir := filepath.Join(root, historyHash(account))
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	for flag := range preferenceKeys {
		if err := os.WriteFile(filepath.Join(dir, flag), nil, 0600); err != nil {
			t.Fatal(err)
		}
	}
	cache := openMediaCache(root, account)
	if cache.active() || cache.autoImages() || cache.preferenceEnabled("mark-read-off") {
		t.Fatal("legacy choices were not migrated")
	}
	file := filepath.Join(cacheHome, "tuiline", "accounts", historyHash(account), "settings.json")
	doc, values, err := readPreferences(file)
	if err != nil || string(doc["version"]) != "1" || len(values) != 3 {
		t.Fatalf("invalid config: %v", err)
	}
	for flag := range preferenceKeys {
		if _, err := os.Lstat(filepath.Join(dir, flag)); !os.IsNotExist(err) {
			t.Fatal("legacy marker retained after successful migration")
		}
	}
	info, err := os.Stat(file)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("settings are not private")
	}
	// Deleting media must not touch the settings elsewhere in the cache tree.
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	cache = openMediaCache(root, account)
	if cache.active() || cache.autoImages() || cache.preferenceEnabled("mark-read-off") {
		t.Fatal("cache deletion reset preferences")
	}
	other := openMediaCache(root, "u"+strings.Repeat("b", 43))
	if !other.active() || !other.autoImages() || !other.preferenceEnabled("mark-read-off") {
		t.Fatal("account settings leaked")
	}
	if !cache.setAutoImages(true) || !cache.setPreferenceEnabled("mark-read-off", true) || !cache.setEnabled(true) {
		t.Fatal("could not save enabled preferences")
	}
	cache = openMediaCache(root, account)
	if !cache.active() || !cache.autoImages() || !cache.preferenceEnabled("mark-read-off") {
		t.Fatal("enabled settings did not survive restart")
	}
	for flag := range preferenceKeys {
		if _, err := os.Lstat(filepath.Join(dir, flag)); !os.IsNotExist(err) {
			t.Fatal("toggle recreated a legacy marker")
		}
	}
}

func TestPreferencesPreserveNewSettingsAndUnknownKeys(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	legacy := t.TempDir()
	if err := os.Chmod(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	prefs := accountPreferences("u"+strings.Repeat("a", 43), legacy)
	body := `{"version":1,"extra":"keep","preferences":{"autoImages":true,"other":false}}`
	if err := os.WriteFile(prefs.file, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(legacy, "auto-images-off"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if !prefs.enabled("auto-images-off") {
		t.Fatal("stale marker overrode new preference")
	}
	if !prefs.setEnabled("mark-read-off", false) {
		t.Fatal("save failed")
	}
	doc, values, err := readPreferences(prefs.file)
	if err != nil || string(doc["extra"]) != `"keep"` || string(values["other"]) != "false" {
		t.Fatal("unknown settings lost")
	}
	if !prefs.enabled("auto-images-off") || prefs.enabled("mark-read-off") {
		t.Fatal("saving another key changed preferences")
	}
	// Separate handles must merge with the latest file, not stale snapshots.
	other := accountPreferences("u"+strings.Repeat("a", 43), legacy)
	if !other.setEnabled("disabled", false) || !prefs.setEnabled("auto-images-off", false) || other.enabled("disabled") {
		t.Fatal("another handle's updates were lost")
	}
}

func TestPreferencesRejectUnsafeAndUnsupportedFiles(t *testing.T) {
	for _, kind := range []string{"symlink", "permissions", "corrupt", "newer"} {
		t.Run(kind, func(t *testing.T) {
			t.Setenv("XDG_CACHE_HOME", t.TempDir())
			t.Setenv("XDG_CONFIG_HOME", t.TempDir())
			legacy := t.TempDir()
			if err := os.Chmod(legacy, 0700); err != nil {
				t.Fatal(err)
			}
			prefs := accountPreferences("u"+strings.Repeat("a", 43), legacy)
			marker := filepath.Join(legacy, "auto-images-off")
			if err := os.WriteFile(marker, nil, 0600); err != nil {
				t.Fatal(err)
			}
			body := `{"version":1,"preferences":{}}`
			if kind == "corrupt" {
				body = "{"
			}
			if kind == "newer" {
				body = `{"version":2,"preferences":{}}`
			}
			if kind == "symlink" {
				target := filepath.Join(filepath.Dir(prefs.file), "target")
				if err := os.WriteFile(target, []byte(body), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, prefs.file); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.WriteFile(prefs.file, []byte(body), 0600); err != nil {
					t.Fatal(err)
				}
				if kind == "permissions" {
					if err := os.Chmod(prefs.file, 0644); err != nil {
						t.Fatal(err)
					}
				}
			}
			if prefs.enabled("auto-images-off") {
				t.Fatal("failed migration lost legacy choice")
			}
			if prefs.setEnabled("auto-images-off", true) {
				t.Fatal("unsafe settings overwritten")
			}
			got, _ := os.ReadFile(prefs.file)
			if string(got) != body {
				t.Fatal("settings changed")
			}
			if _, err := os.Stat(marker); err != nil {
				t.Fatal("failed migration removed legacy marker")
			}
		})
	}
}

func TestPreferencesIgnoreUnsafeLegacyMarkers(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	legacy := t.TempDir()
	if err := os.Chmod(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	prefs := accountPreferences("u"+strings.Repeat("a", 43), legacy)
	target := filepath.Join(legacy, "target")
	if err := os.WriteFile(target, nil, 0600); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(legacy, "mark-read-off")
	if err := os.Symlink(target, marker); err != nil {
		t.Fatal(err)
	}
	if !prefs.enabled("mark-read-off") {
		t.Fatal("unsafe legacy marker followed")
	}
	if !prefs.setEnabled("mark-read-off", false) {
		t.Fatal("safe config could not be saved")
	}
	info, err := os.Lstat(marker)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("unsafe legacy marker removed")
	}
}

func TestPreferenceFormatMatchesFrontend(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	prefs := accountPreferences("u"+strings.Repeat("a", 43), "")
	if !prefs.setEnabled("auto-images-off", false) {
		t.Fatal("save failed")
	}
	body, _ := os.ReadFile(prefs.file)
	var doc struct {
		Version     int             `json:"version"`
		Preferences map[string]bool `json:"preferences"`
	}
	if json.Unmarshal(body, &doc) != nil || doc.Version != 1 || doc.Preferences["autoImages"] {
		t.Fatal("unexpected settings format")
	}
}

func TestAccountConfigJSONMovesToCache(t *testing.T) {
	for _, existing := range []bool{false, true} {
		name := "missing-cache-settings"
		if existing {
			name = "existing-cache-settings"
		}
		t.Run(name, func(t *testing.T) {
			cacheHome, configHome := t.TempDir(), t.TempDir()
			t.Setenv("XDG_CACHE_HOME", cacheHome)
			t.Setenv("XDG_CONFIG_HOME", configHome)
			account := "u" + strings.Repeat("a", 43)
			prefs := accountPreferences(account, "")
			if err := os.MkdirAll(filepath.Dir(prefs.configFile), 0700); err != nil {
				t.Fatal(err)
			}
			old := `{"version":1,"extra":"keep","preferences":{"autoImages":false,"markReadEnabled":false,"other":false}}`
			if err := os.WriteFile(prefs.configFile, []byte(old), 0600); err != nil {
				t.Fatal(err)
			}
			if existing {
				if err := os.WriteFile(prefs.file, []byte(`{"version":1,"preferences":{"autoImages":true}}`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if prefs.enabled("auto-images-off") != existing || prefs.enabled("mark-read-off") {
				t.Fatal("migration lost choices or cache precedence")
			}
			if _, err := os.Lstat(prefs.configFile); !os.IsNotExist(err) {
				t.Fatal("config JSON retained after successful migration")
			}
			doc, values, err := readPreferences(prefs.file)
			if err != nil || string(doc["extra"]) != `"keep"` || string(values["other"]) != "false" {
				t.Fatal("migration lost unknown fields")
			}
			if prefs.file != filepath.Join(cacheHome, "tuiline", "accounts", historyHash(account), "settings.json") {
				t.Fatal("settings are not under XDG_CACHE_HOME")
			}
			if accountPreferences(account, "").enabled("auto-images-off") != existing {
				t.Fatal("migrated choice did not survive reopening")
			}
		})
	}
}

func TestFailedConfigJSONMigrationRetainsSource(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	prefs := accountPreferences("u"+strings.Repeat("a", 43), "")
	if err := os.MkdirAll(filepath.Dir(prefs.configFile), 0700); err != nil {
		t.Fatal(err)
	}
	old := `{"version":1,"preferences":{"autoImages":false}}`
	if err := os.WriteFile(prefs.configFile, []byte(old), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(prefs.file, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if prefs.enabled("auto-images-off") || prefs.setEnabled("auto-images-off", true) {
		t.Fatal("failed migration discarded the old choice or overwrote unsafe settings")
	}
	if body, err := os.ReadFile(prefs.configFile); err != nil || string(body) != old {
		t.Fatal("failed migration changed config JSON")
	}
}
