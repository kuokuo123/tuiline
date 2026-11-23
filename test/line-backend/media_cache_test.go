package gui

import (
	"bytes"
	"context"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestMediaCacheReusesSanitizedAssetsAfterRestart(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tuiline", "media")
	account := "u" + strings.Repeat("a", 43)
	chat := "c" + strings.Repeat("c", 43)
	img := testMediaImage(t)
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(img, "data:image/png;base64,"))
	if err != nil {
		t.Fatal(err)
	}
	avatars, stickers, downloads := 0, 0, 0
	ops := Operations{
		FetchAvatar:  func(context.Context, string) string { avatars++; return img },
		FetchSticker: func(context.Context, Sticker) string { stickers++; return img },
		Download:     func(context.Context, string, string) ([]byte, error) { downloads++; return bytes.Clone(raw), nil },
	}
	run := func() {
		e := NewEngine(ops, nil)
		e.mu.Lock()
		e.mediaStore = openMediaCache(root, account)
		e.state.Account = Account{ID: account}
		e.state.Status = "ready"
		e.state.SelectedID = chat
		e.state.Chats = []Chat{{ID: chat}}
		e.picturePaths[account] = "portrait/v1"
		e.state.Messages = []Message{
			{ID: "10", ContentType: 1, Downloadable: true},
			{ID: "11", Sticker: &Sticker{ID: "1001", PackageID: "1", Version: "1"}},
		}
		e.syncAvatars(false)
		e.syncStickerImages()
		e.mu.Unlock()
		e.Wait()
		v := e.View()
		e.Handle(Command{Action: "photos-visible", ID: chat, Session: v.Session, Selection: v.Selection, MessageIDs: []string{"10"}})
		e.Wait()
		if e.View().PhotoThumbnails["10"].Status != "ready" {
			t.Fatal("thumbnail unavailable")
		}
		e.Handle(Command{Action: "preview", ID: chat, Session: v.Session, Selection: v.Selection, MessageID: "10"})
		e.Wait()
		if e.View().Preview == "" {
			t.Fatal("preview unavailable")
		}
		e.Close()
	}
	run()
	if avatars != 1 || stickers != 1 || downloads != 2 {
		t.Fatalf("unexpected first requests: %d %d %d", avatars, stickers, downloads)
	}
	run()
	if avatars != 1 || stickers != 1 || downloads != 2 {
		t.Fatalf("cache miss after restart: %d %d %d", avatars, stickers, downloads)
	}
	if !openMediaCache(root, account).setEnabled(false) {
		t.Fatal("cannot disable cache")
	}
	run()
	if avatars != 2 || stickers != 2 || downloads != 4 {
		t.Fatalf("disabled cache reused disk: %d %d %d", avatars, stickers, downloads)
	}
}

func testMediaImage(t *testing.T) string {
	t.Helper()
	var buf bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	img.Set(0, 0, color.White)
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buf.Bytes())
}

func TestMediaCacheRestartIsolationAndControls(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tuiline", "media")
	account := "u" + strings.Repeat("a", 43)
	other := "u" + strings.Repeat("b", 43)
	cache := openMediaCache(root, account)
	if cache == nil {
		t.Fatal("could not create cache")
	}
	if !cache.autoImages() || !cache.setAutoImages(false) || openMediaCache(root, account).autoImages() ||
		!openMediaCache(root, other).autoImages() {
		t.Fatal("automatic image preference was not saved per account")
	}
	img := testMediaImage(t)
	cache.save("avatar", "picture/v1", img)
	cache.saveCatalog([]OwnedProduct{{ID: "1", Version: "1", ResourceType: 1, Ranges: []OwnedRange{{Start: "1001", Size: 1}}, Count: 1}})
	if len(openMediaCache(root, account).loadCatalog()) != 1 {
		t.Fatal("sticker catalog not retained")
	}
	if got := openMediaCache(root, account).load("avatar", "picture/v1"); got != img {
		t.Fatal("avatar did not survive restart")
	}
	if openMediaCache(root, other).load("avatar", "picture/v1") != "" || cache.load("avatar", "picture/v2") != "" {
		t.Fatal("account or version crossed cache boundary")
	}
	if info, err := os.Stat(cache.path("avatar", "picture/v1")); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("unsafe file permissions: %v %v", info, err)
	}
	if !cache.setEnabled(false) || openMediaCache(root, account).active() || cache.load("avatar", "picture/v1") != "" {
		t.Fatal("disable not persistent")
	}
	if cache.autoImages() {
		t.Fatal("disabling disk cache changed automatic image preference")
	}
	cache.save("sticker", "other", img)
	if !cache.setEnabled(true) || cache.load("avatar", "picture/v1") != img {
		t.Fatal("enable failed")
	}
	cache.clear()
	if cache.load("avatar", "picture/v1") != "" || cache.usage() != 0 || len(cache.loadCatalog()) != 0 {
		t.Fatal("clear left media behind")
	}
	if cache.autoImages() || !cache.setAutoImages(true) || !openMediaCache(root, account).autoImages() {
		t.Fatal("media clear discarded the image preview preference")
	}
}

