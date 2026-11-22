package gui

import "strings"

// LINE operation 55 carries chat, reader, and last-read message in param1/2/3.
// Receipt cursors are session-local; history without a receipt remains unknown.
func messageAtOrBefore(id, cursor string) bool {
	if !numericID.MatchString(id) || !numericID.MatchString(cursor) {
		return false
	}
	id, cursor = strings.TrimLeft(id, "0"), strings.TrimLeft(cursor, "0")
	return len(id) < len(cursor) || len(id) == len(cursor) && id <= cursor
}

func (e *Engine) applyReadReceipts(chat string, rows []Message) {
	cursor := e.readUntil[chat]
	for i := range rows {
		if rows[i].Own && messageAtOrBefore(rows[i].ID, cursor) {
			rows[i].Read = true
		}
	}
}

func (e *Engine) receiveRead(event WatchEvent) {
	if !fullID.MatchString(event.ChatID) || !fullID.MatchString(event.ReaderID) ||
		event.ReaderID == e.state.Account.ID || !numericID.MatchString(event.MessageID) {
		return
	}
	if e.readUntil == nil {
		e.readUntil = map[string]string{}
	}
	old := e.readUntil[event.ChatID]
	if old != "" && messageAtOrBefore(event.MessageID, old) {
		return
	}
	if old == "" && len(e.readUntil) >= 5000 {
		return
	}
	e.readUntil[event.ChatID] = event.MessageID
	if e.historyStore != nil {
		rows := e.historyStore.load(e.state.Account.ID, event.ChatID)
		e.applyReadReceipts(event.ChatID, rows)
		e.cacheHistory(event.ChatID, rows)
		if e.state.SelectedID == event.ChatID {
			e.historyCached = rows
		}
	}
	if e.state.SelectedID == event.ChatID {
		e.applyReadReceipts(event.ChatID, e.state.Messages)
	}
}
