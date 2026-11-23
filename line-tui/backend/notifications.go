package gui

import (
	"context"
	"html"
	"io"
	"os/exec"
	"strings"
	"time"

	"github.com/kongesque/line-cli/internal/helper"
)

// Resolve through PATH: notify-send may be installed outside /usr/bin.
func desktopNotification(ctx context.Context, title, body string) string {
	path, err := exec.LookPath("notify-send")
	if err != nil {
		return "Notifications: notify-send not found in PATH"
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := helper.Command(ctx, path, "--app-name=LINE", "--", title, html.EscapeString(body))
	cmd.Stdout = io.Discard
	stderr := &notificationErrorOutput{}
	cmd.Stderr = stderr
	if err := helper.Run(cmd); err != nil {
		if ctx.Err() != nil {
			return "Notifications: notify-send timed out or was cancelled"
		}
		// Avoid exposing the message contents if the helper echoes its arguments.
		detail := strings.TrimSpace(stderr.text)
		for _, private := range []string{html.EscapeString(body), body, title} {
			if private != "" {
				detail = strings.ReplaceAll(detail, private, "[redacted]")
			}
		}
		detail = label(detail, 240)
		if detail == "" {
			detail = label(err.Error(), 240)
		}
		return "Notifications: " + detail
	}
	return ""
}

type notificationErrorOutput struct{ text string }

func (w *notificationErrorOutput) Write(data []byte) (int, error) {
	n := len(data)
	if remaining := 4096 - len(w.text); remaining > 0 {
		w.text += string(data[:min(remaining, n)])
	}
	return n, nil
}

// Caller holds the engine lock; helper execution never blocks message reception.
func (e *Engine) testNotification() {
	if e.state.Mode != "live" || e.notificationTestActive {
		return
	}
	e.notificationTestActive = true
	ctx, epoch := e.resourceCtx, e.epoch
	notify := e.ops.NotifyDiagnostic
	e.spawn(func() {
		note := "Notifications: desktop notification helper unavailable"
		if notify != nil {
			note = notify(ctx, "Tuiline notification test", "Desktop notifications are enabled.")
			if note == "" {
				note = "Notification test accepted by desktop; if hidden, check Do Not Disturb and notification rules"
			}
		}
		e.mu.Lock()
		defer e.mu.Unlock()
		e.notificationTestActive = false
		if !e.disposed && e.epoch == epoch {
			e.state.NotificationNote = note
			e.publish()
		}
	})
}

// Both live events and refresh-discovered messages use this bounded session-local
// ledger. Do not reuse seenMessages: that ledger must still allow a later live
// event to update chat previews, history, and unread counts.
func (e *Engine) observeNotification(m Message, chat string) {
	if !numericID.MatchString(m.ID) || !fullID.MatchString(chat) {
		return
	}
	if baseline := e.notificationInitial[chat]; baseline != "" && !newerNotificationID(m.ID, baseline) {
		return
	}
	key := chat + ":" + m.ID
	if e.notificationSeen[key] {
		return
	}
	e.notice(m, chat)
	// Only deduplicate messages accepted into the pending notification queue.
	if pending, ok := e.noticePending[chat]; !ok || pending.Message.ID != m.ID {
		return
	}
	if e.notificationSeen == nil {
		e.notificationSeen = map[string]bool{}
	}
	e.notificationSeen[key] = true
	e.notificationOrder = append(e.notificationOrder, key)
	if len(e.notificationOrder) > 4096 {
		delete(e.notificationSeen, e.notificationOrder[0])
		e.notificationOrder = e.notificationOrder[1:]
	}
}

func newerNotificationID(id, baseline string) bool {
	return numericID.MatchString(id) && (!numericID.MatchString(baseline) || !messageAtOrBefore(id, baseline))
}

// The first snapshot is a baseline, not new-message activity. Later snapshots
// scan only chats whose server update cursor advanced, never history browsing.
// One background worker bounds additional API requests independently of selection.
func (e *Engine) refreshNotifications(chats []Chat) {
	if e.state.Mode != "live" {
		return
	}
	if e.notificationChats == nil {
		e.notificationChats = map[string]string{}
		e.notificationInitial = map[string]string{}
		for _, chat := range chats {
			e.notificationChats[chat.ID] = chat.NotificationLastID
			e.notificationInitial[chat.ID] = chat.NotificationLastID
		}
		return
	}
	if e.notificationQueue == nil {
		e.notificationQueue = map[string]string{}
	}
	present := map[string]bool{}
	for _, chat := range chats {
		present[chat.ID] = true
		baseline := e.notificationChats[chat.ID]
		if _, known := e.notificationChats[chat.ID]; !known {
			e.notificationChats[chat.ID] = ""
		}
		if newerNotificationID(chat.NotificationLastID, baseline) {
			if newerNotificationID(chat.NotificationLastID, e.notificationQueue[chat.ID]) {
				e.notificationQueue[chat.ID] = chat.NotificationLastID
			}
		}
	}
	for chat := range e.notificationChats {
		if !present[chat] {
			delete(e.notificationChats, chat)
			delete(e.notificationQueue, chat)
		}
	}
	e.pumpNotificationRefresh()
}

func (e *Engine) pumpNotificationRefresh() {
	if e.disposed || e.notificationScanActive || e.state.Login.Active || e.ops.History == nil {
		return
	}
	for chat, updated := range e.notificationQueue {
		delete(e.notificationQueue, chat)
		baseline, present := e.notificationChats[chat]
		if !present || !newerNotificationID(updated, baseline) {
			continue
		}
		e.notificationScanActive = true
		epoch := e.epoch
		ctx, cancel := context.WithTimeout(e.resourceCtx, 15*time.Second)
		e.spawn(func() {
			defer cancel()
			rows, err := e.ops.History(ctx, chat)
			e.mu.Lock()
			defer e.mu.Unlock()
			if e.disposed || e.epoch != epoch {
				return
			}
			e.notificationScanActive = false
			if err == nil && ctx.Err() == nil && len(rows) <= 100 {
				if _, stillPresent := e.notificationChats[chat]; stillPresent {
					for _, m := range sortedHistory(rows) {
						if newerNotificationID(m.ID, baseline) {
							e.observeNotification(m, chat)
						}
					}
					if newerNotificationID(updated, e.notificationChats[chat]) {
						e.notificationChats[chat] = updated
					}
				}
			} else {
				e.state.NotificationNote = "Notifications: could not check refreshed chat history"
			}
			e.pumpNotificationRefresh()
			e.publish()
		})
		return
	}
}
