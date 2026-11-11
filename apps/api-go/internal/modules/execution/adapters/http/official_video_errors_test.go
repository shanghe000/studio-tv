package http

import (
	"errors"
	"testing"

	"studiotv.local/service/api/internal/httpapi"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func TestOfficialVideoFaultsHaveSafeActionableProductMessages(t *testing.T) {
	for _, code := range []string{"PROVIDER_CREDENTIAL_REQUIRED", "OFFICIAL_VIDEO_INSUFFICIENT_BALANCE", "OFFICIAL_VIDEO_AUTH_FAILED", "OFFICIAL_VIDEO_RATE_LIMITED", "OFFICIAL_VIDEO_REJECTED", "PROVIDER_CREDENTIAL_KEY_REMOVED"} {
		mapped := mapError(&gateway.Fault{Code: code})
		var api *httpapi.Error
		if !errors.As(mapped, &api) || api.Code != code || api.Message == "" || api.Message == code {
			t.Fatalf("official fault lost public meaning: %s", code)
		}
	}
}
