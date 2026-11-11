package application

import (
	"encoding/json"

	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	"testing"
)

func TestOfficialVideoMediaPreflightMatchesVendorBoundaries(t *testing.T) {
	cap := gateway.Capability{Ref: "seedance-2-5-official-omni-reference-v1", Version: "1", Kind: "OMNI_REFERENCE", ParameterSchemaVersion: "1", ParameterSchema: json.RawMessage(`{"type":"object"}`), OutputKinds: []string{"VIDEO"}, Model: &gateway.ModelDescriptor{ProviderRef: "volcengine-official", ModelRef: "seedance-2-5-official"}}
	intp := func(n int) *int { return &n }
	msp := func(n int64) *int64 { return &n }
	video := Asset{Kind: "VIDEO", MimeType: "video/mp4", ByteSize: 4096, Width: intp(640), Height: intp(360), DurationMs: msp(4000)}
	image := Asset{Kind: "IMAGE", MimeType: "image/jpeg", ByteSize: 10 << 20, Width: intp(300), Height: intp(750)}
	if err := validateMediaAssets(cap, []Asset{video, image}); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*Asset){func(v *Asset) { v.DurationMs = msp(3999) }, func(v *Asset) { v.MimeType = "video/quicktime" }, func(v *Asset) { v.Width = intp(299) }} {
		v := video
		mutate(&v)
		if validateMediaAssets(cap, []Asset{v}) == nil {
			t.Fatal("unsupported reference admitted")
		}
	}
	bad := image
	bad.Height = intp(751)
	if validateMediaAssets(cap, []Asset{bad}) == nil {
		t.Fatal("unsupported aspect admitted")
	}
	if validateMediaAssets(cap, []Asset{image, image, image, image, image}) == nil {
		t.Fatal("oversized inline payload admitted")
	}
}

func TestVideoTransportSwitchesAreNotDuplicatedInVisualPrompt(t *testing.T) {
	// The STUDIO node keeps UI state and schema-validated parameters separately.
	// Router's strict visual projector rejects execution switches in this envelope.
	node := domain.Node{Type: "rh-video", Data: map[string]json.RawMessage{
		"params":           json.RawMessage(`{"prompt":"scene","outputPreset":"720p","generateAudio":false,"returnLastFrame":true}`),
		"routerParameters": json.RawMessage(`{"outputPreset":"720p","generateAudio":false,"returnLastFrame":true}`),
	}}
	selection, err := readPromptSelection(node)
	if err != nil {
		t.Fatal(err)
	}
	var values map[string]json.RawMessage
	if err := json.Unmarshal(selection.Conditions["nativeParameters"], &values); err != nil {
		t.Fatal(err)
	}
	if len(values) != 1 || string(values["outputPreset"]) != "\"720p\"" {
		t.Fatalf("incorrect video prompt conditions: %v", values)
	}
}

func TestCodexInputImageByteBudget(t *testing.T) {
	cap := gateway.Capability{Ref: "codex-image-edit-v1", Version: "3", ParameterSchemaVersion: "3", ParameterSchema: json.RawMessage(`{"type":"object"}`), InputKinds: []string{"IMAGE", "TEXT"}}
	a := Asset{Kind: "IMAGE", ByteSize: 10 << 20, MimeType: "image/png"}
	b := Asset{Kind: "IMAGE", ByteSize: 6 << 20, MimeType: "image/webp"}
	if err := validateMediaAssets(cap, []Asset{a, b}); err != nil {
		t.Fatal(err)
	}
	b.ByteSize++
	if validateMediaAssets(cap, []Asset{a, b}) == nil {
		t.Fatal("over native total image budget")
	}
	a.MimeType = "image/gif"
	if validateMediaAssets(cap, []Asset{a}) == nil {
		t.Fatal("unsupported native image format")
	}
}

func TestCanvasDocumentIsOrdinaryUserTextOnlyForNativeVisualGenerators(t *testing.T) {
	original := json.RawMessage(` { "shots": [{"subject":"风筝","index":2}, false], "subject":"原始字段" } `)
	for _, sample := range []struct {
		provider string
		output   string
		visual   bool
	}{{"comfy", "IMAGE", true}, {"minimax-official", "VIDEO", true}, {"volcengine-official", "VIDEO", true}, {"codex", "IMAGE", false}, {"codex", "TEXT", false}} {
		cap := gateway.Capability{Model: &gateway.ModelDescriptor{ProviderRef: sample.provider}, OutputKinds: []string{sample.output}}
		if got := visualDocumentInput(cap); got != sample.visual {
			t.Fatalf("incorrect document route: %s", sample.provider)
		}
		prior := "first"
		parts := []gateway.InputPart{{Type: "TEXT", Text: &prior}}
		if err := appendHistoryPart(&parts, domain.Output{Type: "STRUCTURED", Data: original, SchemaVersion: "1"}, sample.visual); err != nil {
			t.Fatal(err)
		}
		if len(parts) != 2 || *parts[0].Text != prior {
			t.Fatal("input order changed")
		}
		if sample.visual {
			if parts[1].Text == nil || *parts[1].Text != `{"shots":[{"subject":"风筝","index":2},false],"subject":"原始字段"}` || parts[1].Type != "TEXT" || len(parts[1].Data) != 0 {
				t.Fatal("document content changed")
			}
		} else if string(parts[1].Data) != string(original) || parts[1].Type != "STRUCTURED" {
			t.Fatal("typed content changed for a structured consumer")
		}
	}
}
