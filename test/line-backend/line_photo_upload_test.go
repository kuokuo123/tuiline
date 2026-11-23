package line

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestPlainPhotoUploadUsesOriginalCategoryAndOnlyOriginalObject(t *testing.T) {
	installCachedOBSToken(t)
	for _, status := range []int{http.StatusOK, http.StatusCreated} {
		client := NewClient("private-token")
		calls := 0
		client.OBSClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			calls++
			if req.URL.Path != "/r/talk/m/123" || req.Method != http.MethodPost {
				t.Fatalf("unexpected photo upload: %s %s", req.Method, req.URL.Path)
			}
			params, err := base64.StdEncoding.DecodeString(req.Header.Get("X-Obs-Params"))
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]string
			if err := json.Unmarshal(params, &fields); err != nil {
				t.Fatal(err)
			}
			if fields["type"] != "image" || fields["cat"] != "original" || fields["ver"] != "2.0" {
				t.Fatalf("incorrect OBS photo parameters: %#v", fields)
			}
			data, err := io.ReadAll(req.Body)
			if err != nil || string(data) != "original-image-bytes" {
				t.Fatal("photo data altered")
			}
			// OBS success is acknowledged by HTTP status, not a Message body.
			return obsResponse(status, ""), nil
		})}
		if err := client.UploadOBSPlain([]byte("original-image-bytes"), "123", "image"); err != nil {
			t.Fatal(err)
		}
		if calls != 1 {
			t.Fatalf("sent %d uploads, want one", calls)
		}
	}
}

func TestPhotoSendMessageAcceptsChromeAcknowledgementWithoutCode(t *testing.T) {
	const response = `{"message":"OK","data":{"id":"14000000000000001","from":"uself","to":"upeer","toType":0,"createdTime":"1718900000000","deliveredTime":"1718900000100","contentType":1,"hasContent":true,"contentMetadata":{}}}`
	client := newReactionTestClientWithResponse(t,
		"/api/talk/thrift/Talk/TalkService/sendMessage", response, nil)
	message, err := client.SendMessage(41, &Message{To: "upeer", ContentType: 1, HasContent: true})
	if err != nil || message == nil || message.ID != "14000000000000001" {
		t.Fatalf("successful Chrome acknowledgement rejected: %#v, %v", message, err)
	}
	if strings.HasPrefix(message.ID, "local-") {
		t.Fatal("server message ID was not used")
	}
}
