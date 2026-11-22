package gui

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestHistoryCacheEngineRestartAndPaging(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tuiline", "history")
	account := "u" + strings.Repeat("a", 43)
	chat := "c" + strings.Repeat("c", 43)
	rows := make([]Message, 150)
	for i := range rows {
		rows[i] = Message{ID: strconv.Itoa(i + 1), Timestamp: int64(i + 1), Text: "stored"}
	}
	store := openHistoryCache(root, account)
	store.save(account, chat, rows)
	ops := Operations{
		CacheDir: root,
		Snapshot: func(context.Context) (Snapshot, error) {
			return Snapshot{Account: Account{ID: account}, Chats: []Chat{{ID: chat}}, Pictures: map[string]string{}}, nil
		},
		History: func(context.Context, string) ([]Message, error) {
			return rows[50:], nil
		},
	}
	e := NewEngine(ops, nil)
	e.Handle(Command{Action: "refresh"})
	e.Wait()
	e.Handle(Command{Action: "select", ID: chat})
	before := e.View()
	if len(before.Messages) != 100 || before.Messages[0].ID != "51" || !before.HistoryOlder {
		t.Fatalf("cache not displayed before server: %+v", before.Messages)
	}
	e.Wait()
	e.Handle(Command{Action: "history-older"})
	older := e.View()
	if len(older.Messages) != 50 || older.Messages[0].ID != "1" || !older.HistoryNewer {
		t.Fatalf("older page missing: %+v", older.Messages)
	}
	e.Close()
	if got := openHistoryCache(root, account).load(account, chat); len(got) != 150 {
		t.Fatalf("lost saved history after restart: %d", len(got))
	}
}

func TestHistoryCacheAccountAndCorruption(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tuiline", "history")
	a, b := "u"+strings.Repeat("a", 43), "u"+strings.Repeat("b", 43)
	chat := "c" + strings.Repeat("c", 43)
	first := openHistoryCache(root, a)
	if first == nil {
		t.Fatal("could not create private cache")
	}
	first.save(a, chat, []Message{{ID: "1", Text: "private"}})
	if rows := openHistoryCache(root, a).load(a, chat); len(rows) != 1 || rows[0].Text != "private" {
		t.Fatalf("restart: %+v", rows)
	}
	if rows := openHistoryCache(root, b).load(b, chat); len(rows) != 0 {
		t.Fatalf("cross-account leak: %+v", rows)
	}
	if info, err := os.Stat(first.path(chat)); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("file permissions: %v %v", info, err)
	}
	if err := os.WriteFile(first.path(chat), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if len(first.load(a, chat)) != 0 {
		t.Fatal("accepted corrupted cache")
	}
	first.save(a, chat, []Message{{ID: "2", Text: "recovered"}})
	if rows := first.load(a, chat); len(rows) != 1 || rows[0].ID != "2" {
		t.Fatalf("did not recover: %+v", rows)
	}
	if err := os.Chmod(first.path(chat), 0644); err != nil {
		t.Fatal(err)
	}
	if len(first.load(a, chat)) != 0 {
		t.Fatal("loaded publicly readable cache")
	}
	first.save(a, chat, []Message{{ID: "3"}})
	if rows := first.load(a, chat); len(rows) != 0 {
		t.Fatalf("overwrote unsafe file: %+v", rows)
	}
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(first.dir, link); err != nil {
		t.Fatal(err)
	}
	if openHistoryCache(link, a) != nil {
		t.Fatal("followed cache symlink")
	}
}

func TestHistoryReconciliation(t *testing.T) {
	old := []Message{{ID: "1", Timestamp: 1}, {ID: "2", Timestamp: 2, Text: "stale", Read: true}}
	short := reconcileHistory(old, []Message{{ID: "2", Timestamp: 2, Text: "edited"}}, nil)
	if len(short) != 1 || short[0].Text != "edited" || !short[0].Read {
		t.Fatalf("short server page did not remove deleted data: %+v", short)
	}
	full := make([]Message, 100)
	for i := range full {
		full[i] = Message{ID: strconv.Itoa(i + 3), Timestamp: int64(i + 3)}
	}
	rows := reconcileHistory(old, full, []Message{{ID: "999", Timestamp: 200}})
	if len(rows) != 103 || rows[0].ID != "1" || rows[len(rows)-1].ID != "999" {
		t.Fatalf("full page did not preserve older and concurrent messages: %d", len(rows))
	}
}

func TestHistoryCacheLiveUpdatesAndUnsend(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tuiline", "history")
	account := "u" + strings.Repeat("a", 43)
	chat := "c" + strings.Repeat("c", 43)
	store := openHistoryCache(root, account)
	e := NewEngine(Operations{}, nil)
	e.mu.Lock()
	e.state.Account.ID = account
	e.state.Status = "ready"
	e.state.SelectedID = chat
	e.state.Chats = []Chat{{ID: chat}}
	e.historyStore = store
	e.watchEvent(WatchEvent{Kind: "message", ChatID: chat, Revision: "1", Message: &Message{ID: "10", Text: "received", Timestamp: 10}})
	e.sentMessage(chat, Message{ID: "11", Text: "sent", Timestamp: 11})
	e.mu.Unlock()
	if rows := store.load(account, chat); len(rows) != 2 || rows[0].ID != "10" || rows[1].ID != "11" {
		t.Fatalf("live messages not saved: %+v", rows)
	}
	store.save(account, chat, removeHistory(store.load(account, chat), "10"))
	if rows := store.load(account, chat); len(rows) != 1 || rows[0].ID != "11" {
		t.Fatalf("unsend not persisted: %+v", rows)
	}
	e.Close()
}
