package gui

import "github.com/kongesque/line-cli/internal/messaging"

type preparedPhoto = messaging.PreparedPhoto

func preparePhotoAttachment(data []byte) (*preparedPhoto, error) { return messaging.PreparePhoto(data) }

func sentPhotoThumbnail(file *Attachment) string {
	if file.photo != nil {
		return file.photo.Thumbnail()
	}
	return photoThumbnail(file.Data)
}

func photoFailureSummary(err error) string { return messaging.PhotoFailureSummary(err) }
