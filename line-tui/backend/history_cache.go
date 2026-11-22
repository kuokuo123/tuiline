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
	"time"
)

// Only decrypted message metadata is stored, never credentials or attachment bytes.
// Cache failures are non-fatal: the network remains the source of truth.
const historyFileLimit = 64 << 20
const historyBudget = 512 << 20

type historyCache struct{ dir string }

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
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > historyFileLimit {
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
	if c == nil || !fullID.MatchString(account) || !fullID.MatchString(chat) {
		return
	}
	data, err := json.Marshal(historyDocument{Version: 1, Account: account, Chat: chat, Messages: rows})
	if err != nil || len(data) > historyFileLimit {
		return
	}
	// Refuse to replace an unsafe pre-existing entry.
	if info, err := os.Lstat(c.path(chat)); err == nil && (!info.Mode().IsRegular() || info.Mode().Perm() != 0600) {
		return
	}
	tmp, err := os.CreateTemp(c.dir, ".history-*")
	if err != nil {
		return
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
		return
	}
	if os.Rename(tmp.Name(), c.path(chat)) == nil {
		c.prune()
	}
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
		e.historyStore.save(e.state.Account.ID, chat, rows)
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
	return sortedHistory(append(rows, item))
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
