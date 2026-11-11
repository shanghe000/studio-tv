package bootstrap

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

func TestModelGatewayIsExplicitlyUnconfiguredAndRejectsPartialSettings(t *testing.T) {
	get := func(string) string { return "" }
	g, err := modelGateway(get)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = g.Capabilities(context.Background(), application.Actor{SubjectRef: "usr_a"}, application.CapabilityQuery{}); !errors.Is(err, application.ErrNotConfigured) {
		t.Fatal("missing configuration advertised models")
	}
	for _, key := range []string{"MODELS_ROUTER_BASE_URL", "MODELS_ROUTER_SERVICE_TOKEN", "MODELS_ROUTER_ACTOR_SIGNING_KEY_B64", "MODELS_ROUTER_CLIENT_APP"} {
		_, err = modelGateway(func(k string) string {
			if k == key {
				return "private-value"
			}
			return ""
		})
		if err == nil || strings.Contains(err.Error(), "private-value") {
			t.Fatal("partial config accepted or secret leaked")
		}
	}
}

func TestModelGatewayFileCredentialsBindServiceAndActor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 32) || r.Header.Get("X-Router-Client-App") != "test-product" || r.Header.Get("X-Router-Subject-Ref") != "usr_verified" || r.Header.Get("X-Router-Actor-Signature") == "" {
			t.Error("service/actor proof was lost")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Models-Router-Version", "1")
		_, _ = w.Write([]byte(`{"items":[],"nextCursor":null,"protocolVersion":"1"}`))
	}))
	defer server.Close()
	dir := t.TempDir()
	token := filepath.Join(dir, "token")
	key := filepath.Join(dir, "key")
	if os.WriteFile(token, []byte(strings.Repeat("t", 32)+"\n"), 0600) != nil || os.WriteFile(key, []byte(base64.StdEncoding.EncodeToString([]byte(strings.Repeat("k", 32)))+"\n"), 0600) != nil {
		t.Fatal("cannot create private test files")
	}
	values := map[string]string{"MODELS_ROUTER_BASE_URL": server.URL, "MODELS_ROUTER_CLIENT_APP": "test-product", "MODELS_ROUTER_SERVICE_TOKEN_FILE": token, "MODELS_ROUTER_ACTOR_SIGNING_KEY_B64_FILE": key}
	g, err := modelGateway(func(k string) string { return values[k] })
	if err != nil {
		t.Fatal(err)
	}
	page, err := g.Capabilities(context.Background(), application.Actor{SubjectRef: "usr_verified"}, application.CapabilityQuery{})
	if err != nil || page.Items == nil || len(page.Items) != 0 {
		t.Fatal("configured actual empty catalog was lost")
	}
	values["MODELS_ROUTER_SERVICE_TOKEN"] = "private-value"
	if _, err := modelGateway(func(k string) string { return values[k] }); err == nil || strings.Contains(err.Error(), "private-value") {
		t.Fatal("duplicate secret accepted or leaked")
	}
}
