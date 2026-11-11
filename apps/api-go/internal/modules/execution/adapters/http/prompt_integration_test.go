package http

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"studiotv.local/service/api/internal/httpapi"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
	"studiotv.local/service/api/internal/modules/modelgateway/adapters/router"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

// This test crosses the STUDIO HTTP/application/frozen-task boundary and the actual
// signed Router HTTP client, with explicit receipt fixtures and no provider.
type promptMemoryStore struct {
	execution.Store
	mu       sync.Mutex
	task     domain.Task
	claimed  bool
	creates  int
	finished chan struct{}
	once     sync.Once
}

func copyPromptTask(t domain.Task) domain.Task {
	t.Plans = append([]domain.Plan(nil), t.Plans...)
	return t
}
func (s *promptMemoryStore) Create(_ context.Context, t domain.Task, _, _ string, _ []execution.Grant) (domain.Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.task = copyPromptTask(t)
	s.creates++
	return t, nil
}
func (*promptMemoryStore) Assets(context.Context, string, []string) ([]execution.Asset, error) {
	return []execution.Asset{}, nil
}
func (s *promptMemoryStore) Claim(context.Context, string) (domain.Task, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.claimed || s.task.ID == "" {
		return domain.Task{}, false, nil
	}
	s.claimed = true
	return copyPromptTask(s.task), true, nil
}
func (s *promptMemoryStore) Save(_ context.Context, t domain.Task, _ string) (bool, error) {
	s.mu.Lock()
	s.task = copyPromptTask(t)
	s.mu.Unlock()
	if domain.Terminal(t.State) {
		s.once.Do(func() { close(s.finished) })
	}
	return true, nil
}
func (s *promptMemoryStore) Get(context.Context, string, string) (domain.Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return copyPromptTask(s.task), nil
}

type promptUnusedImporter struct{ execution.AssetImporter }

