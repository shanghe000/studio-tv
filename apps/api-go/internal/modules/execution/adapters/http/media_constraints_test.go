package http

import (
	"errors"
	"testing"

	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/execution/application"
)

func TestMediaInputRejectionPreservesActionableMessageAnd422(t *testing.T) {
	message := "参考视频时长为 55.519 秒，当前模型支持 2–30 秒；请裁剪后重试。"
	var api *httpapi.Error
	if !errors.As(mapError(&application.MediaInputError{Message: message}), &api) || api.Status != 422 || api.Code != "MEDIA_INPUT_INVALID" || api.Message != message {
		t.Fatal("media validation was hidden as a storage or protocol error", api)
	}
}
