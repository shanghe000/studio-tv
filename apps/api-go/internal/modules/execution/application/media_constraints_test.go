package application

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func mediaConstraintFixture(t *testing.T) (*Service, *promptTestStore, domain.Graph, gateway.Capability) {
	t.Helper()
	s, store, graph, cap := catalogVideoFixture(t, "MOTION_TRANSFER", "VIDEO_TO_VIDEO")
	cap.Ref, cap.Version = "h3-motion-transfer-v1", "2"
	var schema map[string]any
	_ = json.Unmarshal(cap.ParameterSchema, &schema)
	schema["x-input-media-constraints"] = map[string]any{"schemaVersion": "1", "kinds": map[string]any{
		"IMAGE": map[string]any{"maxBytes": 10 << 20, "maxWidth": 8192, "maxHeight": 8192, "maxPixels": 16777216},
		"VIDEO": map[string]any{"maxBytes": 64 << 20, "minDurationMs": 2000, "maxDurationMs": 30000, "maxPixels": 2073600},
	}}
	cap.ParameterSchema, _ = json.Marshal(schema)
	s.gateway.(*promptTestGateway).pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
	w, h, ms := 480, 640, int64(30000)
	for _, id := range []string{"last", "video"} {
		a := store.assets[id]
		a.ByteSize, a.Width, a.Height = 1024, &w, &h
		if a.Kind == "VIDEO" {
			a.DurationMs = &ms
		}
		store.assets[id] = a
	}
	graph.Nodes = append(graph.Nodes, json.RawMessage(`{"id":"V","type":"rh-video","data":{"sourceObjects":["rhtv-asset:video"]}}`))
	graph.Edges = append(graph.Edges, domain.Edge{Source: "V", Target: "C"})
	mutateImageFrontierNode(t, &graph, "C", func(data map[string]any) {
		data["capabilityRef"], data["capabilityVersion"] = cap.Ref, cap.Version
		data["subType"] = "video-motion-transfer"
		data["promptSelection"] = map[string]any{"schemaVersion": "1", "referenceBindings": []any{
			map[string]any{"assetId": "last", "role": "REFERENCE_IMAGE"}, map[string]any{"assetId": "video", "role": "MOTION_REFERENCE"},
		}}
	})
	return s, store, graph, cap
}

func TestCanvasRejectsReportedMediaBeforeTaskPersistenceDespiteClientMetadata(t *testing.T) {
	s, store, graph, _ := mediaConstraintFixture(t)
	a := store.assets["video"]
	ms := int64(55519)
	a.DurationMs = &ms
	store.assets["video"] = a
	a = store.assets["last"]
	a.ByteSize = 12474445
	store.assets["last"] = a
	// These browser values cannot replace the trusted asset facts.
	mutateImageFrontierNode(t, &graph, "C", func(d map[string]any) {
		d["durationMs"], d["byteSize"] = 2000, 1
	})
	_, err := createImageFrontierTask(t, s, graph)
	var invalid *MediaInputError
	if !errors.As(err, &invalid) || store.creates != 0 || store.task.ID != "" {
		t.Fatal("invalid source entered task persistence", err, store.creates)
	}
	for _, text := range []string{"55.519", "2–30", "裁剪", "12474445", "10485760", "压缩"} {
		if !strings.Contains(invalid.Message, text) {
			t.Fatalf("actionable facts missing: %q in %q", text, invalid.Message)
		}
	}
}

func TestCanvasMediaBoundariesAndUnknownCatalogs(t *testing.T) {
	for _, row := range []struct {
		name            string
		bytes, duration int64
		allowed         bool
	}{
		{"minimum", 1, 2000, true}, {"exact maximum", 10 << 20, 30000, true},
		{"one byte over", (10 << 20) + 1, 30000, false}, {"one millisecond over", 1, 30001, false}, {"too short", 1, 1999, false},
	} {
		t.Run(row.name, func(t *testing.T) {
			s, store, graph, _ := mediaConstraintFixture(t)
			a := store.assets["last"]
			a.ByteSize = row.bytes
			store.assets["last"] = a
			a = store.assets["video"]
			a.DurationMs = &row.duration
			store.assets["video"] = a
			_, err := createImageFrontierTask(t, s, graph)
			if (err == nil) != row.allowed || (store.creates == 1) != row.allowed {
				t.Fatal("media boundary changed", err, store.creates)
			}
			if row.name == "one byte over" && !strings.Contains(err.Error(), "10485761") {
				t.Fatal("rounded byte boundary hides the actual excess", err)
			}
		})
	}
	s, store, graph, cap := mediaConstraintFixture(t)
	var schema map[string]any
	_ = json.Unmarshal(cap.ParameterSchema, &schema)
	delete(schema, "x-input-media-constraints")
	cap.ParameterSchema, _ = json.Marshal(schema)
	s.gateway.(*promptTestGateway).pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
	a := store.assets["video"]
	a.DurationMs = nil
	store.assets["video"] = a
	if _, err := createImageFrontierTask(t, s, graph); err != nil || store.creates != 1 {
		t.Fatal("catalog without reviewed limits acquired new restrictions", err)
	}
}