func TestBrowserStudioApplicationSignedRouterPromptSubmission(t *testing.T) {
	key := []byte(strings.Repeat("k", 32))
	captured := make(chan gateway.InvocationRequest, 1)
	var mu sync.Mutex
	var invocation gateway.Invocation
	var exactReads int
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("X-Router-Subject-Ref") != "verified-owner" {
			t.Error("browser actor replaced verified identity")
		}
		digest := sha256.Sum256(body)
		canonical := strings.Join([]string{"models-router.actor.v1", r.Method, r.URL.RequestURI(), "studio-tv", "verified-owner", r.Header.Get("X-Router-Actor-Timestamp"), r.Header.Get("X-Router-Actor-Nonce"), hex.EncodeToString(digest[:]), r.Header.Get("Idempotency-Key")}, "\n")
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(canonical))
		if r.Header.Get("X-Router-Actor-Signature") != "v1="+base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) {
			t.Error("prompt body/idempotency not covered by verified actor proof")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Models-Router-Version", "1")
		switch {
		case r.Method == "GET" && r.URL.Path == "/v1/capabilities":
			_, _ = w.Write([]byte(`{"protocolVersion":"1","items":[{"capabilityRef":"mock-llm","version":"1","kind":"LLM","executionKind":"MODEL","parameterSchemaVersion":"1","parameterSchema":{"type":"object","additionalProperties":false},"inputKinds":["TEXT","STRUCTURED"],"outputKinds":["TEXT"],"available":true,"testMode":true}],"nextCursor":null}`))
		case r.Method == "GET" && r.URL.Path == "/extensions/capability-versions/v1/capability":
			query := r.URL.Query()
			if len(query) != 2 || len(query["ref"]) != 1 || len(query["version"]) != 1 || query.Get("ref") != "mock-llm" || query.Get("version") != "1" || len(body) != 0 || r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 32) || r.Header.Get("X-Router-Client-App") != "studio-tv" {
				t.Error("exact capability query did not preserve the signed pair and service identity")
				w.WriteHeader(400)
				return
			}
			mu.Lock()
			exactReads++
			mu.Unlock()
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write([]byte(`{"capabilityRef":"mock-llm","version":"1","kind":"LLM","executionKind":"MODEL","parameterSchemaVersion":"1","parameterSchema":{"type":"object","additionalProperties":false},"inputKinds":["TEXT","STRUCTURED"],"outputKinds":["TEXT"],"available":true,"testMode":true}`))
		case r.Method == "POST" && r.URL.Path == "/v1/invocations":
			var request gateway.InvocationRequest
			if json.Unmarshal(body, &request) != nil {
				t.Error("invalid submission JSON")
				w.WriteHeader(400)
				return
			}
			text := "[TEST MODE] explicit receipt fixture; no model executed"
			now := time.Now().UTC()
			mu.Lock()
			invocation = gateway.Invocation{Ref: "inv_mock", OperationRef: request.OperationRef, State: "SUCCEEDED", TestMode: true, CreatedAt: now, UpdatedAt: now, OutputParts: []gateway.OutputPart{{OutputRef: "out_mock", Type: "TEXT", Text: &text, TestMode: true}}, Artifacts: []gateway.Artifact{}}
			receipt := invocation
			mu.Unlock()
			captured <- request
			w.WriteHeader(202)
			_ = json.NewEncoder(w).Encode(receipt)
		case r.Method == "GET" && r.URL.Path == "/v1/invocations/inv_mock":
			mu.Lock()
			receipt := invocation
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(receipt)
		default:
			t.Errorf("unexpected mock path %s", r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer mock.Close()
	client, err := router.New(router.Config{BaseURL: mock.URL, ClientApp: "studio-tv", ServiceToken: strings.Repeat("t", 32), SigningKey: key})
	if err != nil {
		t.Fatal(err)
	}
	store := &promptMemoryStore{finished: make(chan struct{})}
	service, err := execution.New(store, client, &promptUnusedImporter{})
	if err != nil {
		t.Fatal(err)
	}
	studio := chi.NewRouter()
	err = RegisterRoutes(studio, service, func(permission string, next httpapi.Handler) http.HandlerFunc {
		if permission != "tv.access" {
			t.Fatal("unexpected permission authority")
		}
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return next(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: "verified-owner"}))
		})
	})
	if err != nil {
		t.Fatal(err)
	}
	post := func(data string) *httptest.ResponseRecorder {
		body := `{"projectId":"project","targetType":"NODE","targetId":"node","graph":{"nodes":[{"id":"node","type":"rh-text","data":` + data + `}],"edges":[]}}`
		r := httptest.NewRequest("POST", "/api/v2/canvas-runs", strings.NewReader(body))
		r.Header.Set("Idempotency-Key", uuid.NewString())
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Router-Subject-Ref", "browser-forged-owner")
		w := httptest.NewRecorder()
		studio.ServeHTTP(w, r)
		return w
	}
	for _, test := range []struct {
		data   string
		status int
		code   string
	}{
		{`{"capabilityRef":"mock-llm","sceneCode":"unknown","prompt":"x"}`, 501, "PROMPT_TEMPLATE_NOT_CONFIGURED"},
		{`{"capabilityRef":"mock-llm","params":{"prompt":"x","systemPrompt":"browser instructions"}}`, 422, "UNTRUSTED_PROMPT_INSTRUCTIONS"},
	} {
		response := post(test.data)
		if response.Code != test.status || !strings.Contains(response.Body.String(), test.code) {
			t.Fatalf("status=%d response=%s", response.Code, response.Body.String())
		}
	}
	response := post(`{"capabilityRef":"mock-llm","text":"stale displayed output","params":{"prompt":"actual generation input"},"promptSelection":{"schemaVersion":"1","featureCode":"prompt.enhance","conditions":{"nodeCategory":"IMAGE","refImageCount":0}}}`)
	if response.Code != 202 {
		t.Fatalf("STUDIO submission status=%d body=%s", response.Code, response.Body.String())
	}
	ctx, stop := context.WithTimeout(context.Background(), 3*time.Second)
	defer stop()
	done := make(chan struct{})
	go func() { defer close(done); service.Run(ctx) }()
	defer func() { stop(); <-done }()
	var request gateway.InvocationRequest
	select {
	case request = <-captured:
	case <-ctx.Done():
		t.Fatal("signed submission did not reach Router")
	}
	if request.PromptSpec == nil || request.PromptSpec.TemplateRef != "studio-tv/feature/prompt.enhance" || len(request.PromptSpec.Instructions) != 2 || len(request.PromptSpec.TemplateSHA256) != 64 {
		t.Fatal("trusted STUDIO instruction template missing from actual signed request")
	}
	input, _ := json.Marshal(request.Input)
	if !strings.Contains(string(input), "actual generation input") || strings.Contains(string(input), "stale displayed output") || !strings.Contains(string(input), "STUDIO_PROMPT_CONDITIONS_V1") {
		t.Fatal("input/conditions were dropped or stale output substituted")
	}
	select {
	case <-store.finished:
	case <-ctx.Done():
		t.Fatal("receipt fixture did not complete")
	}
	store.mu.Lock()
	task, creates := store.task, store.creates
	store.mu.Unlock()
	if creates != 1 || task.State != "SUCCEEDED" || !task.TestMode || len(task.Plans[0].Outputs) != 1 || !task.Plans[0].Outputs[0].TestMode {
		t.Fatal("fixture status or test provenance lost")
	}
	mu.Lock()
	reads := exactReads
	mu.Unlock()
	if reads != 1 || request.Capability.Ref != "mock-llm" || request.Capability.Version != "1" || request.ParameterSchemaVersion != "1" || string(request.Parameters) != "{}" {
		t.Fatal("worker did not retain the exact signed version-1 metadata")
	}
}
