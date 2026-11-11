package http

import (
	"errors"
	"strings"
	"testing"

	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/execution/domain"
)

func TestMaterialGenerationRefusalIsSpecificBeforeGenericValidation(t *testing.T) {
	var api *httpapi.Error
	if !errors.As(mapError(domain.ErrMaterialOnly), &api) || api.Status != 422 || api.Code != "GENERATION_TARGET_REQUIRED" || !strings.Contains(api.Message, "上传素材") {
		t.Fatal("standalone material was hidden behind generic validation", api)
	}
}
