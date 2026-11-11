package domain_test

import (
	"encoding/json"
	"errors"
	"studiotv.local/service/api/internal/modules/resources/domain"
	"strings"
	"testing"
)

func TestTypedPrivateResourcesAndAssetAuthority(t *testing.T) {
	valid := []struct {
		f       domain.Family
		content string
	}{{domain.Prompt, `{"prefixPrompt":"portrait","suffixPrompt":"","promptType":"PROMPT","referenceAssetId":"image"}`}, {domain.Skill, `{"markdown":"# SKILL","files":[{"path":"SKILL.md","content":"# SKILL"}],"category":"CANVAS_AGENT"}`}, {domain.Workflow, `{"workflowContent":{"nodes":[{"id":"a","data":{"url":"rhtv-asset:image"}}],"edges":[]}}`}, {domain.DirectorProject, `{"type":"3D","content":{"modelUrl":"rhtv-asset:model"}}`}, {domain.DirectorModel, `{"modelAssetId":"model","previewAssetId":"image"}`}}
	for _, v := range valid {
		i := domain.Input{Name: "owned", CategoryIDs: []string{}, Content: json.RawMessage(v.content)}
		if e := i.Validate(v.f); e != nil {
			t.Fatalf("%s invalid: %v", v.f, e)
		}
	}
	for _, raw := range []string{`{"nodes":[{"id":"a","data":{"url":"https://evil/image"}}],"edges":[]}`, `{"nodes":[{"id":"a","data":{"imageUrl":"file.png"}}],"edges":[]}`, `{"nodes":[{"id":"a"},{"id":"a"}],"edges":[]}`, `{"nodes":[{"id":"a"}],"edges":[{"source":"a","target":"foreign"}]}`} {
		i := domain.Input{Name: "x", CategoryIDs: []string{}, Content: json.RawMessage(`{"workflowContent":` + raw + `}`)}
		if i.Validate(domain.Workflow) == nil {
			t.Fatalf("untrusted graph accepted: %s", raw)
		}
	}
	i := domain.Input{Name: "x", CategoryIDs: []string{}, Content: json.RawMessage(`{"prefixPrompt":"x","ownerId":"foreign"}`)}
	if i.Validate(domain.Prompt) == nil {
		t.Fatal("untyped owner accepted")
	}
	if i.Validate(domain.App) == nil {
		t.Fatal("public mutable")
	}
}
func TestStudioPathsBinaryAndPreferences(t *testing.T) {
	for _, p := range []string{"../a", "/a", "a/../b", "a//b", "a\\b", "https://host/a", "a\x00b", ".", "a/", "a\nb"} {
		if domain.ValidPath(p) == nil {
			t.Fatalf("unsafe path %q", p)
		}
	}
	for _, p := range []string{"index.html", "fonts/a.woff2", "中文/a.md", ".gitkeep"} {
		if domain.ValidPath(p) != nil {
			t.Fatalf("safe path %q", p)
		}
	}
	if _, e := (domain.FileInput{Content: "AA==", Encoding: "base64", MimeType: "font/woff2"}).Bytes(); e != nil {
		t.Fatal(e)
	}
	if _, e := (domain.FileInput{Content: "not base64", Encoding: "base64", MimeType: "text/plain"}).Bytes(); e == nil {
		t.Fatal("invalid encoding accepted")
	}
	if (domain.PreferenceInput{}).Validate() == nil {
		t.Fatal("empty preference patch")
	}
	if (domain.PreferenceInput{ShortcutKeyConfig: json.RawMessage(`{"owner":"foreign"}`)}).Validate() == nil {
		t.Fatal("unknown preference")
	}
	if (domain.Tag{Name: "x", Color: "javascript:bad"}).Validate() == nil {
		t.Fatal("unsafe color")
	}
}
func TestPaginationBoundsAndTruth(t *testing.T) {
	q := domain.Query{Page: 100, Size: 20}
	p := domain.NewPage(q, nil, 21)
	if p.Total != 21 || p.Pages != 2 || p.HasNext || p.Records == nil {
		t.Fatal("empty distant page lost total")
	}
	q.Size = 101
	if q.Validate() == nil {
		t.Fatal("unbounded size")
	}
}
func TestHTMLMutationEditsActualTargetAndRejectsUnsupported(t *testing.T) {
	source := `<!doctype html><html><body><div class="scene"><p id="keep">one</p><p id="remove">two</p></div></body></html>`
	v, e := domain.RemoveElement(source, domain.ElementTarget{ID: "remove"})
	if e != nil || strings.Contains(v, `id="remove"`) || !strings.Contains(v, `id="keep"`) {
		t.Fatal(v, e)
	}
	v, e = domain.RemoveElement(source, domain.ElementTarget{Selector: "div.scene > p:nth-of-type(2)"})
	if e != nil || strings.Contains(v, `id="remove"`) {
		t.Fatal(v, e)
	}
	if _, e = domain.RemoveElement(source, domain.ElementTarget{Selector: "div:has(p)"}); !errors.Is(e, domain.ErrUnsupported) {
		t.Fatal("unsupported selector", e)
	}
}
func TestActualNativeShortcutEnums(t *testing.T) {
	valid := domain.PreferenceInput{ShortcutKeyConfig: json.RawMessage(`{"newline":"enter","submitTask":"shift-enter","interactionMode":"rhtv","zoomSensitivity":25}`)}
	if e := valid.Validate(); e != nil {
		t.Fatal(e)
	}
	for _, s := range []string{`{"newline":"enter","submitTask":"enter","interactionMode":"mouse","zoomSensitivity":25}`, `{"newline":"enter","submitTask":"enter","interactionMode":"rhtv","zoomSensitivity":1}`} {
		if (domain.PreferenceInput{ShortcutKeyConfig: json.RawMessage(s)}).Validate() == nil {
			t.Fatal("non-native shortcut accepted")
		}
	}
}
