package application

import "studiotv.local/service/api/internal/modules/agentrun/domain"

// VerificationFailure retains only a bounded HTTP status and locally authored
// failure code. It never retains the verifier's error or response message.
type VerificationFailure struct {
	status int
	code   string
}

func (*VerificationFailure) Error() string { return "agent bearer verification unavailable" }
func (*VerificationFailure) Unwrap() error { return domain.ErrUnavailable }

func NewVerificationFailure(status int, code string) error {
	if status < 100 || status > 599 {
		status = 0
	}
	switch code {
	case "IPAC_UNAVAILABLE", "IPAC_AUTHORIZATION_UNAVAILABLE", "AUTH_BACKEND_UNAVAILABLE", "IPAC_NOT_CONFIGURED", "IPAC_SESSION_STATUS_UNAVAILABLE", "IPAC_PROTOCOL_UNSUPPORTED":
	default:
		code = "OTHER"
	}
	return &VerificationFailure{status: status, code: code}
}
