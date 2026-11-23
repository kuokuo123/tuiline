package gui

import (
	"context"
	"errors"
	"slices"
	"time"

	"github.com/kongesque/line-cli/internal/session"
)

func (d *Direct) markRead(ctx context.Context, chat, message string) error {
	if !fullID.MatchString(chat) || !numericID.MatchString(message) {
		return errors.New("invalid read receipt")
	}
	unlock, err := d.acquire(ctx)
	if err != nil {
		return err
	}
	defer unlock()
	return classify(d.Manager.WithContext(ctx).DoContext(ctx, func(api session.API) error {
		client, ok := api.(interface{ SendChatChecked(string, string) error })
		if !ok {
			return errors.New("read receipts unavailable")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		return client.SendChatChecked(chat, message)
	}))
}

// Move only genuinely newer activity. Server timestamps are not reliable enough
// for ordering, so use the per-chat message ID cursor already used by notifications.
func (e *Engine) promoteActivity(chat string, m Message) {
	for i := range e.state.Chats {
		c := &e.state.Chats[i]
		if c.ID != chat {
			continue
		}
		if !newerNotificationID(m.ID, c.NotificationLastID) {
			return
		}
		c.NotificationLastID = m.ID
		item := *c
		copy(e.state.Chats[1:i+1], e.state.Chats[:i])
		e.state.Chats[0] = item
		return
	}
}

// Keep arrival-driven order across refreshes; move only newly advanced chats
// ahead of unchanged chats, without trusting message timestamps.
func (e *Engine) reconcileActivityOrder(previous []Chat) {
	if len(previous) == 0 {
		return
	}
	oldIDs, ranks := map[string]string{}, map[string]int{}
	for i, chat := range previous {
		oldIDs[chat.ID], ranks[chat.ID] = chat.NotificationLastID, i
	}
	freshRanks := map[string]int{}
	for i, chat := range e.state.Chats {
		if old, exists := oldIDs[chat.ID]; !exists || newerNotificationID(chat.NotificationLastID, old) {
			freshRanks[chat.ID] = i
		}
	}
	slices.SortStableFunc(e.state.Chats, func(a, b Chat) int {
		ai, anew := freshRanks[a.ID]
		bi, bnew := freshRanks[b.ID]
		if anew && bnew {
			return ai - bi
		}
		if anew {
			return -1
		}
		if bnew {
			return 1
		}
		return ranks[a.ID] - ranks[b.ID]
	})
}

func (e *Engine) applyReadBadges() {
	for i := range e.state.Chats {
		chat := &e.state.Chats[i]
		cursor := e.readCursors[chat.ID]
		if cursor != "" && chat.NotificationLastID != "" &&
			!newerNotificationID(chat.NotificationLastID, cursor) {
			chat.Unread = 0
		}
	}
}

func (e *Engine) cancelReadView() {
	e.readQueue = Command{}
	e.readViewFocused = false
	if e.readCancel != nil {
		e.readCancel()
		e.readCancel = nil
	}
}

func (e *Engine) visibleRead(c Command) {
	if e.state.Mode != "live" || !e.current(c) {
		return
	}
	if !c.Focused || !e.state.MarkReadEnabled {
		e.cancelReadView()
		return
	}
	if (e.state.Status != "ready" && e.state.Status != "offline") || e.ops.MarkRead == nil ||
		!numericID.MatchString(c.MessageID) || !slices.ContainsFunc(e.state.Messages, func(m Message) bool {
		return m.ID == c.MessageID
	}) {
		return
	}
	e.readViewFocused = true
	if !newerNotificationID(c.MessageID, e.readCursors[c.ID]) {
		return
	}
	if e.readQueue.ID != c.ID || newerNotificationID(c.MessageID, e.readQueue.MessageID) {
		e.readQueue = c
	}
	e.pumpVisibleRead()
}

func (e *Engine) pumpVisibleRead() {
	c := e.readQueue
	if e.readActive || !e.state.MarkReadEnabled || !e.readViewFocused || !e.current(c) ||
		!newerNotificationID(c.MessageID, e.readCursors[c.ID]) {
		return
	}
	e.readQueue = Command{}
	e.readActive = true
	ctx, cancel := context.WithTimeout(e.resourceCtx, 10*time.Second)
	e.readCancel = cancel
	epoch := e.epoch
	e.spawn(func() {
		err := e.ops.MarkRead(ctx, c.ID, c.MessageID)
		e.mu.Lock()
		defer e.mu.Unlock()
		e.readActive = false
		if !e.disposed && e.epoch == epoch && e.current(c) && e.readViewFocused && e.state.MarkReadEnabled &&
			(ctx.Err() == nil || errors.Is(ctx.Err(), context.DeadlineExceeded)) {
			if errors.Is(err, ErrUnauthenticated) {
				cancel()
				e.loseAuthentication()
				return
			}
			if err == nil && ctx.Err() == nil {
				if e.readCursors == nil {
					e.readCursors = map[string]string{}
				}
				e.readCursors[c.ID] = c.MessageID
				e.state.ReadNote = ""
				e.applyReadBadges()
			} else {
				e.state.ReadNote = "Could not mark messages read; return to the conversation to retry"
			}
		}
		cancel()
		if !e.disposed {
			e.pumpVisibleRead()
			e.publish()
		}
	})
}

func (e *Engine) toggleMarkRead() {
	if e.state.Mode != "live" || e.state.Account.ID == "" {
		return
	}
	e.state.MarkReadEnabled = !e.state.MarkReadEnabled
	if !e.state.MarkReadEnabled {
		e.cancelReadView()
	}
	if !e.mediaStore.setPreferenceEnabled("mark-read-off", e.state.MarkReadEnabled) {
		e.state.ReadNote = "Mark read preference could not be saved"
	} else {
		e.state.ReadNote = ""
	}
}
