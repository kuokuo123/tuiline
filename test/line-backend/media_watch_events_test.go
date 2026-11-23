package events

import (
	"fmt"
	"strings"
	"testing"

	"github.com/kongesque/line-cli/internal/messaging"
)

func TestMediaOperationsAreNotAccountResyncs(t *testing.T) {
	chat := "u" + strings.Repeat("a", 43)
	for _, kind := range []int{27, 29, 43, 45} {
		data := fmt.Sprintf(`{"type":%d,"revision":"123","param1":%q,"param2":"999"}`, kind, chat)
		if kind == 43 {
			data = fmt.Sprintf(`{"type":43,"revision":"123","message":{"id":"999","to":%q,"from":"uself","contentType":1,"hasContent":true,"createdTime":"1700000000000"}}`, chat)
		}
		event, next, err := decodeEvent("operation", data, 122, &messaging.Client{})
		if err != nil || next != 123 || event == nil || event.Event != "media" || event.ChatID != chat || event.MessageID != "999" {
			t.Fatalf("media event %d lost or treated as a generic operation: %#v %v", kind, event, err)
		}
		if kind == 43 && (event.Message == nil || event.Message.ContentType != 1) {
			t.Fatal("content echo lost its media message")
		}
	}
	for _, kind := range []int{42, 54, 122, 999} {
		event, _, err := decodeEvent("operation", fmt.Sprintf(`{"type":%d,"revision":"123"}`, kind), 122, nil)
		if err != nil || event == nil || event.Event != "operation" {
			t.Fatalf("non-media event %d incorrectly suppressed: %#v %v", kind, event, err)
		}
	}
	event, _, err := decodeEvent("fullSync", `{"nextRevision":"123"}`, 122, nil)
	if err != nil || event == nil || event.Event != "resync_required" {
		t.Fatal("explicit fullSync was suppressed")
	}
}

func TestMediaHintsNeverExposeUnvalidatedParameters(t *testing.T) {
	event, _, err := decodeEvent("operation", `{"type":45,"revision":"123","param1":"PRIVATE BODY","param2":"PRIVATE TOKEN"}`, 122, nil)
	if err != nil || event == nil || event.Event != "media" || event.ChatID != "" || event.MessageID != "" {
		t.Fatalf("unsafe media hint: %#v %v", event, err)
	}
}
