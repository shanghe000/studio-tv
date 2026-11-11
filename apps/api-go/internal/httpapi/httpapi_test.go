package httpapi

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDecodeLimitsAndMediaType(t *testing.T) {
	type body struct {
		Name string `json:"name"`
	}
	for _, test := range []struct {
		name, media, input, code string
		limit                    int64
	}{{"legal media", "application/json; charset=utf-8", `{"name":"ok"}`, "", 100}, {"false prefix", "application/jsonBAD", `{"name":"ok"}`, "CONTENT_TYPE_UNSUPPORTED", 100}, {"unknown", "application/json", `{"other":1}`, "UNKNOWN_FIELD", 100}, {"invalid syntax", "application/json", `{`, "MALFORMED_REQUEST", 100}, {"multiple", "application/json", `{"name":"ok"}{}`, "MALFORMED_REQUEST", 100}, {"too large", "application/json", `{"name":"longer"}`, "PAYLOAD_TOO_LARGE", 8}} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/", strings.NewReader(test.input))
			r.Header.Set("Content-Type", test.media)
			var value body
			e := DecodeLimit(httptest.NewRecorder(), r, &value, test.limit)
			if test.code == "" {
				if e != nil {
					t.Fatal(e)
				}
				return
			}
			api, ok := e.(*Error)
			if !ok || api.Code != test.code {
				t.Fatalf("wanted %s, got %v", test.code, e)
			}
		})
	}
}

func TestPreviewGrantLogPathRedaction(t *testing.T) {
	if got := logPath("/api/v2/studio/preview/hf_a/sensitive-jwt/assets/a.png"); got != "/api/v2/studio/preview/hf_a/[grant]/assets/a.png" {
		t.Fatal(got)
	}
	if got := logPath("/api/v2/tasks/tsk_a"); got != "/api/v2/tasks/tsk_a" {
		t.Fatal(got)
	}
}
