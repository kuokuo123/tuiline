package gui

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func fileURL(path string) string { return (&url.URL{Scheme: "file", Path: path}).String() }

func TestFileResultsSurviveWithoutPendingSnapshots(t *testing.T) {
	e := NewEngine(Operations{}, nil)
	defer e.Close()
	e.Handle(Command{Action: "mode", Mode: "demo"})
	v := e.View()
	c := Command{Action: "attach", ID: v.SelectedID, Session: v.Session, Selection: v.Selection, RequestID: "prepare-one"}
	file := filepath.Join(t.TempDir(), "upload.txt")
	if err := os.WriteFile(file, []byte("content"), 0600); err != nil {
		t.Fatal(err)
	}
	c.URL = fileURL(file)
	e.Handle(c)
	e.Wait()
	v = e.View()
	if v.FileResult == nil || v.FileResult.RequestID != c.RequestID || v.FileResult.Action != "attach" ||
		v.FileResult.Status != "ok" || v.Attachment == nil {
		t.Fatalf("missing prepare result: %#v", v.FileResult)
	}
	c.RequestID = "prepare-two"
	c.URL = fileURL(file + "-missing")
	e.Handle(c)
	e.Wait()
	v = e.View()
	if v.FileResult == nil || v.FileResult.RequestID != c.RequestID || v.FileResult.Status != "error" || v.FileResult.Note == "" {
		t.Fatalf("missing preparation failure: %#v", v.FileResult)
	}
	// Only the final result is needed by the consumer, even if pending was lost.
	for _, m := range v.Messages {
		if m.Downloadable {
			c.MessageID = m.ID
			break
		}
	}
	if c.MessageID == "" {
		t.Fatal("demo download fixture missing")
	}
	c.Action, c.RequestID, c.URL = "download", "download-one", fileURL(filepath.Join(t.TempDir(), "saved.png"))
	e.Handle(c)
	e.Wait()
	v = e.View()
	if v.FileResult == nil || v.FileResult.RequestID != c.RequestID || v.FileResult.Action != "download" || v.FileResult.Status != "ok" {
		t.Fatalf("missing download result: %#v", v.FileResult)
	}
	// Reusing an existing destination must report failure, never false success.
	c.RequestID = "download-two"
	e.Handle(c)
	e.Wait()
	v = e.View()
	if v.FileResult == nil || v.FileResult.RequestID != c.RequestID || v.FileResult.Status != "error" {
		t.Fatalf("missing download failure: %#v", v.FileResult)
	}
	e.Handle(Command{Action: "mode", Mode: "live"})
	if e.View().FileResult != nil {
		t.Fatal("file result survived identity reset")
	}
}

func TestAttachmentSendPreservesTextDraft(t *testing.T) {
	e := NewEngine(Operations{}, nil)
	defer e.Close()
	e.Handle(Command{Action: "mode", Mode: "demo"})
	v := e.View()
	c := Command{ID: v.SelectedID, Session: v.Session, Selection: v.Selection}
	c.Action, c.Text, c.Sequence = "draft", "keep this draft", 1
	e.Handle(c)
	e.mu.Lock()
	e.state.Attachment = &Attachment{ID: "file-id", Name: "report.txt", Size: 4, Data: []byte("file")}
	e.mu.Unlock()
	c.Action, c.Text, c.AttachmentID = "send", "", "file-id"
	e.Handle(c)
	e.Wait()
	v = e.View()
	if v.Draft != "keep this draft" || v.Attachment != nil || v.SendStatus != "idle" {
		t.Fatalf("attachment send lost draft or failed: %+v", v)
	}
	if len(v.Messages) == 0 || v.Messages[len(v.Messages)-1].FileName != "report.txt" {
		t.Fatal("attachment was not sent")
	}
}

func TestSnapshotRejectsSymlinkAndSpecialFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "real")
	if err := os.WriteFile(target, []byte("safe"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := snapshotFile(fileURL(filepath.Join(dir, "link"))); err == nil {
		t.Fatal("symlink accepted")
	}
	if err := unix.Mkfifo(filepath.Join(dir, "fifo"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := snapshotFile(fileURL(filepath.Join(dir, "fifo"))); err == nil {
		t.Fatal("fifo accepted")
	}
}
func TestDownloadPublicationNeverOverwritesExistingFile(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "keep")
	if err := os.WriteFile(target, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	fd, name, err := openParent(fileURL(target))
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	if err := publishFile(context.Background(), fd, name, []byte("new")); err == nil {
		t.Fatal("overwrote existing target")
	}
	data, err := os.ReadFile(target)
	if err != nil || string(data) != "old" {
		t.Fatalf("target changed: %s %v", data, err)
	}
}
func TestHeldDirectoryCannotBeRetargetedDuringDownload(t *testing.T) {
	root := t.TempDir()
	a := filepath.Join(root, "a")
	b := filepath.Join(root, "b")
	os.Mkdir(a, 0700)
	os.Mkdir(b, 0700)
	fd, name, err := openParent(fileURL(filepath.Join(a, "new")))
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	if err := os.Rename(a, filepath.Join(root, "old-a")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(b, a); err != nil {
		t.Fatal(err)
	}
	if err := publishFile(context.Background(), fd, name, []byte("safe")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(b, "new")); !os.IsNotExist(err) {
		t.Fatal("published into swapped directory")
	}
}
func TestDownloadGuardPreventsLatePublication(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "cancelled")
	fd, name, err := openParent(fileURL(target))
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	called := false
	err = publishFile(context.Background(), fd, name, []byte("data"), func(link func() error) error { called = true; return context.Canceled })
	if !called || err == nil {
		t.Fatal("publication guard was bypassed")
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("cancelled target exists")
	}
}
func TestFileURLRejectsBidiControl(t *testing.T) {
	if _, err := filePath(fileURL("/tmp/report\u202eexe")); err == nil {
		t.Fatal("bidi control accepted")
	}
}
