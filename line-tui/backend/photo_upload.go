package messaging

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"strconv"

	"github.com/kongesque/line-cli/internal/session"
	"github.com/kongesque/line-cli/pkg/line"
)

type photoUpload struct {
	width, height  int
	thumbW, thumbH int
	extension      string
}

// ValidatePhoto bounds decoded memory as well as input bytes. File extensions
// are not trusted. Originals stay unchanged. Plain-photo previews are generated
// by OBS; encrypted previews reuse the original ciphertext.
func ValidatePhoto(data []byte) error {
	_, err := preparePhoto(data)
	return err
}

func preparePhoto(data []byte) (*photoUpload, error) {
	if len(data) == 0 || len(data) > MaxAttachmentBytes {
		return nil, errors.New("choose PNG/JPEG photos up to 20 MiB")
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "png" && format != "jpeg") || cfg.Width < 1 || cfg.Height < 1 ||
		cfg.Width > 8192 || cfg.Height > 8192 || int64(cfg.Width)*int64(cfg.Height) > 32_000_000 {
		return nil, errors.New("photos must be valid PNG/JPEG, at most 8192 per side and 32 megapixels")
	}
	_, decoded, err := image.Decode(bytes.NewReader(data))
	if err != nil || decoded != format {
		return nil, errors.New("could not decode PNG/JPEG photo")
	}
	ext := "jpg"
	if format == "png" {
		ext = "png"
	}
	return &photoUpload{cfg.Width, cfg.Height, cfg.Width, cfg.Height, ext}, nil
}

var errPhotoMessageID = errors.New("response contained no message ID")

// Keep protocol evidence for authentication classification, never its raw text.
type PhotoSendError struct {
	stage string
	cause error
}

func (e *PhotoSendError) Unwrap() error { return e.cause }
func (e *PhotoSendError) Error() string {
	summary := "request failed"
	var response *line.ResponseError
	var syntax *json.SyntaxError
	var fieldType *json.UnmarshalTypeError
	switch {
	case errors.Is(e.cause, context.DeadlineExceeded):
		summary = "request timed out"
	case errors.Is(e.cause, context.Canceled):
		summary = "request cancelled"
	case errors.Is(e.cause, errPhotoMessageID):
		summary = errPhotoMessageID.Error()
	case errors.As(e.cause, &response):
		summary = response.Error()
	case errors.As(e.cause, &syntax):
		summary = "invalid response JSON"
	case errors.As(e.cause, &fieldType):
		summary = "unexpected response field type"
	}
	return e.stage + ": " + summary
}

func photoFailure(stage string, cause error) error {
	if cause == nil {
		return nil
	}
	return &PhotoSendError{stage: stage, cause: cause}
}

func PhotoFailureSummary(err error) string {
	if err == nil {
		return "send acknowledgement: missing or invalid message result"
	}
	var detail *PhotoSendError
	if errors.As(err, &detail) {
		return detail.Error()
	}
	return (&PhotoSendError{stage: "prepare/send photo", cause: err}).Error()
}

func (p *photoUpload) metadata(metadata map[string]string, size int) {
	content, _ := json.Marshal(map[string]interface{}{
		"category": "original", "fileSize": size, "extension": p.extension,
		"width": p.width, "height": p.height,
	})
	thumb, _ := json.Marshal(map[string]int{"width": p.thumbW, "height": p.thumbH})
	metadata["MEDIA_CONTENT_INFO"], metadata["MEDIA_THUMB_INFO"] = string(content), string(thumb)
	metadata["contentType"] = "1"
}

func (c *Client) uploadPhoto(file *Attachment, metadata map[string]string) ([]byte, error) {
	photo, err := preparePhoto(file.Data)
	if err != nil {
		return nil, photoFailure("validate photo", err)
	}
	data, key, err := encryptFile(file.Data)
	if err != nil {
		return nil, photoFailure("encrypt photo", err)
	}
	defer clear(data)
	var oid string
	err = c.Session.Mutate(func(api session.API) error {
		uploader, ok := api.(interface {
			UploadOBSWithOIDAndSID([]byte, string, string) error
		})
		if !ok {
			return photoFailure("upload preview (encrypted)", errors.New("encrypted photo preview uploads unavailable"))
		}
		var err error
		oid, err = api.UploadOBSWithSID(data, "emi")
		if err != nil {
			return photoFailure("upload original (encrypted)", err)
		}
		if oid == "" {
			return photoFailure("upload original (encrypted)", errors.New("photo upload returned no object ID"))
		}
		// LINE uses the same key material for both objects. Reuse identical
		// ciphertext rather than encrypt different bytes under the same CTR
		// key/counter. This costs bandwidth but avoids keystream reuse.
		return photoFailure("upload preview (encrypted)", uploader.UploadOBSWithOIDAndSID(data, oid+"__ud-preview", "emi"))
	})
	if err != nil {
		return nil, err
	}
	metadata["OID"], metadata["SID"] = oid, "emi"
	metadata["FILE_SIZE"] = strconv.Itoa(len(file.Data))
	photo.thumbW, photo.thumbH = photo.width, photo.height
	photo.metadata(metadata, len(data))
	return json.Marshal(map[string]string{"keyMaterial": key, "fileName": file.Name})
}