func TestWorkerRechecksLateBoundOwnedMediaBeforeRouterSubmission(t *testing.T) {
	s, store, graph, _ := mediaConstraintFixture(t)
	task, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	g := &receiptModeGateway{promptTestGateway: s.gateway.(*promptTestGateway), submitTestMode: false, readTestMode: false}
	s.gateway = g
	a := store.assets["video"]
	ms := int64(55519)
	a.DurationMs = &ms
	store.assets["video"] = a
	s.execute(context.Background(), task, "lease")
	if g.submits != 0 || store.task.State != "FAILED" || store.task.ErrorCode == nil || *store.task.ErrorCode != "MEDIA_INPUT_INVALID" || store.task.Plans[0].State != "FAILED" || store.task.Plans[0].ErrorMessage == nil || !strings.Contains(*store.task.Plans[0].ErrorMessage, "55.519") {
		t.Fatal("late invalid media reached model router", store.task.State, store.task.ErrorCode, g.submits)
	}
}

type mediaRejectionGateway struct{ *receiptModeGateway }

func (g mediaRejectionGateway) Invocation(context.Context, gateway.Actor, string) (gateway.Invocation, error) {
	return gateway.Invocation{Ref: "private-receipt", State: "FAILED", NormalizedError: &gateway.NormalizedError{Code: "COMFY_MEDIA_DURATION", Message: "参考视频时长为 55.519 秒，当前模型支持 2–30 秒；请裁剪后重试。"}}, nil
}

func TestWorkerPersistsSafeNormalizedMediaMessageForTaskAndPlan(t *testing.T) {
	s, store, graph, _ := mediaConstraintFixture(t)
	task, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	s.gateway = mediaRejectionGateway{&receiptModeGateway{promptTestGateway: s.gateway.(*promptTestGateway)}}
	s.execute(context.Background(), task, "lease")
	if store.task.State != "FAILED" || store.task.ErrorMessage == nil || store.task.Plans[0].ErrorMessage == nil || !strings.Contains(*store.task.Plans[0].ErrorMessage, "55.519") || *store.task.ErrorMessage != *store.task.Plans[0].ErrorMessage {
		t.Fatal("safe late media failure collapsed to code", store.task)
	}
}

func TestModelReaderIntersection(t *testing.T) {
	const imageLimit = 10 << 20
	cases := []struct {
		name, limits, mime string
		size               int64
		invalid            bool
	}{
		{"wide exact", `{"maxBytes":100000000,"mimeTypes":["image/png","image/gif"]}`, "image/png", imageLimit, false},
		{"wide oversize", `{"maxBytes":100000000}`, "image/png", imageLimit + 1, true},
		{"wide format", `{"mimeTypes":["image/png","image/gif"]}`, "image/gif", 1, true},
		{"narrow format", `{"mimeTypes":["image/webp"]}`, "image/png", 1, true},
		{"narrow size", `{"maxBytes":32768}`, "image/webp", 32769, true},
		{"empty intersection", `{"mimeTypes":["image/avif"]}`, "image/avif", 1, true},
		{"undeclared oversize", "", "image/png", imageLimit + 1, true},
		{"undeclared format", "", "image/avif", 1, true},
		{"unknown facts on historical asset", "", "", 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cap := gateway.Capability{Ref: "sample", Version: "7", ExecutionKind: "MODEL", InputKinds: []string{"IMAGE"}, ParameterSchema: json.RawMessage(`{}`)}
			if c.limits != "" {
				cap.ParameterSchema = json.RawMessage(`{"x-input-media-constraints":{"schemaVersion":"1","kinds":{"IMAGE":` + c.limits + `}}}`)
			}
			err := validateMediaAssets(cap, []Asset{{Kind: "IMAGE", ByteSize: c.size, MimeType: c.mime}})
			if (err != nil) != c.invalid {
				t.Fatalf("validation = %v", err)
			}
		})
	}
	for _, cap := range []gateway.Capability{{ExecutionKind: "MODEL", TestMode: true}, {ExecutionKind: "MEDIA_JOB"}} {
		cap.ParameterSchema, cap.InputKinds = json.RawMessage(`{}`), []string{"IMAGE"}
		if err := validateMediaAssets(cap, []Asset{{Kind: "IMAGE", ByteSize: 2 * imageLimit, MimeType: "image/avif"}}); err != nil {
			t.Fatal("applied model-reader policy to unrelated execution", err)
		}
	}
}

func TestCanvasRejectsTransportMismatchBeforePersistingTask(t *testing.T) {
	for _, sample := range []struct {
		name, mime string
		size       int64
	}{{"wide size", "image/png", 10<<20 + 1}, {"unsupported format", "image/gif", 1024}} {
		t.Run(sample.name, func(t *testing.T) {
			s, store, graph, cap := mediaConstraintFixture(t)
			var schema map[string]any
			if err := json.Unmarshal(cap.ParameterSchema, &schema); err != nil {
				t.Fatal(err)
			}
			schema["x-input-media-constraints"] = map[string]any{"schemaVersion": "1", "kinds": map[string]any{"IMAGE": map[string]any{"maxBytes": 100 << 20, "mimeTypes": []string{"image/png", "image/gif"}}}}
			cap.ParameterSchema, _ = json.Marshal(schema)
			s.gateway.(*promptTestGateway).pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
			a := store.assets["last"]
			a.MimeType = sample.mime
			a.ByteSize = sample.size
			store.assets["last"] = a
			_, err := createImageFrontierTask(t, s, graph)
			var invalid *MediaInputError
			if !errors.As(err, &invalid) || store.creates != 0 || store.task.ID != "" {
				t.Fatal("reference incompatible with byte reader entered the queue", err, store.creates)
			}
		})
	}
}
