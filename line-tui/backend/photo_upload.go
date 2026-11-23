package messaging

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
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

// PreparedPhoto owns its validated bytes. No mutable slices or decoded image
// escape, so callers cannot invalidate validation between preparation and send.
type PreparedPhoto struct {
	data      []byte
	info      *photoUpload
	thumbnail string
}

func (p *PreparedPhoto) Thumbnail() string {
	if p == nil {
		return ""
	}
	return p.thumbnail
}

func PreparePhoto(data []byte) (*PreparedPhoto, error) {
	if len(data) == 0 || len(data) > MaxAttachmentBytes {
		return nil, errors.New("choose PNG/JPEG photos up to 20 MiB")
	}
	owned := append([]byte(nil), data...)
	info, decoded, err := decodePhoto(owned)
	if err != nil {
		return nil, err
	}
	return &PreparedPhoto{data: owned, info: info, thumbnail: preparedThumbnail(decoded)}, nil
}

func (c *Client) SendPreparedPhoto(chat, name string, photo *PreparedPhoto, replyTo string) (*SendResult, error) {
	if photo == nil || photo.info == nil || len(photo.data) == 0 {
		return nil, errors.New("prepared photo unavailable")
	}
	return c.SendFile(chat, Attachment{Name: name, Data: photo.data, Image: true, prepared: photo}, replyTo)
}

// ValidatePhoto bounds decoded memory as well as input bytes. File extensions
// are not trusted. Originals stay unchanged. Plain-photo previews are generated
// by OBS; encrypted previews reuse the original ciphertext.
func ValidatePhoto(data []byte) error {
	_, err := PreparePhoto(data)
	return err
}

func decodePhoto(data []byte) (*photoUpload, image.Image, error) {
	if len(data) == 0 || len(data) > MaxAttachmentBytes {
		return nil, nil, errors.New("choose PNG/JPEG photos up to 20 MiB")
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || (format != "png" && format != "jpeg") || cfg.Width < 1 || cfg.Height < 1 ||
		cfg.Width > 8192 || cfg.Height > 8192 || int64(cfg.Width)*int64(cfg.Height) > 32_000_000 {
		return nil, nil, errors.New("photos must be valid PNG/JPEG, at most 8192 per side and 32 megapixels")
	}
	decoded, decodedFormat, err := image.Decode(bytes.NewReader(data))
	if err != nil || decodedFormat != format {
		return nil, nil, errors.New("could not decode PNG/JPEG photo")
	}
	ext := "jpg"
	if format == "png" {
		ext = "png"
	}
	return &photoUpload{cfg.Width, cfg.Height, cfg.Width, cfg.Height, ext}, decoded, nil
}

func preparedThumbnail(source image.Image) string {
	bounds := source.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	if max(w, h) > 512 {
		w, h = max(1, w*512/max(bounds.Dx(), bounds.Dy())), max(1, h*512/max(bounds.Dx(), bounds.Dy()))
	}
	for {
		small := image.NewRGBA(image.Rect(0, 0, w, h))
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				r, g, b, a := source.At(bounds.Min.X+(2*x+1)*bounds.Dx()/(2*w), bounds.Min.Y+(2*y+1)*bounds.Dy()/(2*h)).RGBA()
				small.SetRGBA(x, y, color.RGBA{uint8((r + 65535 - a) >> 8), uint8((g + 65535 - a) >> 8), uint8((b + 65535 - a) >> 8), 255})
			}
		}
		for _, quality := range []int{80, 60, 40} {
			var out bytes.Buffer
			if jpeg.Encode(&out, small, &jpeg.Options{Quality: quality}) == nil && out.Len() <= 65536 {
				return "data:image/jpeg;base64," + base64.StdEncoding.EncodeToString(out.Bytes())
			}
		}
		if w <= 64 && h <= 64 {
			return ""
		}
		w, h = max(1, w/2), max(1, h/2)
	}
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
	prepared := file.prepared
	if prepared == nil {
		var err error
		prepared, err = PreparePhoto(file.Data)
		if err != nil {
			return nil, photoFailure("validate photo", err)
		}
	}
	photo := prepared.info
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
	photo.metadata(metadata, len(data))
	return json.Marshal(map[string]string{"keyMaterial": key, "fileName": file.Name})
}
