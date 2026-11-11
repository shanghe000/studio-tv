package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"

	"studiotv.local/service/api/internal/modules/agentrun/domain"
)

func TestAgentDiagnosticsContainOnlyFixedClassificationAndContextState(t *testing.T) {
	var output bytes.Buffer
	prior := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(prior) })
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	expired, stop := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer stop()
	for _, tt := range []struct {
		ctx   context.Context
		err   error
		class string
		state string
	}{
		{context.Background(), fmt.Errorf("private-bearer-and-body: %w", domain.ErrUnavailable), "UNAVAILABLE", "ACTIVE"},
		{canceled, domain.ErrFenced, "LEASE_FENCED", "CANCELED"},
		{expired, context.DeadlineExceeded, "DEADLINE_EXCEEDED", "DEADLINE_EXCEEDED"},
		{context.Background(), errors.New("private-provider-response"), "OTHER", "ACTIVE"},
	} {
		output.Reset()
		logRunFailure(tt.ctx, "agr_test", "BROKER_EXECUTE", tt.err)
		var entry map[string]any
		if err := json.Unmarshal(output.Bytes(), &entry); err != nil {
			t.Fatal(err)
		}
		if entry["runId"] != "agr_test" || entry["stage"] != "BROKER_EXECUTE" || entry["errorClass"] != tt.class || entry["contextState"] != tt.state {
			t.Fatalf("wrong normalized diagnostic: %v", entry)
		}
		if len(entry) != 7 || strings.Contains(output.String(), "private-") {
			t.Fatal("diagnostic included private material or extra fields")
		}
	}
}

func TestVerificationDiagnosticRetainsOnlyLocalCodesWithoutOriginalError(t *testing.T) {
	var output bytes.Buffer
	prior := slog.Default()
	slog.SetDefault(slog.New(slog.NewJSONHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(prior) })
	for _, tt := range []struct {
		status int
		code   string
		want   string
	}{
		{503, "IPAC_UNAVAILABLE", "IPAC_UNAVAILABLE"},
		{503, "IPAC_AUTHORIZATION_UNAVAILABLE", "IPAC_AUTHORIZATION_UNAVAILABLE"},
		{503, "AUTH_BACKEND_UNAVAILABLE", "AUTH_BACKEND_UNAVAILABLE"},
		{503, "private-bearer-or-provider-body", "OTHER"},
	} {
		output.Reset()
		err := NewVerificationFailure(tt.status, tt.code)
		if !errors.Is(err, domain.ErrUnavailable) || strings.Contains(err.Error(), tt.code) {
			t.Fatal("verification classification changed failure semantics or retained raw material")
		}
		logRunFailure(context.Background(), "agr_test", "BROKER_WAIT_CREDENTIAL", err)
		var entry map[string]any
		if err := json.Unmarshal(output.Bytes(), &entry); err != nil {
			t.Fatal(err)
		}
		if len(entry) != 9 || entry["verificationStatus"] != float64(tt.status) || entry["verificationCode"] != tt.want || entry["errorClass"] != "UNAVAILABLE" || strings.Contains(output.String(), "private-") {
			t.Fatalf("unsafe or missing verifier diagnostic: %v", entry)
		}
	}
}
