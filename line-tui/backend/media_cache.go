package gui

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultMediaBudget int64 = 512 << 20
const mediaEntryLimit = 3 << 20
const mediaLifetime = 90 * 24 * time.Hour

type mediaCache struct {
	mu      sync.Mutex
	dir     string
	enabled bool
	budget  int64
	version uint64
}

type mediaDocument struct {
	Version int    `json:"version"`
	Kind    string `json:"kind"`
	Key     string `json:"key"`
	Data    string `json:"data"`
}

type catalogDocument struct {
	Version  int            `json:"version"`
	Products []OwnedProduct `json:"products"`
}

func mediaCacheDir() string {
	base, err := os.UserCacheDir()
	if err != nil || os.MkdirAll(base, 0700) != nil {
		return ""
	}
	return filepath.Join(base, "tuiline", "media")
}

func openMediaCache(root, account string) *mediaCache {
	if root == "" || !fullID.MatchString(account) ||
		privateDir(filepath.Dir(root)) != nil || privateDir(root) != nil {
		return nil
	}
	dir := filepath.Join(root, historyHash(account))
	if privateDir(dir) != nil {
		return nil
	}
	c := &mediaCache{dir: dir, enabled: true, budget: defaultMediaBudget}
	if configured, err := strconv.ParseInt(os.Getenv("TUILINE_MEDIA_CACHE_MB"), 10, 64); err == nil && configured >= 1 && configured <= 2048 {
		c.budget = configured << 20
	}
	if info, err := os.Lstat(filepath.Join(dir, "disabled")); err == nil && info.Mode().IsRegular() && info.Mode().Perm() == 0600 {
		c.enabled = false
	}
	c.pruneLocked()
	return c
}

func mediaValid(kind, data string) bool {
	maxBytes, maxPixels := 65536, 512
	switch kind {
	case "avatar", "sticker", "thumbnail":
	case "preview":
		maxBytes, maxPixels = 2<<20, 4096
	default:
		return false
	}
	prefix, encoded, ok := strings.Cut(data, ",")
	if !ok || prefix != "data:image/png;base64" && prefix != "data:image/jpeg;base64" ||
		len(encoded) > base64.StdEncoding.EncodedLen(maxBytes) {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw) == 0 || len(raw) > maxBytes {
		return false
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(raw))
	if err != nil || cfg.Width < 1 || cfg.Height < 1 || cfg.Width > maxPixels || cfg.Height > maxPixels ||
		!(format == "png" && prefix == "data:image/png;base64" || format == "jpeg" && prefix == "data:image/jpeg;base64") {
		return false
	}
	_, decoded, err := image.Decode(bytes.NewReader(raw))
	return err == nil && decoded == format
}

func (c *mediaCache) path(kind, key string) string {
	digest := sha256.Sum256([]byte(kind + ":" + key))
	return filepath.Join(c.dir, hex.EncodeToString(digest[:])+".json")
}

