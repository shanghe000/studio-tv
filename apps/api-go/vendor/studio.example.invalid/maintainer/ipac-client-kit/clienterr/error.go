// Package clienterr contains errors shared by the IPAC clients.
package clienterr

import (
	"errors"
	"fmt"
	"net"
)

// UpstreamError reports a failed request to IPAC. Message is safe for logs but
// should not normally be rendered directly to end users.
type UpstreamError struct {
	Operation  string
	StatusCode int
	Code       string
	Message    string
	LogID      string
	Cause      error
}

func (e *UpstreamError) Error() string {
	if e == nil {
		return "<nil>"
	}
	message := e.Message
	if message == "" {
		message = "IPAC request failed"
	}
	if e.Code != "" {
		message = e.Code + ": " + message
	}
	if e.Operation != "" {
		message = e.Operation + ": " + message
	}
	if e.StatusCode > 0 {
		message += fmt.Sprintf(" (HTTP %d)", e.StatusCode)
	}
	if e.LogID != "" {
		message += " [log_id=" + e.LogID + "]"
	}
	return message
}

func (e *UpstreamError) Unwrap() error { return e.Cause }

// Temporary reports whether retrying later can reasonably succeed. It does
// not prescribe a retry policy; authorization calls are intentionally not
// retried automatically by this module.
func (e *UpstreamError) Temporary() bool {
	if e == nil {
		return false
	}
	if e.StatusCode == 429 || e.StatusCode >= 500 {
		return true
	}
	var netError net.Error
	return errors.As(e.Cause, &netError) && netError.Timeout()
}

func (e *UpstreamError) AuthenticationFailed() bool {
	return e != nil && e.StatusCode == 401
}
