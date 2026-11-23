package line

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type muteStep struct {
	method, body, response string
	status                 int
	check                  func([]byte)
}

func muteTestClient(t *testing.T, steps ...muteStep) *Client {
	t.Helper()
	calls := 0
	client := NewClient("PRIVATE-TOKEN")
	client.HTTPClient = &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if calls >= len(steps) {
			t.Fatalf("unexpected extra request to %s (mutation must not be replayed)", req.URL.Path)
		}
		step := steps[calls]
		calls++
		if want := "/api/talk/thrift/Talk/TalkService/" + step.method; req.URL.Path != want {
			t.Fatalf("path = %s, want %s", req.URL.Path, want)
		}
		body, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatal(err)
		}
		if step.body != "" && string(body) != step.body {
			t.Fatalf("%s body = %s, want %s", step.method, body, step.body)
		}
		if step.check != nil {
			step.check(body)
		}
		status := step.status
		if status == 0 {
			status = http.StatusOK
		}
		return &http.Response{StatusCode: status, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(step.response))}, nil
	})}
	t.Cleanup(func() {
		if calls != len(steps) {
			t.Errorf("sent %d requests, want %d", calls, len(steps))
		}
	})
	return client
}

func contactVerification(settings string) muteStep {
	return muteStep{method: "getContactsV2", body: `[{"targetUserMids":["upeer"]},2]`,
		response: `{"message":"OK","data":{"contacts":{"upeer":{"contact":{"mid":"upeer","settings":` + settings + `}}}}}`}
}