func TestMediaCacheRejectsCorruptionUnsafeFilesAndExpiry(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tuiline", "media")
	account := "u" + strings.Repeat("a", 43)
	cache := openMediaCache(root, account)
	img := testMediaImage(t)
	cache.save("thumbnail", "chat:123", img)
	path := cache.path("thumbnail", "chat:123")
	if err := os.Chtimes(path, time.Now().Add(-91*24*time.Hour), time.Now().Add(-91*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if cache.load("thumbnail", "chat:123") != "" {
		t.Fatal("expired thumbnail served")
	}
	cache.save("thumbnail", "chat:123", img)
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if cache.load("thumbnail", "chat:123") != "" {
		t.Fatal("corrupt media served")
	}
	cache.save("thumbnail", "chat:123", img)
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	cache.save("thumbnail", "chat:123", img)
	if cache.load("thumbnail", "chat:123") != "" {
		t.Fatal("unsafe media served")
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(cache.dir, link); err != nil {
		t.Fatal(err)
	}
	if openMediaCache(link, account) != nil {
		t.Fatal("followed cache symlink")
	}
	if mediaValid("preview", "data:image/png;base64,YQ==") || mediaValid("video", img) {
		t.Fatal("invalid media accepted")
	}
	unsafeRoot := filepath.Join(t.TempDir(), "public", "media")
	if err := os.Mkdir(filepath.Dir(unsafeRoot), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Dir(unsafeRoot), 0755); err != nil {
		t.Fatal(err)
	}
	if openMediaCache(unsafeRoot, account) != nil {
		t.Fatal("accepted publicly readable cache directory")
	}
}

func TestMediaCacheEvictsLeastRecentlyUsed(t *testing.T) {
	t.Setenv("TUILINE_MEDIA_CACHE_MB", "1")
	root := filepath.Join(t.TempDir(), "tuiline", "media")
	account := "u" + strings.Repeat("a", 43)
	cache := openMediaCache(root, account)
	for i, key := range []string{"old", "new"} {
		path := cache.path("sticker", key)
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0600)
		if err != nil {
			t.Fatal(err)
		}
		if err = f.Truncate(800 << 10); err != nil {
			t.Fatal(err)
		}
		if err = f.Close(); err != nil {
			t.Fatal(err)
		}
		at := time.Now().Add(time.Duration(i-2) * time.Hour)
		if err = os.Chtimes(path, at, at); err != nil {
			t.Fatal(err)
		}
	}
	reopened := openMediaCache(root, account)
	if _, err := os.Stat(reopened.path("sticker", "old")); !os.IsNotExist(err) {
		t.Fatalf("oldest entry survived eviction: %v", err)
	}
	if _, err := os.Stat(reopened.path("sticker", "new")); err != nil {
		t.Fatalf("newest entry evicted: %v", err)
	}
}

func TestMediaCacheIncrementalUsageAndPeriodicReconciliation(t *testing.T) {
	cache := openMediaCache(filepath.Join(t.TempDir(), "tuiline", "media"), "u"+strings.Repeat("a", 43))
	img := testMediaImage(t)
	initialScan := cache.scannedAt
	cache.save("thumbnail", "one", img)
	cache.save("thumbnail", "two", img)
	cache.save("thumbnail", "one", img)
	var expected int64
	for _, f := range cache.filesLocked() {
		expected += f.size
	}
	if cache.usage() != expected || !cache.scannedAt.Equal(initialScan) {
		t.Fatal("ordinary saves/usage rescanned the directory or miscounted replacements")
	}
	cache.remove("thumbnail", "one")
	expected = 0
	for _, f := range cache.filesLocked() {
		expected += f.size
	}
	if cache.usage() != expected {
		t.Fatal("removal did not decrement usage")
	}
	external := cache.path("thumbnail", "external")
	if err := os.WriteFile(external, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	cache.scannedAt = time.Now().Add(-2 * time.Minute)
	if cache.usage() != expected+2 {
		t.Fatal("external cache changes were not reconciled")
	}
	cache.clear()
	if cache.usage() != 0 || len(cache.index) != 0 {
		t.Fatal("clear retained indexed bytes")
	}
}

func BenchmarkMediaCacheUsage(b *testing.B) {
	cache := openMediaCache(filepath.Join(b.TempDir(), "tuiline", "media"), "u"+strings.Repeat("a", 43))
	for i := 0; i < 1000; i++ {
		if err := os.WriteFile(cache.path("thumbnail", strconv.Itoa(i)), []byte("{}"), 0600); err != nil {
			b.Fatal(err)
		}
	}
	cache.reconcileLocked()
	b.Run("directory-scan", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			var total int64
			for _, f := range cache.filesLocked() {
				total += f.size
			}
			if total == 0 {
				b.Fatal("missing fixtures")
			}
		}
	})
	b.Run("incremental", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			if cache.usage() == 0 {
				b.Fatal("missing fixtures")
			}
		}
	})
}

