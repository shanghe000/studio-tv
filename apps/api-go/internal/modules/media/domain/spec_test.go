package domain

import (
	"encoding/json"
	"testing"
)

func TestMediaSpecRejectsURLAndInvalidBounds(t *testing.T) {
	valid := `{"inputs":[{"id":"a","assetId":"ast_own"}],"tracks":[{"type":"split","clips":[{"input":"a","trim":{"startMs":0,"endMs":1000}}]}]}`
	s, e := Parse(json.RawMessage(valid))
	if e != nil || s.Version != 1 || s.Tracks[0].Type != "video" || s.Output.Container != "mp4" {
		t.Fatal("native split normalization failed", e)
	}
	for _, bad := range []string{valid + ` {}`, `{"inputs":[{"id":"a","url":"http://127.0.0.1/secret"}],"tracks":[]}`, `{"version":2,"inputs":[{"id":"a","assetId":"ast_own"}],"tracks":[{"type":"video","clips":[{"input":"a"}]}]}`, `{"inputs":[{"id":"a","assetId":"ast_own"}],"tracks":[{"type":"video","clips":[{"input":"a","speed":0}]}]}`, `{"inputs":[{"id":"a","assetId":"ast_own"}],"tracks":[{"type":"video","clips":[{"input":"a","rotate":"90;rm"}]}]}`} {
		if _, e := Parse([]byte(bad)); e == nil {
			t.Fatal("invalid media accepted")
		}
	}
}
func TestStudioBundlePathDurationAndSizeBoundaries(t *testing.T) {
	for _, name := range []string{"../x", "/x", "x//y", "x/../y", "x\\y", "http://host", "x\n"} {
		if ValidPath(name) {
			t.Fatal("invalid path accepted", name)
		}
	}
	if !ValidPath("compositions/intro.html") {
		t.Fatal("clean path rejected")
	}
	for _, duration := range []float64{0, -1, 121} {
		if RenderMetadata(duration, 320, 180) == nil {
			t.Fatal("bad duration accepted")
		}
	}
	b := StudioBundle{ID: "hf_a", Revision: 1, Command: RenderCommand{FPS: 30, Quality: "draft", Format: "mp4"}, Files: []StudioFile{{Path: "index.html", MimeType: "text/html", Content: []byte("real author HTML")}}}
	if b.Validate() != nil {
		t.Fatal("valid bundle rejected")
	}
	b.Files = append(b.Files, b.Files[0])
	if b.Validate() == nil {
		t.Fatal("duplicate file accepted")
	}
}
