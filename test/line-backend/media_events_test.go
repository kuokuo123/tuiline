package gui

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/png"
	"testing"
)

func TestConsecutivePhotoUploadsDoNotResyncOrRedownloadOwnPhoto(t *testing.T) {
	sends, downloads := 0, 0
	e, id := readyEngine(Operations{
		Send: func(_ context.Context, chat, text, reply string, file *Attachment) (SendResult, error) {
			sends++
			return SendResult{ID: fmt.Sprint(900 + sends), ChatID: chat}, nil
		},
		Download: func(context.Context, string, string) ([]byte, error) { downloads++; return nil, nil },
	})
	defer e.Close()
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 2; i++ {
		attachmentID := fmt.Sprintf("attachment-%d", i)
		e.mu.Lock()
		e.state.Attachment = &Attachment{ID: attachmentID, Name: "photo.png", Data: data.Bytes(), Image: true}
		e.mu.Unlock()
		v := e.View()
		e.Handle(Command{Action: "send", ID: id, Session: v.Session, Selection: v.Selection, AttachmentID: attachmentID})
		e.Wait()
		v = e.View()
		msgID := fmt.Sprint(900 + i)
		if sends != i || v.SendStatus != "idle" || v.SentAttachmentID != attachmentID {
			t.Fatalf("upload %d blocked", i)
		}
		if v.PhotoThumbnails[msgID].Status != "ready" {
			t.Fatal("uploaded photo was not cached locally")
		}
		before, unread := len(v.Messages), v.Chats[0].Unread
		e.mu.Lock()
		// Content can arrive after the normal message echo or local receipt.
		e.watchEvent(WatchEvent{Kind: "media", Revision: fmt.Sprint(100 + i*3), ChatID: id, MessageID: msgID,
			Message: &Message{ID: msgID, Own: true, ContentType: 1, Downloadable: true, Text: "Photo", Status: "ok"}})
		e.watchEvent(WatchEvent{Kind: "media", Revision: fmt.Sprint(101 + i*3), ChatID: id, MessageID: msgID})
		e.watchEvent(WatchEvent{Kind: "media", Revision: fmt.Sprint(102 + i*3), MessageID: msgID})
		refreshScheduled := e.resyncTimer != nil
		e.mu.Unlock()
		v = e.View()
		if refreshScheduled || v.Busy || v.Status != "ready" || len(v.Messages) != before || v.Chats[0].Unread != unread {
			t.Fatalf("media follow-up blocked the next upload or duplicated the arrival: %#v", v)
		}
		e.Handle(Command{Action: "photos-visible", ID: id, Session: v.Session, Selection: v.Selection, MessageIDs: []string{msgID}})
		e.Wait()
	}
	if downloads != 0 {
		t.Fatalf("uploaded image was downloaded %d times", downloads)
	}
}

func TestMediaHintsDoNotSuppressGenuineResync(t *testing.T) {
	for _, kind := range []string{"resync_required", "operation"} {
		e, id := readyEngine(Operations{})
		e.mu.Lock()
		e.watchEvent(WatchEvent{Kind: "media", Revision: "1", ChatID: id, MessageID: "123"})
		if e.resyncTimer != nil {
			t.Error("media-only hint requested account snapshot")
		}
		e.watchEvent(WatchEvent{Kind: kind, Revision: "2"})
		if e.resyncTimer == nil {
			t.Error("genuine resync was suppressed")
		}
		e.mu.Unlock()
		e.Close()
	}
}

func TestMediaPreviewHintRetriesOnlyAffectedFailedThumbnail(t *testing.T) {
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	downloads := 0
	var chatID string
	e, id := readyEngine(Operations{Download: func(_ context.Context, chat, message string) ([]byte, error) {
		downloads++
		if chat != chatID || message != "123" {
			t.Error("retried unrelated media")
		}
		return append([]byte(nil), data.Bytes()...), nil
	}})
	chatID = id
	defer e.Close()
	e.mu.Lock()
	e.resetPhotos()
	e.state.Messages = []Message{{ID: "123", ContentType: 1, Downloadable: true}}
	e.state.PhotoThumbnails = map[string]PhotoThumbnail{"123": {Status: "error"}}
	e.photoVisible = map[string]bool{"123": true}
	e.watchEvent(WatchEvent{Kind: "media", Revision: "1", ChatID: id, MessageID: "123"})
	scheduled := e.resyncTimer != nil
	e.mu.Unlock()
	e.Wait()
	v := e.View()
	if scheduled || v.Busy || downloads != 1 || v.PhotoThumbnails["123"].Status != "ready" {
		t.Fatalf("preview did not update without a full refresh: %#v", v)
	}
}
