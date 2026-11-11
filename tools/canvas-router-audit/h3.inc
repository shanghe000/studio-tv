package h3

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"studio.example.invalid/models-router/internal/adapters/studiomedia"
	"studio.example.invalid/models-router/internal/application"
	"studio.example.invalid/models-router/internal/domain"
	"strings"
	"testing"
)

type auditMedia struct{}

func (auditMedia) ResolveMedia(_ context.Context, _ domain.Actor, a application.Attachment) (studiomedia.Media, error) {
	b, e := auditBytes(a)
	if e != nil {
		return studiomedia.Media{}, e
	}
	m, e := auditFacts(a)
	return studiomedia.Media{Bytes: b, MediaType: m.Mime, Width: m.Width, Height: m.Height, DurationMs: m.Duration}, e
}
func (m auditMedia) ResolveSourceMotionVideo(c context.Context, a domain.Actor, r application.Attachment) (studiomedia.Media, error) {
	return m.ResolveMedia(c, a, r)
}
func TestCanvasAuditLastHop(t *testing.T) {
	raw, err := os.ReadFile("../../../config/production-profile-snapshots/comfy-profiles-20261102-motion-moss.json")
	if err != nil {
		t.Fatal(err)
	}
	m, err := ParseManifest(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Profiles) != 19 {
		t.Fatal(len(m.Profiles))
	}
	for _, pr := range m.Profiles {
		pr := pr
		t.Run(pr.CapabilityRef, func(t *testing.T) {
			p := pending(pr.CapabilityRef)
			r := p.Request
			r.Capability.Version = pr.Version
			r.ParameterSchemaVersion = pr.Version
			r.Input = r.Input[:1]
			r.Attachments = []application.Attachment{}
			add := func(kind domain.MediaKind) {
				i := len(r.Attachments)
				ref := fmt.Sprintf("input-%d", i)
				r.Attachments = append(r.Attachments, application.Attachment{Ref: ref, SourceRef: "source-" + ref, Kind: kind, ReadGrantRef: "grant-" + ref, SourceVersion: "1", SHA256: auditSHA(auditFixtureBytes)})
				r.Input = append(r.Input, application.InputPart{Type: "MEDIA", AttachmentRef: &ref})
			}
			images := pr.InputShape.MinImages
			if images == 0 && pr.InputShape.RequireVisual {
				images = 1
			}
			for i := 0; i < images; i++ {
				add(domain.MediaImage)
			}
			for i := 0; i < pr.InputShape.MinVideos; i++ {
				add(domain.MediaVideo)
			}
			last := pr.OutputPresets[len(pr.OutputPresets)-1]
			r.Parameters["outputPreset"], _ = json.Marshal(last.Value)
			if len(pr.CountChoices) > 0 {
				r.Parameters["count"], _ = json.Marshal(pr.CountChoices[len(pr.CountChoices)-1])
			}
			if pr.Motion != nil && pr.Motion.MappingRequired {
				r.Parameters["subjectMapping"] = json.RawMessage(`[{"referenceSubjectIndex":1,"sourceSubjectIndex":0},{"referenceSubjectIndex":0,"sourceSubjectIndex":2}]`)
			}
			requests := append([]application.InvocationRequest{r}, capturedAudit(t, pr.CapabilityRef)...)
			for i, req := range requests {
				t.Run(auditCaseName(pr.CapabilityRef, i), func(t *testing.T) {
					p := pending(pr.CapabilityRef)
					p.Request = req
					p.RequestHash, _ = req.ImmutableHash()
					p.Invocation.OperationRef = req.OperationRef
					p.Invocation.Execution = &domain.Execution{ExecutionKind: "MODEL", CapabilityRef: pr.CapabilityRef, CapabilityVersion: pr.Version}
					accepted := 0
					uploads := 0
					mediaIDs := map[string]string{}
					srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.Method != "POST" {
							t.Errorf("non-POST")
							return
						}
						if r.URL.Path == "/v1/media" {
							uploads++
							id := fmt.Sprintf("30000000-0000-4000-8000-%012d", uploads)
							uploaded, err := io.ReadAll(r.Body)
							if err != nil {
								t.Errorf("upload read failed")
							}
							mediaIDs[id] = auditSHA(uploaded)
							json.NewEncoder(w).Encode(map[string]string{"media_id": id})
							return
						}
						if r.URL.Path != "/v1/jobs" {
							t.Errorf("unexpected route")
							return
						}
						accepted++
						var b map[string]any
						if json.NewDecoder(r.Body).Decode(&b) != nil || b["profile_id"] != pr.ProfileID {
							t.Errorf("wrong profile")
						}
						if pr.Kind != "IMAGE_ENHANCE" && !(pr.Motion != nil && pr.Motion.PromptPolicy == "ignored") {
							text, _ := b["prompt"].(string)
							auditUserText(t, req, text)
						}
						preset, ok := pr.preset(req.Parameters)
						if !ok || b["output_preset"] != preset.Value {
							t.Errorf("wrong preset")
						}
						if preset.Width > 0 && (b["width"] != float64(preset.Width) || b["height"] != float64(preset.Height)) {
							t.Errorf("wrong dimensions")
						}
						if preset.DurationSeconds > 0 && b["duration_seconds"] != float64(preset.DurationSeconds) {
							t.Errorf("wrong duration")
						}
						if len(pr.CountChoices) > 0 {
							count, ok := pr.count(req.Parameters)
							if !ok || b["count"] != float64(count) {
								t.Errorf("wrong count")
							}
						}
						if pr.Motion != nil && pr.Motion.MappingRequired {
							actual, _ := json.Marshal(b["subject_mapping"])
							var want, got any
							json.Unmarshal(req.Parameters["subjectMapping"], &want)
							json.Unmarshal(actual, &got)
							if fmt.Sprint(got) != fmt.Sprint(want) {
								t.Errorf("wrong subject pairs")
							}
						}
						used := 0
						for _, k := range []string{"first_frame_media_id", "last_frame_media_id", "reference_image_media_ids", "reference_audio_media_ids", "reference_video_media_ids"} {
							switch v := b[k].(type) {
							case string:
								if mediaIDs[v] == "" {
									t.Errorf("unknown uploaded ID")
								}
								used++
							case []any:
								for _, id := range v {
									if mediaIDs[fmt.Sprint(id)] == "" {
										t.Errorf("unknown uploaded ID")
									}
									used++
								}
							}
						}
						slots := map[string]int{}
						for _, a := range auditOrdered(req) {
							field := "reference_" + strings.ToLower(string(a.Kind)) + "_media_ids"
							if a.Kind == domain.MediaImage && (pr.VideoMode == "FIRST_FRAME" || pr.VideoMode == "FIRST_LAST_FRAME") {
								role := auditRole(req, a.Ref)
								if role == "LAST_FRAME" || role == "" && slots["frames"] > 0 {
									field = "last_frame_media_id"
								} else {
									field = "first_frame_media_id"
								}
								slots["frames"]++
							}
							var id string
							switch v := b[field].(type) {
							case string:
								id = v
							case []any:
								if j := slots[field]; j < len(v) {
									id = fmt.Sprint(v[j])
								}
								slots[field]++
							}
							if mediaIDs[id] != a.SHA256 {
								t.Errorf("wrong uploaded bytes, role or ordering for %s", field)
							}
						}
						if used != len(req.Attachments) {
							t.Errorf("attachment loss: %d != %d", used, len(req.Attachments))
						}
						if pr.VideoMode == "FIRST_LAST_FRAME" && b["first_frame_media_id"] == b["last_frame_media_id"] {
							t.Errorf("first and last frame collapsed")
						}
						json.NewEncoder(w).Encode(map[string]any{"job_id": "10000000-0000-4000-8000-000000000001", "request_id": p.Invocation.Ref, "profile_id": pr.ProfileID, "status": "RUNNING", "outputs": []any{}})
					}))
					defer srv.Close()
					e, err := NewWithManifest(Config{srv.URL, strings.Repeat("k", 32)}, &memoryStore{}, auditMedia{}, Manifest{SchemaVersion: 1, Profiles: []ManifestProfile{pr}})
					if err != nil {
						t.Fatal(err)
					}
					defer e.Close()
					o, _, err := e.Execute(context.Background(), p)
					if err != nil || accepted != 1 || uploads != len(req.Attachments) || o.State != domain.Running {
						t.Fatalf("no correct Comfy submission: posts=%d uploads=%d state=%s fault=%v", accepted, uploads, o.State, o.NormalizedError)
					}
				})
			}
		})
	}
}
