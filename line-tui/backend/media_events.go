package gui

// seedSentPhoto uses the bytes we just uploaded, rather than immediately
// downloading our own image and holding the session lock again.
func (e *Engine) seedSentPhoto(chat, id, thumb string) {
	if thumb == "" {
		return
	}
	if e.mediaStore != nil {
		e.mediaStore.save("thumbnail", mediaPhotoKey(chat, id), thumb)
		e.state.MediaCacheBytes = e.mediaStore.usage()
	}
	if e.state.SelectedID == chat {
		e.cachePhoto(id, thumb)
	}
}

// Media receipts do not require an account snapshot. Keep the existing timeline,
// send slot and account readiness, and only update the affected media message.
// Explicit fullSync and unknown operations retain their ordinary resync path.
func (e *Engine) receiveMedia(event WatchEvent) {
	id, chat := event.MessageID, event.ChatID
	if !numericID.MatchString(id) {
		return
	}
	if !fullID.MatchString(chat) {
		// Some receipt variants carry only a message ID. Only touch a known
		// row; do not infer a destination or schedule an account-wide refresh.
		chat = ""
		for _, m := range e.state.Messages {
			if m.ID == id {
				chat = e.state.SelectedID
				break
			}
		}
		if chat == "" {
			return
		}
	}
	if event.Message != nil && event.Message.ID == id && event.Message.Own {
		m := *event.Message
		if m.ContentType != 1 && m.ContentType != 2 && m.ContentType != 3 && m.ContentType != 14 {
			return
		}
		known := false
		for _, c := range e.state.Chats {
			if c.ID == chat {
				known = true
				break
			}
		}
		if !known {
			e.scheduleResync()
			return
		}
		// Replace an existing media row without unread increments, notices, or
		// duplicate arrivals. If the echo beats the local receipt, append once.
		if e.state.SelectedID == chat {
			for i, old := range e.state.Messages {
				if old.ID != id {
					continue
				}
				m.Read = m.Read || old.Read
				if m.Timestamp == 0 {
					m.Timestamp, m.Time, m.Day = old.Timestamp, old.Time, old.Day
				}
				if m.ReplyTo == "" {
					m.ReplyTo = old.ReplyTo
				}
				if m.FileName == "" {
					m.FileName = old.FileName
				}
				if m.Reactions == nil {
					m.Reactions = old.Reactions
				}
				if m.Text == "" {
					m.Text, m.GeneratedText = old.Text, old.GeneratedText
				}
				e.state.Messages[i] = m
				break
			}
		}
		e.sentMessage(chat, m)
	}
	// A previously unavailable preview can now be retried in the background.
	// Never discard an already-ready local upload preview or duplicate a loader.
	if chat == e.state.SelectedID && !e.pending && !e.mutationActive &&
		e.photoVisible[id] && e.state.PhotoThumbnails[id].Status == "error" {
		e.photos(Command{Action: "photo-retry", ID: chat, MessageID: id, Session: e.state.Session, Selection: e.state.Selection})
	}
}