func (c *mediaCache) load(kind, key string) string {
	if c == nil || len(key) == 0 || len(key) > 4096 {
		return ""
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.enabled {
		return ""
	}
	path := c.path(kind, key)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 ||
		info.Size() < 1 || info.Size() > mediaEntryLimit || time.Since(info.ModTime()) > mediaLifetime {
		return ""
	}
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > mediaEntryLimit {
		return ""
	}
	var doc mediaDocument
	if json.Unmarshal(raw, &doc) != nil || doc.Version != 1 || doc.Kind != kind || doc.Key != key || !mediaValid(kind, doc.Data) {
		return ""
	}
	now := time.Now()
	_ = os.Chtimes(path, now, now)
	return doc.Data
}

// A worker captures the version before starting a download. Clearing the cache
// invalidates that worker's write, even if it finishes after the clear.
func (c *mediaCache) writeVersion() uint64 {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.version
}

func (c *mediaCache) save(kind, key, data string) {
	c.saveVersion(kind, key, data, c.writeVersion())
}

func (c *mediaCache) saveVersion(kind, key, data string, version uint64) {
	if c == nil || len(key) == 0 || len(key) > 4096 || !mediaValid(kind, data) {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.enabled || c.version != version {
		return
	}
	body, err := json.Marshal(mediaDocument{Version: 1, Kind: kind, Key: key, Data: data})
	if err != nil || len(body) > mediaEntryLimit {
		return
	}
	path := c.path(kind, key)
	if info, err := os.Lstat(path); err == nil && (!info.Mode().IsRegular() || info.Mode().Perm() != 0600) {
		return
	}
	tmp, err := os.CreateTemp(c.dir, ".media-*")
	if err != nil {
		return
	}
	defer os.Remove(tmp.Name())
	if tmp.Chmod(0600) != nil {
		tmp.Close()
		return
	}
	if _, err = tmp.Write(body); err != nil {
		tmp.Close()
		return
	}
	err = tmp.Sync()
	closeErr := tmp.Close()
	if err != nil || closeErr != nil {
		return
	}
	if os.Rename(tmp.Name(), path) == nil {
		c.pruneLocked()
	}
}

func (c *mediaCache) remove(kind, key string) {
	if c == nil || key == "" || len(key) > 4096 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	path := c.path(kind, key)
	if info, err := os.Lstat(path); err == nil && info.Mode().IsRegular() {
		_ = os.Remove(path)
	}
}

// Catalog entries are only used as a read-only loading preview. Sending still
// waits for a successful, validated server refresh.
func (c *mediaCache) loadCatalog() []OwnedProduct {
	if c == nil || !c.active() {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	path := filepath.Join(c.dir, "catalog.json")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 ||
		info.Size() > 1<<20 || time.Since(info.ModTime()) > 24*time.Hour {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > 1<<20 {
		return nil
	}
	var doc catalogDocument
	if json.Unmarshal(raw, &doc) != nil || doc.Version != 1 || len(doc.Products) > 500 {
		return nil
	}
	seen := map[string]bool{}
	for _, p := range doc.Products {
		if !validProduct(p) || seen[p.ID] {
			return nil
		}
		seen[p.ID] = true
	}
	return doc.Products
}

func (c *mediaCache) saveCatalog(products []OwnedProduct) {
	c.saveCatalogVersion(products, c.writeVersion())
}

func (c *mediaCache) saveCatalogVersion(products []OwnedProduct, version uint64) {
	if c == nil || len(products) > 500 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.enabled || c.version != version {
		return
	}
	path := filepath.Join(c.dir, "catalog.json")
	if info, err := os.Lstat(path); err == nil && (!info.Mode().IsRegular() || info.Mode().Perm() != 0600) {
		return
	}
	body, err := json.Marshal(catalogDocument{Version: 1, Products: products})
	if err != nil || len(body) > 1<<20 {
		return
	}
	tmp, err := os.CreateTemp(c.dir, ".catalog-*")
	if err != nil {
		return
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(body); err != nil {
		tmp.Close()
		return
	}
	err = tmp.Sync()
	closeErr := tmp.Close()
	if err == nil && closeErr == nil {
		_ = os.Rename(tmp.Name(), path)
	}
}

func (c *mediaCache) setEnabled(enabled bool) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	flag := filepath.Join(c.dir, "disabled")
	if enabled {
		if err := os.Remove(flag); err != nil && !errors.Is(err, os.ErrNotExist) {
			return false
		}
	} else {
		if info, err := os.Lstat(flag); err == nil && (!info.Mode().IsRegular() || info.Mode().Perm() != 0600) {
			return false
		}
		f, err := os.OpenFile(flag, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
		if err != nil {
			return false
		}
		if err := f.Close(); err != nil {
			return false
		}
	}
	c.enabled = enabled
	return true
}

func (c *mediaCache) active() bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.enabled
}

// Automatic thumbnails are a viewing preference, independent of whether disk
// caching is enabled. A missing setting means enabled.
func (c *mediaCache) autoImages() bool {
	if c == nil {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	path := filepath.Join(c.dir, "auto-images-off")
	info, err := os.Lstat(path)
	return err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600
}

func (c *mediaCache) setAutoImages(enabled bool) bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	path := filepath.Join(c.dir, "auto-images-off")
	if enabled {
		err := os.Remove(path)
		return err == nil || errors.Is(err, os.ErrNotExist)
	}
	if info, err := os.Lstat(path); err == nil && (!info.Mode().IsRegular() || info.Mode().Perm() != 0600) {
		return false
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
	if err != nil {
		return false
	}
	return f.Close() == nil
}

func (c *mediaCache) clear() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.version++
	for _, file := range c.filesLocked() {
		_ = os.Remove(file.path)
	}
	_ = os.Remove(filepath.Join(c.dir, "catalog.json"))
}

type cachedFile struct {
	path string
	size int64
	mod  time.Time
}

func (c *mediaCache) filesLocked() []cachedFile {
	entries, err := os.ReadDir(c.dir)
	if err != nil {
		return nil
	}
	files := []cachedFile{}
	for _, entry := range entries {
		name := entry.Name()
		if len(name) != 69 || !strings.HasSuffix(name, ".json") || entry.Type() != 0 {
			continue
		}
		if _, err := hex.DecodeString(strings.TrimSuffix(name, ".json")); err != nil {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
			continue
		}
		files = append(files, cachedFile{filepath.Join(c.dir, name), info.Size(), info.ModTime()})
	}
	return files
}

func (c *mediaCache) usage() int64 {
	if c == nil {
		return 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	var size int64
	for _, f := range c.filesLocked() {
		size += f.size
	}
	return size
}

func (c *mediaCache) pruneLocked() {
	files := c.filesLocked()
	var total int64
	for _, f := range files {
		if time.Since(f.mod) > mediaLifetime || f.size > mediaEntryLimit {
			_ = os.Remove(f.path)
		} else {
			total += f.size
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for _, f := range files {
		if total <= c.budget {
			break
		}
		if time.Since(f.mod) <= mediaLifetime && f.size <= mediaEntryLimit && os.Remove(f.path) == nil {
			total -= f.size
		}
	}
}

func mediaStickerKey(s Sticker) string {
	return s.PackageID + ":" + s.ID + ":" + s.Version + ":" + s.Hash
}

func mediaPhotoKey(chat, message string) string {
	if !fullID.MatchString(chat) || !numericID.MatchString(message) {
		return ""
	}
	return chat + ":" + message
}

func (e *Engine) mediaControl(action string) {
	if e.state.Mode != "live" || e.state.Account.ID == "" || e.mediaStore == nil {
		return
	}
	if action == "media-cache-toggle" {
		if !e.mediaStore.setEnabled(!e.mediaStore.active()) {
			e.state.SendNote = "Media cache setting could not be saved"
			return
		}
		if e.mediaStore.active() {
			e.state.SendNote = "Media cache enabled"
		} else {
			e.state.SendNote = "Media cache disabled"
		}
	} else {
		e.mediaStore.clear()
		e.state.SendNote = "Saved media cache cleared"
	}
	e.state.MediaCacheEnabled = e.mediaStore.active()
	e.state.MediaCacheBytes = e.mediaStore.usage()
}

func (e *Engine) purgeRemovedPhotos(chat string, before, after []Message) {
	if e.mediaStore == nil {
		return
	}
	present := make(map[string]bool, len(after))
	for _, m := range after {
		present[m.ID] = true
	}
	for _, m := range before {
		if m.ContentType != 1 || present[m.ID] {
			continue
		}
		key := mediaPhotoKey(chat, m.ID)
		e.mediaStore.remove("thumbnail", key)
		e.mediaStore.remove("preview", key)
	}
}

func (e *Engine) invalidateChangedStickers(fresh []OwnedProduct) {
	old := make(map[string]string, len(e.products))
	for _, p := range e.products {
		old[p.ID] = p.Version + ":" + p.Hash
	}
	changed := false
	for _, p := range fresh {
		if previous, ok := old[p.ID]; ok && previous != p.Version+":"+p.Hash {
			changed = true
			break
		}
	}
	if !changed {
		return
	}
	if e.stickerCancel != nil {
		e.stickerCancel()
	}
	e.stickerCtx, e.stickerCancel = context.WithCancel(e.resourceCtx)
	e.stickerGeneration++
	e.stickerActive = 0
	e.stickerAttempted = map[string]bool{}
	e.stickerData = map[string]string{}
	e.state.StickerImages = map[string]string{}
}
