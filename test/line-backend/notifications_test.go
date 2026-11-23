package gui

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDesktopNotificationHelper(t *testing.T) {
	for _, tc := range []struct {
		name, script, want string
	}{
		{"success", "#!/bin/sh\nexit 0\n", ""},
		{"failure", "#!/bin/sh\necho 'Cannot connect to desktop session bus' >&2\nexit 1\n", "session bus"},
		{"missing", "", "not found in PATH"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("PATH", dir)
			if tc.script != "" {
				if err := os.WriteFile(filepath.Join(dir, "notify-send"), []byte(tc.script), 0700); err != nil {
					t.Fatal(err)
				}
			}
			note := desktopNotification(context.Background(), "Sender", "Private message")
			if tc.want == "" && note != "" || tc.want != "" && !strings.Contains(note, tc.want) {
				t.Fatalf("unexpected diagnostic: %q", note)
			}
		})
	}
}

func waitNotificationNote(t *testing.T, e *Engine, want string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(e.View().NotificationNote, want) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("missing diagnostic %q: %q", want, e.View().NotificationNote)
}

func TestLiveIncomingMessageNotificationFailureIsReported(t *testing.T) {
	chat := "u" + strings.Repeat("b", 43)
	delivered := make(chan [2]string, 1)
	e := NewEngine(Operations{NotifyDiagnostic: func(_ context.Context, title, body string) string {
		delivered <- [2]string{title, body}
		return "Notifications: desktop bus unavailable"
	}}, nil)
	defer e.Close()
	e.mu.Lock()
	e.locale = "zh-TW"
	e.noticeDelay = time.Millisecond
	e.state.Status = "ready"
	e.state.SelectedID = chat
	e.state.Chats = []Chat{{ID: chat}}
	e.watchEvent(WatchEvent{Kind: "message", Revision: "1", ChatID: chat, Message: &Message{
		ID: "123", Sender: "Alice", Text: "New message", Timestamp: time.Now().UnixMilli(),
	}})
	e.mu.Unlock()
	select {
	case got := <-delivered:
		if got != [2]string{"Alice", "New message"} {
			t.Fatalf("unexpected notification: %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("selected-chat message did not reach notification delivery")
	}
	waitNotificationNote(t, e, "desktop bus unavailable")
}

func TestManualNotificationTestDoesNotRequireAnAccount(t *testing.T) {
	e := NewEngine(Operations{NotifyDiagnostic: func(context.Context, string, string) string { return "" }}, nil)
	defer e.Close()
	e.Handle(Command{Action: "notification-test"})
	e.Wait()
	if !strings.Contains(e.View().NotificationNote, "accepted by desktop") {
		t.Fatalf("test did not run: %q", e.View().NotificationNote)
	}
}

func TestLiveNotificationUsesArrivalTimeNotServerTimestamp(t *testing.T) {
	for _, timestamp := range []int64{0, time.Now().Add(-time.Hour).UnixMilli(), time.Now().Add(time.Hour).UnixMilli()} {
		delivered := make(chan struct{}, 1)
		e := NewEngine(Operations{NotifyDiagnostic: func(context.Context, string, string) string {
			delivered <- struct{}{}
			return ""
		}}, nil)
		chat := "u" + strings.Repeat("b", 43)
		e.mu.Lock()
		e.noticeDelay = time.Millisecond
		e.refreshNotifications([]Chat{{ID: chat, NotificationLastID: "100"}})
		e.watchEvent(WatchEvent{Kind: "message", Revision: "1", ChatID: chat,
			Message: &Message{ID: "101", Timestamp: timestamp}})
		if age := time.Since(e.noticePending[chat].At); age < 0 || age > time.Second {
			t.Errorf("queue used server timestamp: age %s", age)
		}
		e.mu.Unlock()
		select {
		case <-delivered:
		case <-time.After(time.Second):
			t.Errorf("no notification for timestamp %d", timestamp)
		}
		e.Close()
	}
}

func TestDesktopNotificationRealDelivery(t *testing.T) {
	if os.Getenv("TUILINE_TEST_DESKTOP_NOTIFICATION") != "1" {
		t.Skip("opt-in desktop notification smoke test")
	}
	if note := desktopNotification(context.Background(), "Tuiline backend test", "Testing the Go notification delivery path."); note != "" {
		t.Fatal(note)
	}
}

func TestRefreshDiscoversIncomingNotificationWithoutSelectingChat(t *testing.T) {
	for _, kind := range []string{"resync_required", "operation"} {
		t.Run(kind, func(t *testing.T) { testRefreshNotification(t, kind) })
	}
}

func testRefreshNotification(t *testing.T, kind string) {
	chat := "u" + strings.Repeat("b", 43)
	account := "u" + strings.Repeat("a", 43)
	base := time.Now().Add(-time.Second).UnixMilli()
	newTime := time.Now().UnixMilli()
	var snapshotCalls atomic.Int32
	var historyCalls atomic.Int32
	delivered := make(chan [2]string, 4)
	e := NewEngine(Operations{
		Snapshot: func(context.Context) (Snapshot, error) {
			lastID := "100"
			if snapshotCalls.Add(1) > 1 {
				lastID = "101"
			}
			return Snapshot{Account: Account{ID: account}, Chats: []Chat{{
				ID: chat, Name: "Alice", UpdatedAt: base, NotificationLastID: lastID,
			}}}, nil
		},
		History: func(_ context.Context, id string) ([]Message, error) {
			historyCalls.Add(1)
			if id != chat {
				t.Errorf("unexpected chat %q", id)
			}
			return []Message{
				{ID: "100", Text: "Old history", Timestamp: base},
				{ID: "101", Sender: "Alice", Text: "New message", Timestamp: 0},
			}, nil
		},
		NotifyDiagnostic: func(_ context.Context, title, body string) string {
			delivered <- [2]string{title, body}
			return ""
		},
	}, nil)
	defer e.Close()
	e.mu.Lock()
	e.noticeDelay = time.Millisecond
	e.resyncDelay = time.Millisecond
	e.mu.Unlock()
	e.Handle(Command{Action: "refresh"})
	e.Wait()
	if historyCalls.Load() != 0 || len(delivered) != 0 {
		t.Fatal("initial snapshot notified or fetched existing history")
	}
	e.mu.Lock()
	e.watchEvent(WatchEvent{Kind: kind, Revision: "1"})
	e.mu.Unlock()
	select {
	case got := <-delivered:
		if got != [2]string{"Alice", "New message"} {
			t.Fatalf("wrong refreshed notification: %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("refresh-discovered message never notified")
	}
	if e.View().SelectedID != "" {
		t.Fatal("notification scan selected a chat")
	}
	e.mu.Lock()
	e.watchEvent(WatchEvent{Kind: "message", Revision: "2", ChatID: chat, Message: &Message{
		ID: "101", Sender: "Alice", Text: "New message", Timestamp: newTime,
	}})
	if e.noticeTimer != nil || len(e.noticePending) != 0 {
		t.Error("later live event queued a duplicate notification")
	}
	e.mu.Unlock()
	e.Handle(Command{Action: "refresh"})
	e.Wait()
	if historyCalls.Load() != 1 {
		t.Fatal("unchanged refresh fetched history again")
	}
}

func TestLiveAndRefreshNotificationDeduplicationBothOrders(t *testing.T) {
	for _, liveFirst := range []bool{true, false} {
		name := "refresh-first"
		if liveFirst {
			name = "live-first"
		}
		t.Run(name, func(t *testing.T) {
			chat := "u" + strings.Repeat("b", 43)
			e := NewEngine(Operations{}, nil)
			defer e.Close()
			e.mu.Lock()
			// Keep the timer pending while checking both observations.
			e.noticeDelay = time.Hour
			m := Message{ID: "101", Text: "hello", Timestamp: time.Now().UnixMilli()}
			live := func() {
				e.watchEvent(WatchEvent{Kind: "message", Revision: "1", ChatID: chat, Message: &m})
			}
			if liveFirst {
				live()
				e.observeNotification(m, chat)
			} else {
				e.observeNotification(m, chat)
				live()
			}
			if len(e.notificationOrder) != 1 || len(e.noticePending) != 1 {
				t.Error("observations were not deduplicated")
			}
			e.mu.Unlock()
		})
	}
}

func TestRefreshNotificationIgnoresOwnAndOldMessages(t *testing.T) {
	chat := "u" + strings.Repeat("b", 43)
	base := time.Now().Add(-time.Second).UnixMilli()
	e := NewEngine(Operations{History: func(context.Context, string) ([]Message, error) {
		return []Message{
			{ID: "100", Timestamp: base, Text: "old"},
			{ID: "101", Timestamp: time.Now().UnixMilli(), Text: "own", Own: true},
		}, nil
	}}, nil)
	defer e.Close()
	e.mu.Lock()
	e.refreshNotifications([]Chat{{ID: chat, UpdatedAt: base, NotificationLastID: "100"}})
	e.refreshNotifications([]Chat{{ID: chat, NotificationLastID: "101"}})
	e.mu.Unlock()
	e.Wait()
	e.mu.Lock()
	if e.noticeTimer != nil || len(e.noticePending) != 0 {
		t.Error("old history or own messages queued a notification")
	}
	e.mu.Unlock()
}

func TestHistoryBrowsingDoesNotCreateNotifications(t *testing.T) {
	chat := "u" + strings.Repeat("b", 43)
	e := NewEngine(Operations{History: func(context.Context, string) ([]Message, error) {
		return []Message{{ID: "123", Text: "history", Timestamp: time.Now().UnixMilli()}}, nil
	}}, nil)
	defer e.Close()
	e.mu.Lock()
	e.state.Status = "ready"
	e.state.Chats = []Chat{{ID: chat}}
	e.refreshNotifications(e.state.Chats)
	e.mu.Unlock()
	e.Handle(Command{Action: "select", ID: chat})
	e.Wait()
	e.mu.Lock()
	if e.noticeTimer != nil || len(e.noticePending) != 0 {
		t.Error("opening history queued a notification")
	}
	e.mu.Unlock()
}

func TestNotificationScanCannotCrossAccountReset(t *testing.T) {
	chat := "u" + strings.Repeat("b", 43)
	base := time.Now().Add(-time.Second).UnixMilli()
	started, release := make(chan struct{}), make(chan struct{})
	e := NewEngine(Operations{History: func(context.Context, string) ([]Message, error) {
		close(started)
		<-release
		return []Message{{ID: "123", Text: "previous account", Timestamp: time.Now().UnixMilli()}}, nil
	}}, nil)
	defer e.Close()
	e.mu.Lock()
	e.refreshNotifications([]Chat{{ID: chat, UpdatedAt: base, NotificationLastID: "100"}})
	e.refreshNotifications([]Chat{{ID: chat, NotificationLastID: "101"}})
	e.mu.Unlock()
	<-started
	e.mu.Lock()
	e.resetIdentity()
	e.refreshNotifications([]Chat{{ID: chat, UpdatedAt: base, NotificationLastID: "100"}})
	e.mu.Unlock()
	close(release)
	e.Wait()
	e.mu.Lock()
	if len(e.noticePending) != 0 || len(e.notificationSeen) != 0 || e.notificationScanActive {
		t.Error("previous account's notification scan survived the reset")
	}
	e.mu.Unlock()
}

func TestStartupMessageIDsSuppressReplayWithoutUsingTimestamp(t *testing.T) {
	chat := "u" + strings.Repeat("b", 43)
	e := NewEngine(Operations{}, nil)
	defer e.Close()
	e.mu.Lock()
	e.refreshNotifications([]Chat{{ID: chat, NotificationLastID: "100"}})
	for i, id := range []string{"99", "100"} {
		e.watchEvent(WatchEvent{Kind: "message", Revision: strconv.Itoa(i + 1), ChatID: chat,
			Message: &Message{ID: id, Timestamp: time.Now().UnixMilli()}})
	}
	if e.noticeTimer != nil || len(e.noticePending) != 0 {
		t.Error("startup history replay queued a notification")
	}
	e.mu.Unlock()
}

func TestRejectedNotificationCanBeObservedAgain(t *testing.T) {
	chat := "u" + strings.Repeat("b", 43)
	e := NewEngine(Operations{}, nil)
	defer e.Close()
	e.mu.Lock()
	e.noticeDelay = time.Hour
	e.state.Notifications = false
	m := Message{ID: "101", Timestamp: 0}
	e.observeNotification(m, chat)
	if e.notificationSeen[chat+":"+m.ID] {
		t.Error("rejected candidate was marked seen")
	}
	e.state.Notifications = true
	e.observeNotification(m, chat)
	if e.noticePending[chat].Message.ID != m.ID || !e.notificationSeen[chat+":"+m.ID] {
		t.Error("rediscovered candidate was not accepted")
	}
	e.mu.Unlock()
}
