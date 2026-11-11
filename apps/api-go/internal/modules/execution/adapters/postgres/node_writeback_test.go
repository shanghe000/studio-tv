package postgres

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"studiotv.local/service/api/internal/modules/execution/domain"
)

func TestNativeCanvasOutputsPreservesBatchAndCanonicalMediaReferences(t *testing.T) {
	text, asset := "Generated text", "asset_a"
	width, height, duration := 720, 1280, int64(2400)
	input := []domain.Output{
		{ID: "text_a", Type: "TEXT", Text: &text},
		{ID: "structured_a", Type: "STRUCTURED", SchemaVersion: "scene/1", Data: json.RawMessage(`{"scene":"fox","seed":9007199254740993}`)},
		{ID: "media_a", Type: "ASSET", AssetID: &asset, MimeType: "video/mp4", Width: &width, Height: &height, DurationMs: &duration},
	}
	outputs, err := nativeCanvasOutputs(input, false)
	if err != nil || len(outputs) != 3 {
		t.Fatal("complete persisted output batch was not preserved", outputs, err)
	}
	if outputs[0]["outputId"] != "text_a" || outputs[0]["text"] != text || outputs[0]["outputType"] != "text" || outputs[0]["testMode"] != false {
		t.Fatal("text output or ordering changed", outputs[0])
	}
	if outputs[1]["outputId"] != "structured_a" || outputs[1]["schemaVersion"] != "scene/1" || outputs[1]["outputType"] != "structured" {
		t.Fatal("structured output identity or schema lost", outputs[1])
	}
	media := outputs[2]
	for _, key := range []string{"url", "originalUrl", "thumbnailUrl"} {
		if media[key] != "rhtv-asset:asset_a" {
			t.Fatal("browser or provider URL entered the persisted graph", key, media)
		}
	}
	if media["assetId"] != asset || media["mediaId"] != asset || media["width"] != width || media["height"] != height || media["durationMs"] != duration || media["mimeType"] != "video/mp4" || media["outputType"] != "video/mp4" {
		t.Fatal("canonical media metadata lost", media)
	}
	raw, err := json.Marshal(outputs)
	if err != nil || !strings.Contains(string(raw), `"seed":9007199254740993`) || !strings.Contains(string(raw), `"scene":"fox"`) {
		t.Fatal("structured JSON was re-encoded as bytes or lost number precision", string(raw), err)
	}
	if input[0].Text == nil || *input[0].Text != "Generated text" || string(input[1].Data) != `{"scene":"fox","seed":9007199254740993}` {
		t.Fatal("native projection mutated durable execution evidence", input)
	}
}

func TestNativeCanvasOutputsMarksExplicitTestModeAndPreservesEmptyText(t *testing.T) {
	empty, normal := "", "ordinary result"
	asset := "audio_a"
	input := []domain.Output{{ID: "empty", Type: "TEXT", Text: &empty}, {ID: "per_output_test", Type: "TEXT", Text: &normal, TestMode: true}, {ID: "audio", Type: "ASSET", AssetID: &asset, MimeType: "audio/wav"}}
	outputs, err := nativeCanvasOutputs(input, false)
	if err != nil || outputs[0]["text"] != "" || outputs[0]["testMode"] != false || outputs[1]["text"] != "[TEST MODE] ordinary result" || outputs[1]["testMode"] != true || outputs[2]["testMode"] != false {
		t.Fatal("explicit per-output test mode or empty result was changed", outputs, err)
	}
	for _, key := range []string{"width", "height", "durationMs"} {
		if _, exists := outputs[2][key]; exists {
			t.Fatal("optional media dimension was invented", outputs[2])
		}
	}
	all, err := nativeCanvasOutputs(input, true)
	if err != nil || all[0]["text"] != "[TEST MODE] " || all[1]["text"] != "[TEST MODE] ordinary result" {
		t.Fatal("task-level TEST MODE was not explicit", all, err)
	}
	for _, output := range all {
		if output["testMode"] != true {
			t.Fatal("task-level test marker missing from one output", all)
		}
	}
	if empty != "" || normal != "ordinary result" {
		t.Fatal("test annotation mutated source text")
	}
	zero, err := nativeCanvasOutputs(nil, false)
	if err != nil || zero == nil || len(zero) != 0 {
		t.Fatal("empty batch was not a real empty JSON array", zero, err)
	}
}

func TestNativeCanvasOutputsRejectsIncompleteOrUnsupportedDurableOutputs(t *testing.T) {
	validText := "valid preceding output"
	for _, output := range []domain.Output{
		{ID: "missing_text", Type: "TEXT"},
		{ID: "missing_asset", Type: "ASSET"},
		{ID: "missing_artifact_asset", Type: "ARTIFACT"},
		{ID: "malformed_structure", Type: "STRUCTURED", Data: json.RawMessage(`{"broken":`)},
		{ID: "unknown", Type: "PROVIDER_URL"},
	} {
		t.Run(output.ID, func(t *testing.T) {
			result, err := nativeCanvasOutputs([]domain.Output{{ID: "valid", Type: "TEXT", Text: &validText}, output}, false)
			if !errors.Is(err, domain.ErrInvalid) || result != nil {
				t.Fatal("invalid batch was partially published as success", result, err)
			}
		})
	}
}

func TestNativeCanvasOutputsAcceptsImportedMediaArtifact(t *testing.T) {
	asset := "owned-audio"
	got, err := nativeCanvasOutputs([]domain.Output{{ID: "audio", Type: "ARTIFACT", AssetID: &asset, MimeType: "audio/wav"}}, false)
	if err != nil || len(got) != 1 || got[0]["url"] != "rhtv-asset:owned-audio" {
		t.Fatal(got, err)
	}
}
