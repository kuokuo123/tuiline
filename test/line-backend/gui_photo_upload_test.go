package gui

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPhotoAttachmentModeValidationAndSentType(t *testing.T) {
	for _, mode := range []string{"", "image"} {
		t.Run("mode="+mode, func(t *testing.T) {
			var sent *Attachment
			e, id := readyEngine(Operations{Send: func(_ context.Context, chat, text, reply string, file *Attachment) (SendResult, error) {
				sent = file
				return SendResult{ID: "123", ChatID: chat}, nil
			}})
			defer e.Close()
			var imageData bytes.Buffer
			if err := png.Encode(&imageData, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
				t.Fatal(err)
			}
			name := filepath.Join(t.TempDir(), "photo.png")
			if err := os.WriteFile(name, imageData.Bytes(), 0600); err != nil {
				t.Fatal(err)
			}
			v := e.View()
			c := Command{Action: "attach", ID: id, Session: v.Session, Selection: v.Selection, Mode: mode, URL: fileURL(name)}
			e.Handle(c)
			e.Wait()
			file := e.View().Attachment
			if file == nil || file.Image != (mode == "image") {
				t.Fatalf("incorrect attachment mode: %#v", file)
			}
			if mode == "image" && (file.photo == nil || len(file.Data) != 0 ||
				sentPhotoThumbnail(file) != file.photo.Thumbnail()) {
				t.Fatal("photo was not prepared once into an opaque reusable snapshot")
			}
			c.Action, c.AttachmentID = "send", file.ID
			e.Handle(c)
			e.Wait()
			v = e.View()
			want := 14
			if mode == "image" {
				want = 1
			}
			if sent == nil || sent.Image != (mode == "image") || len(v.Messages) == 0 ||
				v.Messages[len(v.Messages)-1].ID != "123" || v.Messages[len(v.Messages)-1].ContentType != want {
				t.Fatalf("wrong sent photo/file type: %#v", v.Messages)
			}
		})
	}
}

func TestPhotoSendAllowsBrowsingAndAcknowledgesOriginalAttachment(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	sends := 0
	e, id := readyEngine(Operations{Send: func(ctx context.Context, chat, text, reply string, file *Attachment) (SendResult, error) {
		sends++
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 90*time.Second {
			t.Error("attachment send has no bounded deadline")
		}
		close(started)
		<-release
		return SendResult{ID: "123", ChatID: chat}, nil
	}})
	defer e.Close()
	e.mu.Lock()
	e.state.Attachment = &Attachment{ID: "attachment-one", Name: "photo.png", Image: true}
	e.state.Chats = append(e.state.Chats, Chat{ID: "other", Name: "Other"})
	e.mu.Unlock()
	v := e.View()
	e.Handle(Command{Action: "send", ID: id, Session: v.Session, Selection: v.Selection, AttachmentID: "attachment-one"})
	<-started
	e.Handle(Command{Action: "select", ID: "other"})
	v = e.View()
	if v.SelectedID != "other" || !v.UploadPending || v.SendStatus != "pending" {
		t.Errorf("upload blocked browsing: %#v", v)
	}
	// Browsing must not enable a second mutation.
	e.Handle(Command{Action: "send", ID: "other", Session: v.Session, Selection: v.Selection, Text: "do not send"})
	close(release)
	e.Wait()
	v = e.View()
	if sends != 1 || v.UploadPending || v.SendStatus != "idle" || v.SentAttachmentID != "attachment-one" {
		t.Fatalf("missing upload acknowledgement: %#v", v)
	}
	for _, message := range v.Messages {
		if message.ID == "123" {
			t.Fatal("receipt added to the wrong chat")
		}
	}
}

func TestPhotoSendDeadlineFailureReleasesPendingState(t *testing.T) {
	e, id := readyEngine(Operations{Send: func(context.Context, string, string, string, *Attachment) (SendResult, error) {
		return SendResult{}, context.DeadlineExceeded
	}})
	defer e.Close()
	e.mu.Lock()
	e.state.Attachment = &Attachment{ID: "attachment-one", Name: "photo.png", Image: true}
	e.state.Chats = append(e.state.Chats, Chat{ID: "other", Name: "Other"})
	e.mu.Unlock()
	v := e.View()
	e.Handle(Command{Action: "send", ID: id, Session: v.Session, Selection: v.Selection, AttachmentID: "attachment-one"})
	e.Wait()
	v = e.View()
	if v.UploadPending || v.SendStatus != "uncertain" || v.SentAttachmentID != "" {
		t.Fatal("deadline falsely acknowledged or retained pending send")
	}
	if !strings.Contains(v.SendNote, "Delivery unconfirmed: prepare/send photo: request timed out") {
		t.Fatalf("missing safe photo failure detail: %s", v.SendNote)
	}
	e.Handle(Command{Action: "select", ID: "other"})
	if e.View().SelectedID != "other" {
		t.Fatal("uncertain send blocked navigation")
	}
}

func TestPhotoAttachmentRejectsNonImageBytes(t *testing.T) {
	e, id := readyEngine(Operations{})
	defer e.Close()
	name := filepath.Join(t.TempDir(), "fake.png")
	if err := os.WriteFile(name, []byte("not an image"), 0600); err != nil {
		t.Fatal(err)
	}
	v := e.View()
	e.Handle(Command{Action: "attach", ID: id, Session: v.Session, Selection: v.Selection, Mode: "image", URL: fileURL(name)})
	e.Wait()
	if v := e.View(); v.Attachment != nil || v.SendNote == "" {
		t.Fatal("non-image accepted as photo")
	}
}