func TestStickerCatalogShowsCacheThenRefreshes(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tuiline", "media")
	account := "u" + strings.Repeat("a", 43)
	chat := "c" + strings.Repeat("c", 43)
	store := openMediaCache(root, account)
	old := OwnedProduct{ID: "1", Name: "Old pack", Version: "1", ResourceType: 1, Ranges: []OwnedRange{{Start: "1001", Size: 1}}, Count: 1}
	newPack := OwnedProduct{ID: "2", Name: "New pack", Version: "2", ResourceType: 1, Ranges: []OwnedRange{{Start: "2001", Size: 1}}, Count: 1}
	store.saveCatalog([]OwnedProduct{old})
	gate := make(chan struct{})
	e := NewEngine(Operations{
		Catalog:      func(context.Context) ([]OwnedProduct, error) { <-gate; return []OwnedProduct{newPack}, nil },
		FetchSticker: func(context.Context, Sticker) string { return "" },
	}, nil)
	e.mu.Lock()
	e.mediaStore = store
	e.state.Account.ID = account
	e.state.Status = "ready"
	e.state.SelectedID = chat
	e.state.Chats = []Chat{{ID: chat}}
	e.mu.Unlock()
	v := e.View()
	e.Handle(Command{Action: "sticker-open", ID: chat, Session: v.Session, Selection: v.Selection})
	loading := e.View().Stickers
	if loading.Status != "loading" || len(loading.Products) != 1 || loading.Products[0].Name != "Old pack" {
		t.Fatalf("cached catalog not displayed while loading: %+v", loading)
	}
	close(gate)
	e.Wait()
	fresh := e.View().Stickers
	if fresh.Status != "ready" || len(fresh.Products) != 1 || fresh.Products[0].Name != "New pack" ||
		len(store.loadCatalog()) != 1 || store.loadCatalog()[0].ID != "2" {
		t.Fatalf("catalog not refreshed: %+v", fresh)
	}
	e.Close()
}

func TestDeletedMessagePurgesSavedPreviews(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tuiline", "media")
	account := "u" + strings.Repeat("a", 43)
	chat := "c" + strings.Repeat("c", 43)
	cache := openMediaCache(root, account)
	key := mediaPhotoKey(chat, "123")
	img := testMediaImage(t)
	cache.save("thumbnail", key, img)
	cache.save("preview", key, img)
	e := NewEngine(Operations{}, nil)
	e.mediaStore = cache
	e.purgeRemovedPhotos(chat, []Message{{ID: "123", ContentType: 1}}, nil)
	if cache.load("thumbnail", key) != "" || cache.load("preview", key) != "" {
		t.Fatal("removed photo remained cached")
	}
	e.Close()
}

