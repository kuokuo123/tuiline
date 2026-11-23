package gui

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kongesque/line-cli/internal/messaging"
	"github.com/kongesque/line-cli/internal/session"
	"github.com/kongesque/line-cli/pkg/line"
)

type mutedSnapshotAPI struct {
	contactFailAPI
	peer, group string
}

func (a *mutedSnapshotAPI) GetAllContactIds() ([]string, error) {
	return []string{a.peer}, nil
}
func (a *mutedSnapshotAPI) GetContactsV2([]string) (*line.ContactsResponse, error) {
	return &line.ContactsResponse{Contacts: map[string]line.ContactWrapper{
		a.peer: {Contact: line.Contact{Mid: a.peer, DisplayName: "Friend", Settings: "1"}},
	}}, nil
}
func (a *mutedSnapshotAPI) GetMessageBoxes(line.MessageBoxesOptions) (*line.MessageBoxesResponse, error) {
	return &line.MessageBoxesResponse{MessageBoxes: []line.MessageBox{{ID: a.peer}, {ID: a.group}}}, nil
}
func (a *mutedSnapshotAPI) GetChats([]string, bool, bool) (*line.GetChatsResponse, error) {
	return &line.GetChatsResponse{Chats: []line.Chat{{ChatMid: a.group, ChatName: "Group", NotificationDisabled: true}}}, nil
}

func TestSnapshotReadsMuteStateForFriendsAndGroups(t *testing.T) {
	account := "u" + strings.Repeat("a", 43)
	api := &mutedSnapshotAPI{contactFailAPI: contactFailAPI{id: account},
		peer: "u" + strings.Repeat("b", 43), group: "c" + strings.Repeat("c", 43)}
	store := &memoryStore{s: &session.State{Version: 1, MID: account, AccessToken: "fictional", NoE2EE: true}}
	manager := session.NewManager(store)
	manager.NewClient = func(string) session.API { return api }
	d := &Direct{Manager: manager, Lock: func() (func(), error) { return func() {}, nil }}
	snapshot, err := d.Snapshot(context.Background())
	if err != nil || len(snapshot.Chats) != 2 {
		t.Fatalf("snapshot failed: %v", err)
	}
	for _, chat := range snapshot.Chats {
		if !chat.Muted || !chat.MuteKnown {
			t.Fatalf("mute state lost for %s", chat.ID)
		}
	}
}

func TestMarkReadTogglePersistsAndStopsReceipts(t *testing.T) {
	calls := 0
	e, c := readTestEngine(t, func(context.Context, string, string) error { calls++; return nil })
	root := filepath.Join(t.TempDir(), "tuiline", "media")
	account := "u" + strings.Repeat("b", 43)
	e.mu.Lock()
	e.state.Account.ID = account
	e.mediaStore = openMediaCache(root, account)
	e.mu.Unlock()
	if !e.View().MarkReadEnabled {
		t.Fatal("mark read should default to enabled")
	}
	e.Handle(Command{Action: "mark-read-toggle"})
	e.Handle(c)
	e.Wait()
	if calls != 0 || e.View().MarkReadEnabled || openMediaCache(root, account).preferenceEnabled("mark-read-off") {
		t.Fatal("disabled read receipts ran or preference was not persisted")
	}
	e.mediaStore.clear()
	if openMediaCache(root, account).preferenceEnabled("mark-read-off") {
		t.Fatal("clearing media discarded mark-read preference")
	}
	e.Handle(Command{Action: "mark-read-toggle"})
	e.Handle(c)
	e.Wait()
	if calls != 1 || !e.View().MarkReadEnabled {
		t.Fatal("read receipts did not resume")
	}
}

func TestDisablingMarkReadCancelsQueuedReceipts(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	calls := 0
	e, c := readTestEngine(t, func(context.Context, string, string) error {
		calls++
		close(started)
		<-release
		return nil
	})
	e.mu.Lock()
	e.state.Account.ID = "u" + strings.Repeat("b", 43)
	e.mu.Unlock()
	c.MessageID = "101"
	e.Handle(c)
	<-started
	c.MessageID = "102"
	e.Handle(c)
	e.Handle(Command{Action: "mark-read-toggle"})
	close(release)
	e.Wait()
	if calls != 1 || e.View().Chats[0].Unread != 2 || e.View().MarkReadEnabled {
		t.Fatal("disabling mark read allowed queued receipts or cleared unread")
	}
}

