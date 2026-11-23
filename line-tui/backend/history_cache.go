package gui

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Only decrypted message metadata is stored, never credentials or attachment bytes.
// Cache failures are non-fatal: the network remains the source of truth.
const historyFileLimit = 64 << 20
const historyBudget = 512 << 20

type historyCache struct {
	dir     string
	mu      sync.Mutex
	diskMu  sync.Mutex
	hot     map[string]*historyEntry
	pending map[string]*historyEntry
	running bool
	tick    uint64
}

type historyEntry struct {
	account, chat string
	rows          []Message
	info          os.FileInfo
	touched       uint64
	dirty         bool
}

func cloneHistory(rows []Message) []Message {
	out := append([]Message(nil), rows...)
	for i := range out {
		out[i].Reactions = append([]Reaction(nil), rows[i].Reactions...)
		if rows[i].Sticker != nil {
			sticker := *rows[i].Sticker
			out[i].Sticker = &sticker
		}
		if rows[i].Encrypted != nil {
			encrypted := *rows[i].Encrypted
			out[i].Encrypted = &encrypted
		}
	}
	return out
}

// Keep a small LRU of active chats, not an unbounded mirror of the disk cache.
func (c *historyCache) rememberLocked(entry *historyEntry) {
	if c.hot == nil {
		c.hot = map[string]*historyEntry{}
	}
	c.tick++
	entry.touched = c.tick
	c.hot[entry.chat] = entry
	for len(c.hot) > 8 {
		var oldest *historyEntry
		for _, candidate := range c.hot {
			if oldest == nil || candidate.touched < oldest.touched {
				oldest = candidate
			}
		}
		delete(c.hot, oldest.chat)
	}
}

type historyDocument struct {
	Version  int       `json:"version"`
	Account  string    `json:"account"`
	Chat     string    `json:"chat"`
	Messages []Message `json:"messages"`
}

func historyHash(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:])
}

func privateDir(path string) error {
	if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm() != 0700 {
		return errors.New("history cache directory is not private")
	}
	return nil
}

func openHistoryCache(root, account string) *historyCache {
	if root == "" || !fullID.MatchString(account) {
		return nil
	}
	// Do not follow symlinks or write into pre-existing publicly readable dirs.
	if privateDir(filepath.Dir(root)) != nil || privateDir(root) != nil {
		return nil
	}
	dir := filepath.Join(root, historyHash(account))
	if privateDir(dir) != nil {
		return nil
	}
	return &historyCache{dir: dir}
}

func (c *historyCache) path(chat string) string {
	return filepath.Join(c.dir, historyHash(chat)+".json")
}

func (c *historyCache) load(account, chat string) []Message {
	if c == nil || !fullID.MatchString(account) || !fullID.MatchString(chat) {
		return nil
	}
	file := c.path(chat)
	info, err := os.Lstat(file)
	if err != nil && !errors.Is(err, os.ErrNotExist) ||
		err == nil && (!info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > historyFileLimit) {
		return nil
	}
	c.mu.Lock()
	entry := c.pending[chat]
	if entry == nil {
		entry = c.hot[chat]
	}
	if entry != nil && entry.account == account && (entry.dirty ||
		entry.info != nil && info != nil && os.SameFile(entry.info, info) &&
			entry.info.Size() == info.Size() && entry.info.ModTime().Equal(info.ModTime())) {
		c.rememberLocked(entry)
		rows := cloneHistory(entry.rows)
		c.mu.Unlock()
		return rows
	}
	c.mu.Unlock()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(file)
	if err != nil || len(data) > historyFileLimit {
		return nil
	}
	var doc historyDocument
	if json.Unmarshal(data, &doc) != nil || doc.Version != 1 || doc.Account != account || doc.Chat != chat {
		return nil
	}
	seen := make(map[string]bool, len(doc.Messages))
	for _, m := range doc.Messages {
		if !numericID.MatchString(m.ID) || seen[m.ID] {
			return nil
		}
		seen[m.ID] = true
	}
	c.mu.Lock()
	c.rememberLocked(&historyEntry{account: account, chat: chat, rows: cloneHistory(doc.Messages), info: info})
	c.mu.Unlock()
	return doc.Messages
}

func sortedHistory(rows []Message) []Message {
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].Timestamp != rows[j].Timestamp {
			return rows[i].Timestamp < rows[j].Timestamp
		}
		return strings.Compare(rows[i].ID, rows[j].ID) < 0
	})
	return rows
}

// A complete short server page replaces the cache. A full page only proves
// that messages newer than its oldest item are current; older rows are kept.
// Concurrent watch/send messages are provided separately and win over the page.
func reconcileHistory(cached, fresh, concurrent []Message) []Message {
	merged := map[string]Message{}
	read := map[string]bool{}
	for _, m := range cached {
		if m.Read {
			read[m.ID] = true
		}
	}
	if len(fresh) >= 100 {
		oldest := int64(0)
		for _, m := range fresh {
			if oldest == 0 || m.Timestamp < oldest {
				oldest = m.Timestamp
			}
		}
		for _, m := range cached {
			if m.Timestamp < oldest {
				merged[m.ID] = m
			}
		}
	}
	for _, m := range fresh {
		if numericID.MatchString(m.ID) {
			m.Read = m.Read || read[m.ID]
			merged[m.ID] = m
		}
	}
	for _, m := range concurrent {
		if numericID.MatchString(m.ID) {
			merged[m.ID] = m
		}
	}
	rows := make([]Message, 0, len(merged))
	for _, m := range merged {
		rows = append(rows, m)
	}
	return sortedHistory(rows)
}

