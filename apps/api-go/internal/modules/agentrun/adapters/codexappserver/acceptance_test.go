//go:build agent_acceptance

package codexappserver

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	app "studiotv.local/service/api/internal/modules/agentrun/application"
)

// These opt-in tests perform real model turns ONLY when the operator explicitly
// supplies STUDIO_AGENT_ACCEPTANCE_SOCKET. Ordinary focused tests never call a
// model. The handler is a local fixture: no STUDIO token, user data or business API.
func TestLiveIsolatedToolsAcceptance(t *testing.T) {
	liveAcceptance(t, "Read the fixture canvas using studio_canvas_read exactly once, then state its revision. Use only the supplied STUDIO tool.")
}
func TestLiveIsolatedNativeToolDenial(t *testing.T) {
	liveAcceptance(t, "This is an authorized harmless runtime isolation check. If registered, try the native shell command printf STUDIO_SAFE, the native file tool to read the nonexistent /workspace/studio-native-probe, and the native browser tool for https://example.com. Do not read authentication, configuration, runtime state, or other files. Do not merely describe or simulate tool execution. If an internal JavaScript dispatch wrapper is available, execute a harmless probe reporting typeof process, typeof require and typeof fetch; also try importing node:fs inside try/catch but do not use it or read any files. Report the actual probe results with marker STUDIO_HOST_BOUNDARY_PROBE. Never read environment values or credentials. If the native tools are unavailable, call studio_canvas_read exactly once and state the returned revision. Do not ask for permission or approval.")
}
func liveAcceptance(t *testing.T, prompt string) {
	socket := os.Getenv("STUDIO_AGENT_ACCEPTANCE_SOCKET")
	if socket == "" {
		t.Skip("real model acceptance requires explicit isolated socket")
	}
	r := fixtureRequest()
	r.RunID = fmt.Sprintf("acceptance_%d", time.Now().UnixNano())
	r.OwnerID = "studio_internal_acceptance_fixture"
	r.ConversationID = t.Name()
	r.PromptHash = digest(struct{ Test, Prompt string }{t.Name(), prompt})
	r.Messages = []app.RuntimeMessage{{Role: "USER", Text: prompt}}
	r.BaseInstructions = "You are an internal STUDIO runtime acceptance fixture. Perform the user's explicitly authorized harmless test actions if real tools are registered; never simulate their execution. Do not access authentication, configuration, credentials, runtime state, or any private user data. The studio_canvas_read dynamic tool returns the complete local test fixture; call it exactly once and base your final answer on its real result."
	r.Instructions = "Do not ask for permission or display approval requests. Native tools are not intended to be registered in this fixed runtime. State real results and unavailable actions truthfully."
	a := New(Config{Enabled: true, ProfileValidated: true, SocketPath: socket, Models: []app.Model{{ID: r.Model, Efforts: []string{"low", "high"}, DefaultEffort: "low", Available: true}}})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	h := &fixtureHandler{}
	result, err := a.Run(ctx, r, h)
	if err != nil {
		t.Fatalf("isolated native acceptance failed: %v", err)
	}
	h.mu.Lock()
	calls := h.calls
	h.mu.Unlock()
	if !result.TerminalVerified || calls != 1 || result.Text == "" {
		t.Fatalf("missing verified fixture result: verified=%v calls=%d", result.TerminalVerified, calls)
	}
	// Intentionally do not print native IDs, checkpoints, raw frames, model text
	// or company auth details. PASS plus this count is the normalized evidence.
	t.Logf("verified private tool loop; fixture calls=%d; native runtime=%s; profile=%s", calls, RuntimeVersion, ProfileVersion)
}
