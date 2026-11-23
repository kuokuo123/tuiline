package gui

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/kongesque/line-cli/internal/session"
)

type checkedAPI struct {
	session.API
	chat, message string
	calls         int
}

func (a *checkedAPI) SendChatChecked(chat, message string) error {
	a.chat, a.message = chat, message
	a.calls++
	return nil
}

func TestDirectMarkReadUsesLINECheckedAPI(t *testing.T) {
	account, peer := "u"+strings.Repeat("a", 43), "u"+strings.Repeat("b", 43)
	store := &memoryStore{s: &session.State{Version: 1, MID: account, AccessToken: "fictional"}}
	api := &checkedAPI{}
	manager := session.NewManager(store)
	manager.NewClient = func(string) session.API { return api }
	d := &Direct{Manager: manager, Lock: func() (func(), error) { return func() {}, nil }}
	if err := d.markRead(context.Background(), peer, "123"); err != nil {
		t.Fatal(err)
	}
	if api.calls != 1 || api.chat != peer || api.message != "123" {
		t.Fatal("read receipt did not reach sendChatChecked")
	}
}

func TestIncomingActivityPromotesChatAndPreservesArrivalOrderOnRefresh(t *testing.T) {
	a, b := "u"+strings.Repeat("a", 43), "u"+strings.Repeat("b", 43)
	e := NewEngine(Operations{}, nil)
	defer e.Close()
	e.mu.Lock()
	e.state.Chats = []Chat{
		{ID: a, NotificationLastID: "100", UpdatedAt: 10000},
		{ID: b, NotificationLastID: "101", UpdatedAt: 1},
	}
	e.state.SelectedID = a
	e.watchEvent(WatchEvent{Kind: "message", Revision: "1", ChatID: b,
		Message: &Message{ID: "102", Text: "new", Timestamp: 0}})
	if e.state.Chats[0].ID != b || e.state.SelectedID != a || e.state.Chats[0].Unread != 1 {
		t.Error("arrival did not promote the chat without changing selection")
	}
	e.watchEvent(WatchEvent{Kind: "message", Revision: "2", ChatID: a,
		Message: &Message{ID: "99", Text: "replay", Timestamp: time.Now().UnixMilli()}})
	if e.state.Chats[0].ID != b || e.state.Chats[1].Unread != 0 {
		t.Error("old replay changed ordering or unread count")
	}
	previous := append([]Chat(nil), e.state.Chats...)
	e.state.Chats[0], e.state.Chats[1] = e.state.Chats[1], e.state.Chats[0]
	e.reconcileActivityOrder(previous)
	if e.state.Chats[0].ID != b {
		t.Error("refresh undid arrival ordering")
	}
	e.mu.Unlock()
}

func readTestEngine(t *testing.T, mark func(context.Context, string, string) error) (*Engine, Command) {
	t.Helper()
	chat := "u" + strings.Repeat("a", 43)
	e := NewEngine(Operations{MarkRead: mark}, nil)
	t.Cleanup(e.Close)
	e.mu.Lock()
	e.state.Status = "ready"
	e.state.SelectedID = chat
	e.state.Chats = []Chat{{ID: chat, NotificationLastID: "102", Unread: 2}}
	e.state.Messages = []Message{{ID: "101"}, {ID: "102"}}
	e.mu.Unlock()
	v := e.View()
	return e, Command{Action: "read-visible", ID: chat, MessageID: "102",
		Session: v.Session, Selection: v.Selection, Focused: true}
}

func TestVisibleReadSuccessClearsBadgeAndDeduplicates(t *testing.T) {
	var calls atomic.Int32
	e, c := readTestEngine(t, func(context.Context, string, string) error {
		calls.Add(1)
		return nil
	})
	e.Handle(c)
	e.Wait()
	if e.View().Chats[0].Unread != 0 {
		t.Fatal("successful receipt did not clear unread badge")
	}
	e.Handle(c)
	e.Wait()
	if calls.Load() != 1 {
		t.Fatal("same read cursor was sent twice")
	}
}

func TestVisibleReadFailureDoesNotClearBadge(t *testing.T) {
	e, c := readTestEngine(t, func(context.Context, string, string) error { return errors.New("offline") })
	e.Handle(c)
	e.Wait()
	if e.View().Chats[0].Unread != 2 || e.View().ReadNote == "" {
		t.Fatal("failed receipt cleared badge or hid error")
	}
}

func TestVisibleReadRejectsUnfocusedStaleAndUnknownTargets(t *testing.T) {
	var calls atomic.Int32
	e, valid := readTestEngine(t, func(context.Context, string, string) error {
		calls.Add(1)
		return nil
	})
	for _, variant := range []string{"unfocused", "session", "selection", "unknown"} {
		c := valid
		switch variant {
		case "unfocused":
			c.Focused = false
		case "session":
			c.Session = "old"
		case "selection":
			c.Selection++
		case "unknown":
			c.MessageID = "999"
		}
		e.Handle(c)
	}
	e.Wait()
	if calls.Load() != 0 {
		t.Fatal("invalid visibility sent a receipt")
	}
}

func TestVisibleReadCoalescesAndDoesNotClearNewerUnread(t *testing.T) {
	started := make(chan string, 3)
	release := make(chan struct{})
	var calls atomic.Int32
	e, c := readTestEngine(t, func(_ context.Context, _, message string) error {
		n := calls.Add(1)
		started <- message
		if n == 1 {
			<-release
		}
		return nil
	})
	c.MessageID = "101"
	e.Handle(c)
	<-started
	e.mu.Lock()
	e.state.Messages = append(e.state.Messages, Message{ID: "103"})
	e.state.Chats[0].NotificationLastID = "103"
	e.mu.Unlock()
	c.MessageID = "102"
	e.Handle(c)
	e.Handle(c)
	close(release)
	e.Wait()
	if calls.Load() != 2 || e.View().Chats[0].Unread != 2 {
		t.Fatal("receipts were not coalesced, or a newer message's badge was cleared")
	}
}

func TestReadCompletionCannotAffectChangedSelectionOrAccount(t *testing.T) {
	for _, reset := range []bool{false, true} {
		t.Run(map[bool]string{false: "selection", true: "account"}[reset], func(t *testing.T) {
			started, release := make(chan struct{}), make(chan struct{})
			e, c := readTestEngine(t, func(context.Context, string, string) error {
				close(started)
				<-release // Simulate an operation that ignores cancellation.
				return nil
			})
			e.Handle(c)
			<-started
			e.mu.Lock()
			if reset {
				e.resetIdentity()
			} else {
				e.cancelReadView()
				e.state.Selection++
			}
			e.mu.Unlock()
			close(release)
			e.Wait()
			if e.View().Chats[0].Unread != 2 {
				t.Fatal("stale completion cleared unread")
			}
		})
	}
}
