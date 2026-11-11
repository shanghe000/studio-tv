package codexappserver

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

func TestRuntimeDiagnosticsNeverFormatPrivateErrors(t *testing.T) {
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	defer slog.SetDefault(previous)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	diagnoseRuntime(ctx, phaseNotification, fmt.Errorf("Bearer private-secret native_thread_private: %w", ErrProfile))
	var record map[string]any
	if json.Unmarshal(output.Bytes(), &record) != nil {
		t.Fatal("invalid private diagnostic")
	}
	if record["phase"] != "notification" || record["error_class"] != "ErrProfile" || record["context_canceled"] != true || record["context_deadline"] != false {
		t.Fatal("missing normalized diagnostic")
	}
	if strings.Contains(output.String(), "Bearer") || strings.Contains(output.String(), "private-secret") || strings.Contains(output.String(), "native_thread_private") {
		t.Fatal("private error content entered diagnostics")
	}
	output.Reset()
	diagnoseRuntime(context.Background(), runtimePhase(255), fmt.Errorf("raw provider payload"))
	if json.Unmarshal(output.Bytes(), &record) != nil || record["phase"] != "unclassified" || record["error_class"] != "ErrUnknown" || strings.Contains(output.String(), "provider") {
		t.Fatal("unknown values bypassed fixed diagnostic enums")
	}
}
