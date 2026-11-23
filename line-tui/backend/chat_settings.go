package gui

import (
	"context"
	"errors"
	"time"

	"github.com/kongesque/line-cli/internal/messaging"
	"github.com/kongesque/line-cli/internal/session"
	"github.com/kongesque/line-cli/pkg/line"
)

func (d *Direct) setMuted(ctx context.Context, chat string, muted bool) error {
	if !fullID.MatchString(chat) {
		return errors.New("invalid chat")
	}
	unlock, err := d.acquire(ctx)
	if err != nil {
		return err
	}
	defer unlock()
	manager := d.Manager.WithContext(ctx)
	seq, err := manager.ReserveSequence()
	if err != nil {
		return err
	}
	return classify(manager.Mutate(func(api session.API) error {
		client, ok := api.(interface {
			SetChatMuteContext(context.Context, int64, string, bool) error
		})
		if !ok {
			return errors.New("LINE notification settings unavailable")
		}
		return client.SetChatMuteContext(ctx, seq, chat, muted)
	}))
}

func (e *Engine) chatMuted(id string) bool {
	if e.muteBusy[id] { // Do not deliver queued notifications during a mute mutation.
		return true
	}
	for _, chat := range e.state.Chats {
		if chat.ID == id {
			return chat.Muted
		}
	}
	return false
}

func (e *Engine) toggleChatMute(c Command) {
	if e.state.Mode != "live" || e.state.Status != "ready" || e.state.Login.Active ||
		e.state.Busy || e.pending || e.mutationActive ||
		c.Session != e.state.Session || e.ops.SetMuted == nil || e.muteBusy[c.ID] {
		return
	}
	for _, chat := range e.state.Chats {
		if chat.ID != c.ID {
			continue
		}
		if !chat.MuteKnown {
			e.state.SendNote = "LINE mute state is unavailable; refresh before toggling"
			return
		}
		muted, epoch := !chat.Muted, e.epoch
		if e.muteBusy == nil {
			e.muteBusy = map[string]bool{}
		}
		e.muteBusy[c.ID] = true
		e.pending, e.mutationActive = true, true
		ctx, cancel := context.WithTimeout(e.resourceCtx, 15*time.Second)
		e.spawn(func() {
			defer cancel()
			err := e.ops.SetMuted(ctx, c.ID, muted)
			e.mu.Lock()
			defer e.mu.Unlock()
			e.mutationActive = false
			if e.disposed || e.epoch != epoch {
				return
			}
			delete(e.muteBusy, c.ID)
			e.pending = false
			if err != nil {
				e.state.SendNote = "LINE mute failed: " + muteFailureSummary(err)
			} else {
				for i := range e.state.Chats {
					if e.state.Chats[i].ID == c.ID {
						e.state.Chats[i].Muted = muted
						e.state.Chats[i].MuteKnown = true
					}
				}
				if muted {
					delete(e.noticePending, c.ID)
				}
				e.state.SendNote = "LINE chat notifications enabled"
				if muted {
					e.state.SendNote = "LINE chat muted"
				}
			}
			e.publish()
		})
		return
	}
}

func muteFailureSummary(err error) string {
	var detail *line.ChatMuteError
	if errors.As(err, &detail) {
		return detail.Error()
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "request timed out"
	case errors.Is(err, context.Canceled):
		return "request cancelled"
	case errors.Is(err, ErrUnauthenticated), line.IsAuthError(session.ProtocolError(err)):
		return "authentication required; refresh or sign in"
	default:
		return "request failed before confirmation; refresh before retrying"
	}
}

// Copy-on-write keeps watch projections and history readers safe while profiles
// learned from group senders are shared with subsequent live messages.
func (d *Direct) rememberProfiles(profiles map[string]ProfileInfo) {
	d.mu.Lock()
	defer d.mu.Unlock()
	names, fallbacks := map[string]string{}, map[string]bool{}
	for id, name := range d.names {
		names[id] = name
	}
	for id, missing := range d.nameFallbacks {
		fallbacks[id] = missing
	}
	for id, p := range profiles {
		if p.Name != "" && p.Name != id {
			names[id], fallbacks[id] = p.Name, false
		}
	}
	d.names, d.nameFallbacks = names, fallbacks
}

func (d *Direct) projectLiveMessage(raw messaging.Message) Message {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return projectMessage(raw, d.account, d.names, d.nameFallbacks)
}

func (e *Engine) refreshResolvedNames(profiles map[string]ProfileInfo) {
	for i := range e.historyCached {
		m := &e.historyCached[i]
		if p, ok := profiles[m.SenderID]; ok && p.Name != "" && !m.Own {
			m.Sender, m.SenderUnavailable = p.Name, false
		}
	}
	for chat, pending := range e.noticePending {
		if p, ok := profiles[pending.Message.SenderID]; ok && p.Name != "" {
			pending.Message.Sender, pending.Message.SenderUnavailable = p.Name, false
			e.noticePending[chat] = pending
		}
	}
	if e.state.SelectedID != "" && len(e.historyCached) > 0 {
		e.cacheHistory(e.state.SelectedID, e.historyCached)
	}
}

func (d *Direct) fillPublicProfiles(manager *session.Manager, ctx context.Context, ids []string, out map[string]ProfileInfo) error {
	missing := []string{}
	for _, id := range ids {
		if out[id].Name == "" || out[id].Name == id {
			missing = append(missing, id)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	var contacts []line.Contact
	err := manager.DoContext(ctx, func(api session.API) error {
		client, ok := api.(interface {
			GetPublicContactsContext(context.Context, []string) ([]line.Contact, error)
		})
		if !ok {
			return nil
		}
		var err error
		contacts, err = client.GetPublicContactsContext(ctx, missing)
		return err
	})
	if err != nil {
		return classify(err)
	}
	allowed := map[string]bool{}
	for _, id := range missing {
		allowed[id] = true
	}
	for _, contact := range contacts {
		name := label(contact.EffectiveDisplayName(), 160)
		if allowed[contact.Mid] && name != "" && name != contact.Mid {
			out[contact.Mid] = ProfileInfo{Name: name, Path: contact.PicturePath}
		}
	}
	return nil
}