func TestMuteChangesOnlyAfterLINESuccess(t *testing.T) {
	chat := "c" + strings.Repeat("c", 43)
	for _, fail := range []bool{false, true} {
		started, release := make(chan struct{}), make(chan struct{})
		e := NewEngine(Operations{SetMuted: func(_ context.Context, id string, muted bool) error {
			if id != chat || !muted {
				t.Error("wrong mutation target")
			}
			close(started)
			<-release
			if fail {
				return errors.New("server rejected mutation")
			}
			return nil
		}}, nil)
		e.mu.Lock()
		e.state.Status = "ready"
		e.state.Chats = []Chat{{ID: chat, MuteKnown: true}}
		e.mu.Unlock()
		e.Handle(Command{Action: "chat-mute-toggle", ID: chat, Session: e.View().Session})
		<-started
		if e.View().Chats[0].Muted {
			t.Error("mute applied optimistically")
		}
		close(release)
		e.Wait()
		if e.View().Chats[0].Muted == fail {
			t.Error("mute did not reflect server result")
		}
		e.Close()
	}
}

func TestMutedChatCannotQueueOrDeliverNotification(t *testing.T) {
	chat := "c" + strings.Repeat("c", 43)
	e := NewEngine(Operations{NotifyDiagnostic: func(context.Context, string, string) string {
		t.Error("muted chat delivered a notification")
		return ""
	}}, nil)
	defer e.Close()
	e.mu.Lock()
	e.state.Chats = []Chat{{ID: chat, Muted: true}}
	e.notice(Message{ID: "101"}, chat)
	if len(e.noticePending) != 0 {
		t.Error("muted chat queued a notification")
	}
	e.state.Chats[0].Muted = false
	e.noticeDelay = time.Millisecond
	e.notice(Message{ID: "102"}, chat)
	e.state.Chats[0].Muted = true
	e.mu.Unlock()
	time.Sleep(30 * time.Millisecond)
	e.Wait()
}

func TestGroupSenderNameResolvesEvenWithKnownAvatar(t *testing.T) {
	sender := "U" + strings.Repeat("a", 43)
	e := NewEngine(Operations{Profiles: func(context.Context, []string) (map[string]ProfileInfo, error) {
		return map[string]ProfileInfo{sender: {Name: "尤志展", Path: "picture"}}, nil
	}, FetchAvatar: func(context.Context, string) string { return "" }}, nil)
	defer e.Close()
	e.mu.Lock()
	e.state.Status = "ready"
	e.state.Messages = []Message{{ID: "123", SenderID: sender, Sender: sender}}
	e.picturePaths[sender] = "picture"
	e.queueProfiles()
	e.mu.Unlock()
	e.Wait()
	if e.View().Messages[0].Sender != "尤志展" {
		t.Fatal("group sender with an avatar kept unresolved MID")
	}
	d := &Direct{names: map[string]string{}, nameFallbacks: map[string]bool{}}
	d.rememberProfiles(map[string]ProfileInfo{sender: {Name: "尤志展"}})
	if got := d.projectLiveMessage(messaging.Message{ID: "124", From: sender}); got.Sender != "尤志展" {
		t.Fatal("later live message lost the resolved name")
	}
}

type notificationSettingAPI struct {
	session.API
	seq    int64
	target string
	muted  bool
}

func (a *notificationSettingAPI) SetChatMuteContext(_ context.Context, seq int64, target string, muted bool) error {
	a.seq, a.target, a.muted = seq, target, muted
	return nil
}

func TestDirectMuteUsesPersistedSequenceAndTarget(t *testing.T) {
	for _, prefix := range []string{"u", "r", "c"} {
		id := prefix + strings.Repeat("a", 43)
		api := &notificationSettingAPI{}
		store := &memoryStore{s: &session.State{Version: 1, AccessToken: "fictional", LastReqSeq: 41}}
		manager := session.NewManager(store)
		manager.NewClient = func(string) session.API { return api }
		d := &Direct{Manager: manager, Lock: func() (func(), error) { return func() {}, nil }}
		if err := d.setMuted(context.Background(), id, true); err != nil {
			t.Fatal(err)
		}
		if api.target != id || !api.muted || api.seq <= 41 || store.s.LastReqSeq != api.seq {
			t.Fatal("wrong LINE-wide notification mutation")
		}
	}
}

type publicProfileAPI struct {
	session.API
	sender string
}

func (a *publicProfileAPI) GetContactsV2([]string) (*line.ContactsResponse, error) {
	return &line.ContactsResponse{Contacts: map[string]line.ContactWrapper{}}, nil
}
func (a *publicProfileAPI) GetPublicContactsContext(context.Context, []string) ([]line.Contact, error) {
	return []line.Contact{{Mid: a.sender, DisplayName: "尤志展"}}, nil
}

func TestNonFriendProfileUsesReadOnlyPublicLookup(t *testing.T) {
	sender := "U" + strings.Repeat("b", 43)
	store := &memoryStore{s: &session.State{Version: 1, AccessToken: "fictional"}}
	manager := session.NewManager(store)
	manager.NewClient = func(string) session.API { return &publicProfileAPI{sender: sender} }
	d := &Direct{Manager: manager, Lock: func() (func(), error) { return func() {}, nil }}
	profiles, err := d.Profiles(context.Background(), []string{sender})
	if err != nil || profiles[sender].Name != "尤志展" {
		t.Fatalf("non-friend name remained unresolved: %v %v", profiles, err)
	}
}
