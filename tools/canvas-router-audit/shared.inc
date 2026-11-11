import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"studio.example.invalid/models-router/internal/application"
	"strings"
	"sync"
	"testing"
)

var loadAudit sync.Once
var captureErr error
var auditByRef = map[string][]application.InvocationRequest{}
var auditNames = map[string][]string{}

func capturedAudit(t *testing.T, ref string) []application.InvocationRequest {
	t.Helper()
	loadAudit.Do(func() {
		path := os.Getenv("STUDIO_CANVAS_ROUTER_REQUESTS")
		if path == "" {
			return
		}
		data, err := os.ReadFile(path)
		if err != nil {
			captureErr = err
			return
		}
		var rows []json.RawMessage
		if err = json.Unmarshal(data, &rows); err != nil {
			captureErr = err
			return
		}
		for i, raw := range rows {
			var r application.InvocationRequest
			if err = json.Unmarshal(raw, &r); err != nil {
				captureErr = err
				return
			}
			ref := r.Capability.Ref
			if ref == "" {
				captureErr = os.ErrInvalid
				return
			}
			auditByRef[ref] = append(auditByRef[ref], r)
			auditNames[ref] = append(auditNames[ref], fmt.Sprintf("row-%d-%s", i, auditSHA(raw)))
		}
	})
	if captureErr != nil {
		t.Fatal(captureErr)
	}
	return auditByRef[ref]
}
func auditCaseName(ref string, i int) string {
	if i == 0 {
		return "fixture"
	}
	return auditNames[ref][i-1]
}

var auditFixtureBytes = []byte("STUDIO canvas isolated media")

func auditSHA(raw []byte) string { s := sha256.Sum256(raw); return hex.EncodeToString(s[:]) }
func auditBytes(att application.Attachment) ([]byte, error) {
	if att.SHA256 == auditSHA(auditFixtureBytes) {
		return auditFixtureBytes, nil
	}
	if len(att.SHA256) != 64 {
		return nil, os.ErrInvalid
	}
	if _, err := hex.DecodeString(att.SHA256); err != nil {
		return nil, os.ErrInvalid
	}
	dir := os.Getenv("STUDIO_CANVAS_MEDIA_DIR")
	if dir == "" {
		return nil, os.ErrNotExist
	}
	raw, err := os.ReadFile(filepath.Join(dir, att.SHA256))
	if err != nil {
		return nil, err
	}
	if auditSHA(raw) != att.SHA256 {
		return nil, os.ErrInvalid
	}
	return raw, nil
}

type auditMeta struct {
	Kind, Mime, Sha string
	Size, Duration  int64
	Width, Height   int
}

var loadMediaFacts sync.Once
var mediaFactErr error
var metaBySHA = map[string]auditMeta{}

func auditFacts(a application.Attachment) (auditMeta, error) {
	if a.SHA256 == auditSHA(auditFixtureBytes) {
		return auditMeta{Kind: string(a.Kind), Mime: map[string]string{"IMAGE": "image/png", "AUDIO": "audio/wav", "VIDEO": "video/mp4"}[string(a.Kind)], Sha: a.SHA256, Size: int64(len(auditFixtureBytes)), Width: 640, Height: 360, Duration: 6000}, nil
	}
	loadMediaFacts.Do(func() {
		dir := os.Getenv("STUDIO_CANVAS_MEDIA_DIR")
		data, err := os.ReadFile(filepath.Join(dir, "..", "assets.json"))
		if err != nil {
			mediaFactErr = err
			return
		}
		var m map[string]auditMeta
		if err = json.Unmarshal(data, &m); err != nil {
			mediaFactErr = err
			return
		}
		for _, row := range m {
			row.Duration *= 1000
			metaBySHA[row.Sha] = row
		}
	})
	if mediaFactErr != nil {
		return auditMeta{}, mediaFactErr
	}
	if row, ok := metaBySHA[a.SHA256]; ok && row.Kind == string(a.Kind) {
		return row, nil
	}
	return auditMeta{}, os.ErrInvalid
}
func auditOrdered(r application.InvocationRequest) []application.Attachment {
	var parts []application.Attachment
	seen := map[string]bool{}
	for _, part := range r.Input {
		if part.Type == "MEDIA" && part.AttachmentRef != nil && !seen[*part.AttachmentRef] {
			for _, a := range r.Attachments {
				if a.Ref == *part.AttachmentRef {
					parts = append(parts, a)
					seen[a.Ref] = true
					break
				}
			}
		}
	}
	return parts
}
func auditRole(r application.InvocationRequest, ref string) string {
	if r.PromptSpec != nil {
		for _, c := range r.PromptSpec.Conditioning {
			if c.AttachmentRef == ref {
				return c.Role
			}
		}
	}
	return ""
}

// Verify that arbitrary upstream document text and user prose survived the last
// projection in order. Motion/scale profiles explicitly ignoring prompts skip it.
func auditUserText(t *testing.T, request application.InvocationRequest, actual string) {
	t.Helper()
	rest := actual
	for _, part := range request.Input {
		if part.Type != "TEXT" || part.Text == nil {
			continue
		}
		text := strings.TrimSpace(*part.Text)
		if text == "" {
			continue
		}
		// SGUN inserts common visual directions between authored shot segments.
		// Check the text on either side individually; the separator itself is preserved.
		for _, fragment := range strings.Split(text, "\n---\n") {
			if fragment == "" {
				continue
			}
			i := strings.Index(rest, fragment)
			if i < 0 {
				t.Error("ordered user text missing at native boundary")
				return
			}
			rest = rest[i+len(fragment):]
		}
	}
}
