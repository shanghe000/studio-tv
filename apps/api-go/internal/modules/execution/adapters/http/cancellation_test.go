package http

import (
	"errors"
	"testing"

	"studiotv.local/service/api/internal/httpapi"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func TestUnsupportedVideoCancellationIsNotReportedAsTransientRouterOutage(t *testing.T) {
	var response *httpapi.Error
	if !errors.As(mapError(&gateway.Fault{Code: "VIDEO_CANCEL_UNSUPPORTED"}), &response) || response.Status != 501 || response.Code != "VIDEO_CANCEL_UNSUPPORTED" {
		t.Fatal("unsupported cancellation was hidden as a retryable infrastructure failure")
	}
}