func TestAutoImagesToggleControlsThumbnailDownloads(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tuiline", "media")
	account := "u" + strings.Repeat("a", 43)
	chat := "c" + strings.Repeat("c", 43)
	img := testMediaImage(t)
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(img, "data:image/png;base64,"))
	if err != nil {
		t.Fatal(err)
	}
	var calls int
	e := NewEngine(Operations{Download: func(context.Context, string, string) ([]byte, error) {
		calls++
		return bytes.Clone(raw), nil
	}}, nil)
	e.mu.Lock()
	e.mediaStore = openMediaCache(root, account)
	e.state.Account.ID = account
	e.state.Status = "ready"
	e.state.SelectedID = chat
	e.state.Chats = []Chat{{ID: chat}}
	e.state.Messages = []Message{{ID: "123", ContentType: 1, Downloadable: true}}
	e.mu.Unlock()
	v := e.View()
	e.Handle(Command{Action: "auto-images", Enabled: false})
	if e.View().AutoImages || openMediaCache(root, account).autoImages() {
		t.Fatal("automatic images did not turn off")
	}
	e.Handle(Command{Action: "photos-visible", ID: chat, Session: v.Session, Selection: v.Selection, MessageIDs: []string{"123"}})
	e.Wait()
	if calls != 0 {
		t.Fatal("disabled automatic images started a download")
	}
	e.Handle(Command{Action: "auto-images", Enabled: true})
	e.Handle(Command{Action: "photos-visible", ID: chat, Session: v.Session, Selection: v.Selection, MessageIDs: []string{"123"}})
	e.Wait()
	if calls != 1 || e.View().PhotoThumbnails["123"].Status != "ready" ||
		!openMediaCache(root, account).autoImages() {
		t.Fatalf("enabled automatic images did not load thumbnail: %d", calls)
	}
	e.Close()
}

func TestThumbnailErrorRetriesWhenItReentersViewport(t *testing.T) {
	root := filepath.Join(t.TempDir(), "media")
	account := "u" + strings.Repeat("a", 43)
	chat := "c" + strings.Repeat("c", 43)
	img := testMediaImage(t)
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(img, "data:image/png;base64,"))
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	e := NewEngine(Operations{Download: func(context.Context, string, string) ([]byte, error) {
		calls++
		return bytes.Clone(raw), nil
	}}, nil)
	e.mu.Lock()
	e.mediaStore = openMediaCache(root, account)
	e.state.Account.ID = account
	e.state.SelectedID = chat
	e.state.Status = "ready"
	e.state.Messages = []Message{{ID: "123", ContentType: 1, Downloadable: true}}
	e.resetPhotos()
	e.setPhoto("123", PhotoThumbnail{Status: "error"})
	e.photoVisible = map[string]bool{"123": true}
	e.mu.Unlock()
	v := e.View()
	visible := Command{Action: "photos-visible", ID: chat, Session: v.Session, Selection: v.Selection, MessageIDs: []string{"123"}}
	e.Handle(visible)
	e.Wait()
	if calls != 0 {
		t.Fatal("repeated viewport update retried a failing thumbnail")
	}
	visible.MessageIDs = nil
	e.Handle(visible)
	visible.MessageIDs = []string{"123"}
	e.Handle(visible)
	e.Wait()
	if calls != 1 || e.View().PhotoThumbnails["123"].Status != "ready" {
		t.Fatalf("thumbnail was not retried on viewport reentry: %d", calls)
	}
	e.Close()
}

func TestClearingCachePreventsInFlightThumbnailFromBeingSaved(t *testing.T) {
	root := filepath.Join(t.TempDir(), "media")
	account := "u" + strings.Repeat("a", 43)
	chat := "c" + strings.Repeat("c", 43)
	img := testMediaImage(t)
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(img, "data:image/png;base64,"))
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	e := NewEngine(Operations{Download: func(context.Context, string, string) ([]byte, error) {
		close(started)
		<-release
		return bytes.Clone(raw), nil
	}}, nil)
	e.mu.Lock()
	cache := openMediaCache(root, account)
	e.mediaStore = cache
	e.state.Account.ID = account
	e.state.SelectedID = chat
	e.state.Status = "ready"
	e.state.Messages = []Message{{ID: "123", ContentType: 1, Downloadable: true}}
	e.mu.Unlock()
	v := e.View()
	e.Handle(Command{Action: "photos-visible", ID: chat, Session: v.Session, Selection: v.Selection, MessageIDs: []string{"123"}})
	<-started
	e.Handle(Command{Action: "media-cache-clear"})
	close(release)
	e.Wait()
	if cache.load("thumbnail", mediaPhotoKey(chat, "123")) != "" || cache.usage() != 0 {
		t.Fatal("a download repopulated the cleared media cache")
	}
	if e.View().PhotoThumbnails["123"].Status != "ready" {
		t.Fatal("clearing disk cache should not prevent the image from displaying in memory")
	}
	e.Close()
}
