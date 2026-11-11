package codexappserver

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"studio.example.invalid/models-router/internal/application"
	"studio.example.invalid/models-router/internal/domain"
	"reflect"
	"strings"
	"testing"
)

type auditResolver struct{}

func (auditResolver) Resolve(_ context.Context, _ domain.Actor, a application.Attachment, _ RuntimeBinding) (ResolvedImage, error) {
	b, e := auditBytes(a)
	return ResolvedImage{Bytes: b, MediaType: "image/png"}, e
}
func TestCanvasAuditLastHop(t *testing.T) {
	for _, m := range []struct {
		ref, model    string
		vision, image bool
	}{
		{"codex-text-v1", "gpt-6.1-sol", false, false}, {"codex-vision-text-v1", "gpt-6.1-sol", true, false}, {"codex-5-6-text-v1", "gpt-5.6-sol", false, false}, {"codex-6-text-v1", "gpt-6-sol", false, false}, {"codex-6-1-text-v1", "gpt-6.1-sol", false, false}, {"codex-6-vision-text-v1", "gpt-6-sol", true, false}, {"codex-6-1-vision-text-v1", "gpt-6.1-sol", true, false}, {"codex-image-generate-v1", "", false, true}, {"codex-image-edit-v1", "", true, true},
	} {
		t.Run(m.ref, func(t *testing.T) {
			r := reasoningRequest("Create a concise story")
			r.Parameters["reasoningEffort"] = json.RawMessage(`"high"`)
			if m.image {
				n := 0
				if m.vision {
					n = 2
				}
				r = imageToolsInput(n, 2)
				r.Parameters["transparentBackground"] = json.RawMessage("true")
			} else if m.vision {
				r = imageRequest()
				r.Capability.Version = "2"
				r.ParameterSchemaVersion = "2"
				r.Parameters["reasoningEffort"] = json.RawMessage(`"high"`)
			}
			legacy := m.ref == "codex-text-v1" || m.ref == "codex-vision-text-v1"
			if legacy {
				r.Capability.Version, r.ParameterSchemaVersion = "1", "1"
				r.Parameters = map[string]json.RawMessage{}
			}
			r.Capability.Ref = m.ref
			for i := range r.Attachments {
				r.Attachments[i].SHA256 = auditSHA(auditFixtureBytes)
			}
			for i, req := range append([]application.InvocationRequest{r}, capturedAudit(t, m.ref)...) {
				t.Run(auditCaseName(m.ref, i), func(t *testing.T) {
					rpc := &fixtureRPC{next: make(chan Notification, 32), responseModel: m.model}
					store := newStore()
					var a *Adapter
					var err error
					if m.image {
						a, err = NewImageTools(Config{CapabilityRef: m.ref, CapabilityVersion: "3"}, imageRuntimeFixture{rpc, imageConfig()}, store, auditResolver{}, m.vision)
					} else {
						cfg := reasoningConfig()
						if legacy {
							cfg = Config{CapabilityVersion: "1"}
						}
						cfg.CapabilityRef = m.ref
						a, err = New(cfg, selectedModelRuntime{runtimeFixture{rpc, actor}, m.model}, store, auditResolver{})
					}
					if err != nil {
						t.Fatal(err)
					}
					submit(t, a, req, "audit")
					var start struct {
						Input  []map[string]any
						Effort string
					}
					if json.Unmarshal(rpc.params("turn/start"), &start) != nil || rpc.count("turn/start") != 1 || len(start.Input) == 0 {
						t.Fatal("no native turn")
					}
					// Prior messages are seeded with thread/inject_items; only the last
					// message is sent by turn/start. Validate image byte identity in both.
					got := []string{}
					appendImage := func(uri string) {
						_, b, ok := strings.Cut(uri, ",")
						raw, err := base64.StdEncoding.DecodeString(b)
						if !ok || err != nil {
							t.Fatal("bad app-server image")
						}
						got = append(got, auditSHA(raw))
					}
					var seed struct {
						Items []struct {
							Content []struct {
								Type     string
								ImageURL string `json:"image_url"`
							}
						}
					}
					if b := rpc.params("thread/inject_items"); b != nil {
						if err := json.Unmarshal(b, &seed); err != nil {
							t.Fatal(err)
						}
						for _, item := range seed.Items {
							for _, part := range item.Content {
								if part.Type == "input_image" {
									appendImage(part.ImageURL)
								}
							}
						}
					}
					for _, p := range start.Input {
						if p["type"] == "image" {
							appendImage(fmt.Sprint(p["url"]))
						}
					}
					want := []string{}
					byRef := map[string]string{}
					for _, a := range req.Attachments {
						byRef[a.Ref] = a.SHA256
					}
					if req.PromptSpec != nil {
						for _, m := range req.PromptSpec.Messages {
							for _, i := range m.InputIndexes {
								part := req.Input[i]
								if part.Type == "MEDIA" {
									want = append(want, byRef[*part.AttachmentRef])
								}
							}
						}
					} else {
						for _, a := range auditOrdered(req) {
							want = append(want, a.SHA256)
						}
					}
					if !reflect.DeepEqual(got, want) {
						t.Fatalf("mismatched native images: received %d expected %d in message order", len(got), len(want))
					}
					if !m.image {
						var thread struct{ Model string }
						json.Unmarshal(rpc.params("thread/start"), &thread)
						effort := "low"
						if legacy {
							effort = ""
						}
						if req.Parameters["reasoningEffort"] != nil {
							json.Unmarshal(req.Parameters["reasoningEffort"], &effort)
						}
						if thread.Model != m.model || start.Effort != effort {
							t.Fatal("wrong native model/effort")
						}
					} else {
						record := store.records[scopeKey(application.InvocationScope{Actor: actor, InvocationRef: "audit"})]
						count := 1
						if req.Parameters["count"] != nil {
							json.Unmarshal(req.Parameters["count"], &count)
						}
						if record.ExpectedImageCount != count {
							t.Fatal("wrong image count")
						}
						if string(req.Parameters["transparentBackground"]) == "true" && !strings.Contains(string(rpc.params("thread/start")), "transparent_background argument to true") {
							t.Fatal("transparency not passed")
						}
					}
				})
			}
		})
	}
}
