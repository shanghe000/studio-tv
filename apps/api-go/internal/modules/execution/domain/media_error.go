package domain

import "strings"

// MediaErrorMessage allows only normalized media-specification diagnostics.
// Other provider errors retain their existing code-only/public mapping policy.
func MediaErrorMessage(code string, message *string) (string, bool) {
	switch code {
	case "MEDIA_INPUT_INVALID", "COMFY_MEDIA_DURATION", "COMFY_MEDIA_SIZE", "COMFY_MEDIA_DIMENSIONS", "H3_MEDIA_DURATION", "H3_MEDIA_SIZE", "H3_MEDIA_DIMENSIONS":
	default:
		return "", false
	}
	if message == nil || len(*message) == 0 || len(*message) > 4096 || strings.ContainsAny(*message, "\x00\r\n") || strings.Contains(*message, "://") {
		return "", false
	}
	return *message, true
}