func (c *historyCache) save(account, chat string, rows []Message) {
	if c == nil {
		return
	}
	c.enqueue(account, chat, rows)
	c.flushPending()
}

func (c *historyCache) enqueue(account, chat string, rows []Message) bool {
	if c == nil || !fullID.MatchString(account) || !fullID.MatchString(chat) {
		return false
	}
	entry := &historyEntry{account: account, chat: chat, rows: cloneHistory(rows), dirty: true}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pending == nil {
		c.pending = map[string]*historyEntry{}
	}
	c.pending[chat] = entry
	c.rememberLocked(entry)
	if c.running {
		return false
	}
	c.running = true
	return true
}

// One ordered writer coalesces repeated snapshots of the same chat. No engine
// mutex is held during encoding, fsync, rename or pruning. Engine.Wait/Close
// drain this worker, so normal shutdown retains the existing durable snapshots.
func (c *historyCache) flushPending() {
	c.diskMu.Lock()
	defer c.diskMu.Unlock()
	for {
		c.mu.Lock()
		var entry *historyEntry
		for _, candidate := range c.pending {
			entry = candidate
			break
		}
		if entry == nil {
			c.running = false
			c.mu.Unlock()
			return
		}
		c.mu.Unlock()
		saved := c.saveDisk(entry.account, entry.chat, entry.rows)
		info, _ := os.Lstat(c.path(entry.chat))
		c.mu.Lock()
		entry.dirty, entry.info = false, info
		if !saved && c.hot[entry.chat] == entry {
			delete(c.hot, entry.chat)
		}
		if c.pending[entry.chat] == entry {
			delete(c.pending, entry.chat)
		}
		c.mu.Unlock()
	}
}

func (c *historyCache) saveDisk(account, chat string, rows []Message) bool {
	if c == nil || !fullID.MatchString(account) || !fullID.MatchString(chat) {
		return false
	}
	data, err := json.Marshal(historyDocument{Version: 1, Account: account, Chat: chat, Messages: rows})
	if err != nil || len(data) > historyFileLimit {
		return false
	}
	// Refuse to replace an unsafe pre-existing entry.
	if info, err := os.Lstat(c.path(chat)); err == nil && (!info.Mode().IsRegular() || info.Mode().Perm() != 0600) {
		return false
	}
	tmp, err := os.CreateTemp(c.dir, ".history-*")
	if err != nil {
		return false
	}
	defer os.Remove(tmp.Name())
	if tmp.Chmod(0600) != nil || func() error {
		if _, err := tmp.Write(data); err != nil {
			return err
		}
		if err := tmp.Sync(); err != nil {
			return err
		}
		return tmp.Close()
	}() != nil {
		tmp.Close()
		return false
	}
	if os.Rename(tmp.Name(), c.path(chat)) == nil {
		c.prune()
		return true
	}
	return false
}

func (c *historyCache) prune() {
	entries, err := os.ReadDir(c.dir)
	if err != nil {
		return
	}
	type entry struct {
		path string
		size int64
		mod  time.Time
	}
	files := []entry{}
	var total int64
	for _, item := range entries {
		if !strings.HasSuffix(item.Name(), ".json") || len(item.Name()) != 69 || item.Type() != 0 {
			continue
		}
		info, err := item.Info()
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
			continue
		}
		files = append(files, entry{filepath.Join(c.dir, item.Name()), info.Size(), info.ModTime()})
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i].mod.Before(files[j].mod) })
	for _, f := range files {
		if total <= historyBudget {
			break
		}
		if os.Remove(f.path) == nil {
			total -= f.size
		}
	}
}

func (e *Engine) cacheHistory(chat string, rows []Message) {
	if e.state.Mode == "live" && e.historyStore != nil {
		store := e.historyStore
		if store.enqueue(e.state.Account.ID, chat, rows) {
			e.spawn(store.flushPending)
		}
	}
}

func historyCacheDir() string {
	base, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	if err := os.MkdirAll(base, 0700); err != nil {
		return ""
	}
	return filepath.Join(base, "tuiline", "history")
}

func upsertHistory(rows []Message, item Message) []Message {
	if !numericID.MatchString(item.ID) {
		return rows
	}
	for i := range rows {
		if rows[i].ID == item.ID {
			rows[i] = item
			return rows
		}
	}
	at := sort.Search(len(rows), func(i int) bool {
		return rows[i].Timestamp > item.Timestamp ||
			rows[i].Timestamp == item.Timestamp && rows[i].ID >= item.ID
	})
	rows = append(rows, Message{})
	copy(rows[at+1:], rows[at:])
	rows[at] = item
	return rows
}

func removeHistory(rows []Message, id string) []Message {
	result := rows[:0]
	for _, m := range rows {
		if m.ID != id {
			result = append(result, m)
		}
	}
	return result
}

// Pages keep the backend bridge and terminal renderer bounded while the disk
// cache retains every message observed so far.
func (e *Engine) showHistoryPage() {
	end := min(e.historyEnd, len(e.historyCached))
	start := max(0, end-100)
	e.state.Messages = append([]Message{}, e.historyCached[start:end]...)
	e.state.HistoryOlder = start > 0
	e.state.HistoryNewer = end < len(e.historyCached)
}

func (e *Engine) pageHistory(direction int) {
	if e.state.Mode != "live" || e.historyStore == nil || e.state.SelectedID == "" || direction == 0 {
		return
	}
	if direction < 0 {
		e.historyEnd = max(1, e.historyEnd-100)
	} else {
		e.historyEnd = min(len(e.historyCached), e.historyEnd+100)
	}
	e.showHistoryPage()
}