func TestContactMuteAndUnmuteChromeRequestsAndVerification(t *testing.T) {
	for _, muted := range []bool{true, false} {
		value, settings := "true", `"9"` // Preserve unrelated contact-setting bits.
		if !muted {
			value, settings = "false", "8"
		}
		t.Run(value, func(t *testing.T) {
			client := muteTestClient(t,
				muteStep{method: "updateContactSetting", body: `[41,"upeer",1,"` + value + `"]`,
					response: `{"message":"OK","data":null}`},
				contactVerification(settings))
			if err := client.SetChatMuteContext(context.Background(), 41, "upeer", muted); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestGroupAndRoomMutePreserveFullChatAndExplicitFalse(t *testing.T) {
	for _, target := range []string{"cgroup", "rroom"} {
		t.Run(target, func(t *testing.T) {
			// Raw metadata includes fields unknown to the local Chat struct and an
			// integer too large to round-trip safely through float64.
			original := `{"chatMid":"` + target + `","type":0,"chatName":"PRIVATE-NAME",` +
				`"notificationDisabled":true,"favoriteTimestamp":9007199254740993,` +
				`"extra":{"groupExtra":{"memberMids":{"member":"value"}}},"futureField":{"keep":false}}`
			client := muteTestClient(t,
				muteStep{method: "getChats", body: `[{"chatMids":["` + target + `"],"withMembers":false,"withInvitees":false},2]`,
					response: `{"message":"OK","data":{"chats":[` + original + `]}}`},
				muteStep{method: "updateChat", response: `{"message":"OK","data":null}`, check: func(body []byte) {
					var args []struct {
						ReqSeq           int64                      `json:"reqSeq"`
						Chat             map[string]json.RawMessage `json:"chat"`
						UpdatedAttribute int                        `json:"updatedAttribute"`
					}
					if err := json.Unmarshal(body, &args); err != nil || len(args) != 1 {
						t.Fatalf("invalid updateChat body: %s", body)
					}
					if args[0].ReqSeq != 41 || args[0].UpdatedAttribute != 8 ||
						string(args[0].Chat["notificationDisabled"]) != "false" {
						t.Fatalf("incorrect updateChat request: %s", body)
					}
					var expected map[string]json.RawMessage
					if err := json.Unmarshal([]byte(original), &expected); err != nil {
						t.Fatal(err)
					}
					for key, value := range expected {
						if key != "notificationDisabled" && string(args[0].Chat[key]) != string(value) {
							t.Errorf("updateChat altered field %s", key)
						}
					}
					if len(args[0].Chat) != len(expected) {
						t.Error("updateChat added or dropped chat metadata")
					}
				}},
				muteStep{method: "getChats",
					response: `{"code":0,"data":{"chats":[{"chatMid":"` + target + `","notificationDisabled":false}]}}`})
			if err := client.SetChatMuteContext(context.Background(), 41, target, false); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestMuteAcceptsVoidResponseOnlyWithSuccessfulReadBack(t *testing.T) {
	for _, response := range []string{"", "null", `{"code":0}`, `{"message":"OK"}`} {
		client := muteTestClient(t, muteStep{method: "updateContactSetting", response: response},
			contactVerification("1"))
		if err := client.SetChatMuteContext(context.Background(), 41, "upeer", true); err != nil {
			t.Fatalf("response %q: %v", response, err)
		}
	}
}

func TestGroupMuteChromeRequestAndVerification(t *testing.T) {
	client := muteTestClient(t,
		muteStep{method: "getChats",
			response: `{"message":"OK","data":{"chats":[{"chatMid":"cgroup","type":0,"notificationDisabled":false}]}}`},
		muteStep{method: "updateChat",
			body:     `[{"reqSeq":41,"chat":{"chatMid":"cgroup","notificationDisabled":true,"type":0},"updatedAttribute":8}]`,
			response: ""},
		muteStep{method: "getChats",
			response: `{"message":"OK","data":{"chats":[{"chatMid":"cgroup","notificationDisabled":true}]}}`})
	if err := client.SetChatMuteContext(context.Background(), 41, "cgroup", true); err != nil {
		t.Fatal(err)
	}
}

func TestMuteReadBackRetriesReadsButNeverMutation(t *testing.T) {
	client := muteTestClient(t,
		muteStep{method: "updateContactSetting", response: `{"message":"OK"}`},
		contactVerification("0"), contactVerification("1"))
	if err := client.SetChatMuteContext(context.Background(), 41, "upeer", true); err != nil {
		t.Fatal(err)
	}
	client = muteTestClient(t,
		muteStep{method: "updateContactSetting", response: `{"message":"OK"}`},
		contactVerification("0"), contactVerification("0"), contactVerification("0"))
	err := client.SetChatMuteContext(context.Background(), 41, "upeer", true)
	if !errors.Is(err, errMuteMismatch) || !strings.Contains(err.Error(), "verify mute setting") {
		t.Fatalf("unverified setting reported success: %v", err)
	}
}

func TestMuteErrorsKeepSafeStageAndAuthEvidence(t *testing.T) {
	for _, tc := range []struct {
		response string
		auth     bool
	}{
		{`{"code":10051,"message":"RESPONSE_ERROR","data":{"name":"TalkException","code":119,"reason":"PRIVATE-TOKEN access token refresh required"}}`, true},
		{`{"code":0,"message":"FAILED","data":{"reason":"PRIVATE-NAME"}}`, false},
		{`{"message":"ERROR","data":{"reason":"PRIVATE-NAME"}}`, false},
		{`{}`, false},
		{`not-json PRIVATE-TOKEN`, false},
	} {
		client := muteTestClient(t, muteStep{method: "updateContactSetting", response: tc.response})
		err := client.SetChatMuteContext(context.Background(), 41, "upeer", true)
		if err == nil || !strings.Contains(err.Error(), "update contact setting") || strings.Contains(err.Error(), "PRIVATE") {
			t.Fatalf("unsafe or missing stage diagnostic: %v", err)
		}
		if tc.auth && !IsAuthError(err) {
			t.Fatalf("lost authentication evidence: %v", err)
		}
	}
}

func TestMuteRejectsMissingVerificationTargetOrSetting(t *testing.T) {
	for _, response := range []string{
		`{"message":"OK","data":{"contacts":{}}}`,
		`{"message":"OK","data":{"contacts":{"upeer":{"contact":{"mid":"other","settings":1}}}}}`,
		`{"message":"OK","data":{"contacts":{"upeer":{"contact":{"mid":"upeer"}}}}}`,
	} {
		client := muteTestClient(t,
			muteStep{method: "updateContactSetting", response: `{"message":"OK"}`},
			muteStep{method: "getContactsV2", response: response})
		if err := client.SetChatMuteContext(context.Background(), 41, "upeer", true); err == nil {
			t.Fatal("missing verification target or setting accepted")
		}
	}
}

func TestMuteVerificationCancellationDoesNotResendMutation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	verification := contactVerification("0")
	verification.check = func([]byte) { cancel() }
	client := muteTestClient(t,
		muteStep{method: "updateContactSetting", response: `{"message":"OK"}`},
		verification)
	if err := client.SetChatMuteContext(ctx, 41, "upeer", true); !errors.Is(err, context.Canceled) {
		t.Fatalf("read-back cancellation ignored: %v", err)
	}
}

func TestPublicContactLookupRequest(t *testing.T) {
	var body string
	client := newReactionTestClientWithResponse(t,
		"/api/talk/thrift/Talk/TalkService/getContacts",
		`{"code":0,"data":[{"mid":"sender","displayName":"尤志展"}]}`, &body)
	contacts, err := client.GetPublicContactsContext(context.Background(), []string{"sender"})
	if err != nil || len(contacts) != 1 || contacts[0].DisplayName != "尤志展" || body != `[["sender"]]` {
		t.Fatalf("bad public-contact lookup: %s %v %v", body, contacts, err)
	}
}
