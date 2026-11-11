package officialvideo

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"studio.example.invalid/models-router/internal/adapters/studiomedia"
	"studio.example.invalid/models-router/internal/application"
	"studio.example.invalid/models-router/internal/domain"
	"strings"
	"testing"
)

type auditMedia struct{ mediaStub }

func (auditMedia) ResolveMedia(ctx context.Context, actor domain.Actor, a application.Attachment) (studiomedia.Media, error) {
	b, e := auditBytes(a)
	if e != nil {
		return studiomedia.Media{}, e
	}
	m, e := auditFacts(a)
	return studiomedia.Media{Bytes: b, MediaType: m.Mime, Width: m.Width, Height: m.Height, DurationMs: m.Duration}, e
}
func (auditMedia) ExportMediaURL(_ context.Context, _ domain.Actor, a application.Attachment) (string, error) {
	return "https://assets.example.com/vendor/" + a.SHA256, nil
}
func TestCanvasAuditLastHop(t *testing.T) {
	n := 0
	for _, pr := range profiles() {
		pr := pr
		t.Run(pr.ref, func(t *testing.T) {
			e := configured(t, &memoryStore{})
			p := pending(e, pr.ref)
			switch pr.mode {
			case "FIRST_FRAME", "LAST_FRAME":
				p = withMedia(p, []domain.MediaKind{domain.MediaImage}, []string{pr.mode})
			case "FIRST_LAST_FRAME":
				p = withMedia(p, []domain.MediaKind{domain.MediaImage, domain.MediaImage}, []string{"FIRST_FRAME", "LAST_FRAME"})
			case "OMNI_REFERENCE":
				p = withMedia(p, []domain.MediaKind{domain.MediaImage, domain.MediaVideo, domain.MediaAudio}, []string{"REFERENCE_IMAGE", "MOTION_REFERENCE", "REFERENCE_AUDIO"})
			}
			for i := range p.Request.Attachments {
				p.Request.Attachments[i].SHA256 = auditSHA(auditFixtureBytes)
			}
			preset := pr.presets()[len(pr.presets())-1]
			v, _ := json.Marshal(preset.Value)
			p.Request.Parameters["outputPreset"] = v
			if pr.model.provider == "volcengine-official" {
				p.Request.Parameters["returnLastFrame"] = json.RawMessage("true")
				p.Request.Parameters["generateAudio"] = json.RawMessage("false")
			}
			requests := append([]application.InvocationRequest{p.Request}, capturedAudit(t, pr.ref)...)
			for i, r := range requests {
				t.Run(auditCaseName(pr.ref, i), func(t *testing.T) {
					e := configured(t, &memoryStore{})
					e.media = auditMedia{}
					p := pending(e, pr.ref)
					p.Request = r
					p.RequestHash, _ = r.ImmutableHash()
					calls := 0
					e.client.Transport = roundTripper(func(req *http.Request) (*http.Response, error) {
						calls++
						var body struct {
							Model      string
							Ratio      string
							Resolution string
							Duration   int
							Content    []struct {
								Type, Role, Text string
								Image            struct{ URL string } `json:"image_url"`
								Video            struct{ URL string } `json:"video_url"`
								Audio            struct{ URL string } `json:"audio_url"`
							}
							GenerateAudio   bool `json:"generate_audio"`
							ReturnLastFrame bool `json:"return_last_frame"`
						}
						if req.Method != "POST" || json.NewDecoder(req.Body).Decode(&body) != nil || body.Model != pr.model.native || len(body.Content) != len(r.Attachments)+1 || body.Content[0].Type != "text" || body.Content[0].Text == "" {
							t.Fatal("incorrect provider model/content")
						}
						auditUserText(t, r, body.Content[0].Text)
						for j, a := range auditOrdered(r) {
							part := body.Content[j+1]
							kind := strings.ToLower(string(a.Kind))
							if part.Type != kind+"_url" {
								t.Fatal("provider input order/type")
							}
							role := map[string]string{"FIRST_FRAME": "first_frame", "LAST_FRAME": "last_frame", "REFERENCE_IMAGE": "reference_image", "SOURCE_VIDEO": "reference_video", "MOTION_REFERENCE": "reference_video", "REFERENCE_AUDIO": "reference_audio"}[auditRole(r, a.Ref)]
							if role == "" {
								if pr.mode == "FIRST_FRAME" || pr.mode == "LAST_FRAME" {
									role = strings.ToLower(pr.mode)
								} else {
									role = "reference_" + kind
								}
							}
							if part.Role != role {
								t.Fatal("wrong provider role", part.Role, role)
							}
							u := map[string]string{"image": part.Image.URL, "video": part.Video.URL, "audio": part.Audio.URL}[kind]
							if kind == "video" && pr.model.provider == "volcengine-official" {
								if u != "https://assets.example.com/vendor/"+a.SHA256 {
									t.Fatal("wrong exported video")
								}
							} else {
								_, b, ok := strings.Cut(u, ",")
								data, err := base64.StdEncoding.DecodeString(b)
								if !ok || err != nil || auditSHA(data) != a.SHA256 {
									t.Fatal("embedded asset identity mismatch")
								}
							}
						}
						want := pr.presets()[0].Value
						if r.Parameters["outputPreset"] != nil {
							json.Unmarshal(r.Parameters["outputPreset"], &want)
						}
						var found bool
						for _, v := range pr.presets() {
							if v.Value == want {
								found = true
								if body.Resolution != v.Resolution || body.Ratio != v.AspectRatio || body.Duration != v.DurationSeconds {
									t.Fatal("provider preset drift")
								}
							}
						}
						if !found {
							t.Fatal("unknown preset")
						}
						if pr.model.provider == "volcengine-official" {
							for k, val := range map[string]bool{"generateAudio": body.GenerateAudio, "returnLastFrame": body.ReturnLastFrame} {
								w := k == "generateAudio"
								if r.Parameters[k] != nil {
									json.Unmarshal(r.Parameters[k], &w)
								}
								if val != w {
									t.Fatal("wrong boolean", k)
								}
							}
							return response(200, `{"id":"task-1"}`), nil
						}
						return response(200, `{"task_id":"task-1"}`), nil
					})
					obs, _, err := e.Execute(context.Background(), p)
					if err != nil || calls != 1 || obs.State != domain.Running {
						t.Fatalf("no correct provider submission: calls=%d state=%s fault=%v", calls, obs.State, obs.NormalizedError)
					}
				})
			}
		})
		n++
	}
	if n != 36 {
		t.Fatal(n)
	}
}
