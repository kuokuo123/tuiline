package line

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

var (
	errMuteResponse = errors.New("invalid or unacknowledged LINE response")
	errMuteTarget   = errors.New("requested chat or contact missing from LINE response")
	errMuteMismatch = errors.New("read-back still differs from requested mute setting")
)

// ChatMuteError exposes a fixed stage and safe failure summary, while retaining
// the original protocol evidence privately for authentication classification.
type ChatMuteError struct {
	stage, summary string
	cause          error
}

func (e *ChatMuteError) Error() string { return e.stage + ": " + e.summary }
func (e *ChatMuteError) Unwrap() error { return e.cause }

func muteFailure(stage string, cause error) error {
	summary := "request failed; refresh before retrying"
	var response *ResponseError
	var network net.Error
	switch {
	case errors.Is(cause, context.DeadlineExceeded):
		summary = "request timed out"
	case errors.Is(cause, context.Canceled):
		summary = "request cancelled"
	case errors.As(cause, &response):
		summary = response.Error()
		var envelope struct {
			Data struct {
				Code *int `json:"code"`
			} `json:"data"`
		}
		if json.Unmarshal([]byte(response.body), &envelope) == nil && envelope.Data.Code != nil {
			summary += fmt.Sprintf(", LINE error %d", *envelope.Data.Code)
		}
	case errors.Is(cause, errMuteResponse), errors.Is(cause, errMuteTarget), errors.Is(cause, errMuteMismatch):
		summary = cause.Error()
	case errors.As(cause, &network):
		summary = "network request failed"
	}
	return &ChatMuteError{stage: stage, summary: summary, cause: cause}
}

// Chrome responses may acknowledge success with message:"OK" and no code.
// Void mutation responses are also allowed, but never count as verification:
// callers must read the setting back before reporting success.
func chatSettingData(resp []byte, allowVoid bool) (json.RawMessage, error) {
	resp = bytes.TrimSpace(resp)
	if allowVoid && (len(resp) == 0 || bytes.Equal(resp, []byte("null"))) {
		return nil, nil
	}
	var envelope struct {
		Code    *int            `json:"code"`
		Message string          `json:"message"`
		Data    json.RawMessage `json:"data"`
	}
	if json.Unmarshal(resp, &envelope) != nil {
		return nil, errMuteResponse
	}
	if envelope.Code != nil && *envelope.Code != 0 {
		return nil, responseError(200, resp)
	}
	message := strings.TrimSpace(envelope.Message)
	if message != "" && !strings.EqualFold(message, "OK") && !strings.EqualFold(message, "SUCCESS") {
		// Keep raw server text private, including error envelopes without a code.
		return nil, &ResponseError{Status: 200, body: string(resp)}
	}
	if envelope.Code == nil && message == "" {
		return nil, errMuteResponse
	}
	return envelope.Data, nil
}

func (c *Client) muteRPC(ctx context.Context, stage, method string, allowVoid bool, args ...interface{}) (json.RawMessage, error) {
	resp, err := c.callRPCContext(ctx, "TalkService", method, args...)
	if err != nil {
		return nil, muteFailure(stage, err)
	}
	data, err := chatSettingData(resp, allowVoid)
	if err != nil {
		return nil, muteFailure(stage, err)
	}
	return data, nil
}

func (c *Client) muteChatObject(ctx context.Context, target, stage string) (map[string]json.RawMessage, error) {
	data, err := c.muteRPC(ctx, stage, "getChats", false,
		GetChatsRequest{ChatMids: []string{target}}, 2)
	if err != nil {
		return nil, err
	}
	var result struct {
		Chats []map[string]json.RawMessage `json:"chats"`
	}
	if json.Unmarshal(data, &result) != nil {
		return nil, muteFailure(stage, errMuteResponse)
	}
	for _, chat := range result.Chats {
		var id string
		if json.Unmarshal(chat["chatMid"], &id) == nil && id == target {
			return chat, nil
		}
	}
	return nil, muteFailure(stage, errMuteTarget)
}

