package gui

import "github.com/kongesque/line-cli/internal/messaging"

func validatePhotoAttachment(data []byte) error { return messaging.ValidatePhoto(data) }

func photoFailureSummary(err error) string { return messaging.PhotoFailureSummary(err) }
