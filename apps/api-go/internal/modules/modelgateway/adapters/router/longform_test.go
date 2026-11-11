package router

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

func TestLongformSignsActorExactRequestAndScopedArtifact(t *testing.T) {
	project, artifact := uuid.NewString(), uuid.NewString()
	body := append([]byte("\x00\x00\x00\x18ftypisom"), bytes.Repeat([]byte{0}, 120)...)
	sum := sha256.Sum256(body)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		if r.Header.Get("X-Router-Subject-Ref") != "verified-user" || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 32) {
			t.Error("untrusted actor")
		}
		want := proofSignature(bytes.Repeat([]byte("k"), 32), r.Method, r.URL.RequestURI(), "studio-tv", "verified-user", r.Header.Get("X-Router-Actor-Timestamp"), r.Header.Get("X-Router-Actor-Nonce"), raw)
		if r.Header.Get("X-Router-Actor-Signature") != want {
			t.Error("request bytes not signed")
		}
		if strings.HasSuffix(r.URL.Path, "/artifacts/"+artifact) {
			if r.URL.Path != "/v1/longform/projects/"+project+"/artifacts/"+artifact {
				t.Error("artifact route")
			}
			w.Header().Set("Content-Type", "video/mp4")
			w.Header().Set("X-Models-Router-Version", "1")
			w.Header().Set("X-Checksum-SHA256", hex.EncodeToString(sum[:]))
			_, _ = w.Write(body)
			return
		}
		if r.Method == "POST" && !bytes.Contains(raw, []byte(`"seed":"18446744073709551615"`)) {
			t.Error("seed lost")
		}
		respond(w, 200, `{"id":"`+project+`","revision":1}`)
	}))
	defer server.Close()
	c, _ := New(configFor(server.URL))
	actor := application.Actor{SubjectRef: "verified-user"}
	raw := json.RawMessage(`{"requestId":"` + uuid.NewString() + `","settings":{"seed":"18446744073709551615"}}`)
	if _, e := c.LongformCreate(context.Background(), actor, raw); e != nil {
		t.Fatal(e)
	}
	if _, e := c.LongformAction(context.Background(), actor, project, raw); e != nil {
		t.Fatal(e)
	}
	art, got, e := c.LongformArtifact(context.Background(), actor, project, artifact)
	if e != nil || !bytes.Equal(got, body) || art.Ref != artifact || art.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatal("artifact metadata invalid", e)
	}
}
func TestLongformArtifactRejectsUnverifiedContent(t *testing.T) {
	body := append([]byte("\x00\x00\x00\x18ftypisom"), bytes.Repeat([]byte{0}, 120)...)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("X-Models-Router-Version", "1")
		w.Header().Set("X-Checksum-SHA256", strings.Repeat("a", 64))
		_, _ = w.Write(body)
	}))
	defer server.Close()
	c, _ := New(configFor(server.URL))
	if _, _, e := c.LongformArtifact(context.Background(), application.Actor{SubjectRef: "user"}, uuid.NewString(), uuid.NewString()); e == nil {
		t.Fatal("checksum mismatch accepted")
	}
}

func TestLongformStateLimitDoesNotBroadenOrdinaryGateway(t *testing.T) {
	large := `{"segments":[],"notes":"` + strings.Repeat("x", 3<<20) + `"}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { respond(w, 200, large) }))
	defer server.Close()
	c, _ := New(configFor(server.URL))
	actor := application.Actor{SubjectRef: "verified"}
	if raw, e := c.LongformProject(context.Background(), actor, uuid.NewString()); e != nil || len(raw) < 3<<20 {
		t.Fatal("longform state still capped at invocation limit", e)
	}
	var ordinary json.RawMessage
	if e := c.do(context.Background(), actor, "GET", "/v1/capabilities", nil, &ordinary); e == nil {
		t.Fatal("ordinary gateway limit broadened")
	}
}

func TestLongformOverCapacityStatePreservesUnknownSubmissionSemantics(t *testing.T) {
	huge := `{"notes":"` + strings.Repeat("x", 17<<20) + `"}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { respond(w, 200, huge) }))
	defer server.Close()
	c, _ := New(configFor(server.URL))
	_, e := c.LongformProject(context.Background(), application.Actor{SubjectRef: "verified"}, uuid.NewString())
	var fault *application.Fault
	if !errors.As(e, &fault) || fault.Code != "LONGFORM_STATE_TOO_LARGE" || fault.HTTPStatus != 0 {
		t.Fatal("capacity error pretended a definitive upstream request refusal", e)
	}
}