func (c *Client) readChatMute(ctx context.Context, target string, direct bool) (bool, error) {
	const stage = "verify mute setting"
	if !direct {
		chat, err := c.muteChatObject(ctx, target, stage)
		if err != nil {
			return false, err
		}
		var muted *bool
		if json.Unmarshal(chat["notificationDisabled"], &muted) != nil || muted == nil {
			return false, muteFailure(stage, errMuteResponse)
		}
		return *muted, nil
	}
	data, err := c.muteRPC(ctx, stage, "getContactsV2", false,
		GetContactsV2Request{TargetUserMids: []string{target}}, 2)
	if err != nil {
		return false, err
	}
	var result struct {
		Contacts map[string]struct {
			Contact struct {
				Mid      string          `json:"mid"`
				Settings json.RawMessage `json:"settings"`
			} `json:"contact"`
		} `json:"contacts"`
	}
	if json.Unmarshal(data, &result) != nil {
		return false, muteFailure(stage, errMuteResponse)
	}
	entry, found := result.Contacts[target]
	if !found || entry.Contact.Mid != "" && entry.Contact.Mid != target {
		return false, muteFailure(stage, errMuteTarget)
	}
	var settings json.Number
	if json.Unmarshal(entry.Contact.Settings, &settings) != nil {
		return false, muteFailure(stage, errMuteResponse)
	}
	flags, err := settings.Int64()
	if err != nil {
		return false, muteFailure(stage, errMuteResponse)
	}
	return flags&1 != 0, nil
}

// SetChatMuteContext uses the same operations as the Chrome client. A mutation
// is sent exactly once; only the subsequent read-only verification is retried.
func (c *Client) SetChatMuteContext(ctx context.Context, seq int64, target string, muted bool) error {
	if len(target) == 0 {
		return muteFailure("update mute setting", errMuteTarget)
	}
	prefix := strings.ToLower(target[:1])
	if prefix != "u" && prefix != "c" && prefix != "r" {
		return muteFailure("update mute setting", errMuteTarget)
	}
	direct := prefix == "u"
	if direct {
		if _, err := c.muteRPC(ctx, "update contact setting", "updateContactSetting", true,
			seq, target, 1, strconv.FormatBool(muted)); err != nil {
			return err
		}
	} else {
		chat, err := c.muteChatObject(ctx, target, "fetch chat settings")
		if err != nil {
			return err
		}
		// Preserve unknown fields, nested metadata, and number precision.
		chat["notificationDisabled"] = json.RawMessage(strconv.FormatBool(muted))
		request := struct {
			ReqSeq           int64                      `json:"reqSeq"`
			Chat             map[string]json.RawMessage `json:"chat"`
			UpdatedAttribute int                        `json:"updatedAttribute"`
		}{seq, chat, 8}
		if _, err := c.muteRPC(ctx, "update chat setting", "updateChat", true, request); err != nil {
			return err
		}
	}
	for attempt := 0; attempt < 3; attempt++ {
		actual, err := c.readChatMute(ctx, target, direct)
		if err != nil {
			return err
		}
		if actual == muted {
			return nil
		}
		if attempt < 2 {
			timer := time.NewTimer(time.Duration(attempt+1) * 100 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return muteFailure("verify mute setting", ctx.Err())
			case <-timer.C:
			}
		}
	}
	return muteFailure("verify mute setting", errMuteMismatch)
}

// Public contact metadata is also available for group members who are not
// friends. This lookup never adds contacts or changes relationships.
func (c *Client) GetPublicContactsContext(ctx context.Context, ids []string) ([]Contact, error) {
	resp, err := c.callRPCContext(ctx, "TalkService", "getContacts", ids)
	if err != nil {
		return nil, err
	}
	data, err := chatSettingData(resp, false)
	if err != nil {
		return nil, err
	}
	var contacts []Contact
	if err := json.Unmarshal(data, &contacts); err != nil {
		return nil, err
	}
	return contacts, nil
}
