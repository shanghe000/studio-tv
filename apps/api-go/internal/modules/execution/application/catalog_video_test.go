package application

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

type cancelCatalogVideoStore struct {
	*promptTestStore
	cancels int
}

func (s *cancelCatalogVideoStore) Cancel(context.Context, string, string) (domain.Task, error) {
	s.cancels++
	return s.task, nil
}

func catalogVideoFixture(t *testing.T, mode, kind string) (*Service, *promptTestStore, domain.Graph, gateway.Capability) {
	t.Helper()
	s, store, catalog := promptTestService(t, kind)
	_, graph := h3FrontierFixture(t, "official-video", "1")
	cap := promptCapability("official-video", kind)
	cap.TestMode = false
	s.WithRealExecution(true)
	cap.Model = &gateway.ModelDescriptor{ProviderRef: "video-supplier", ModelRef: "video-model", Version: "1"}
	cap.OutputKinds = []string{"VIDEO"}
	cap.InputKinds = []string{"TEXT", "STRUCTURED", "IMAGE", "VIDEO"}
	body := map[string]any{"type": "object", "properties": map[string]any{"outputPreset": map[string]any{"type": "string", "enum": []string{"wide"}}},
		"x-video-mode": mode, "x-video-parameter-metadata": map[string]any{"schemaVersion": "1", "presets": []any{map[string]any{"value": "wide", "resolution": "720p", "aspectRatio": "16:9", "durationSeconds": 5}}}}
	cap.ParameterSchema, _ = json.Marshal(body)
	catalog.pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
	return s, store, graph, cap
}

func TestCatalogVideoProfilesRequireExplicitModeAndVersionedMetadata(t *testing.T) {
	for mode, kind := range map[string]string{"TEXT_TO_VIDEO": "TEXT_TO_VIDEO", "FIRST_FRAME": "IMAGE_TO_VIDEO", "FIRST_LAST_FRAME": "IMAGE_TO_VIDEO", "LAST_FRAME": "IMAGE_TO_VIDEO", "OMNI_REFERENCE": "OMNI_REFERENCE", "MOTION_TRANSFER": "VIDEO_TO_VIDEO"} {
		_, _, _, cap := catalogVideoFixture(t, mode, kind)
		if !profiledVideoCapability(cap) || !canvasMediaCapability(cap) {
			t.Fatal("explicit video profile not opted in", mode)
		}
		var schema map[string]any
		_ = json.Unmarshal(cap.ParameterSchema, &schema)
		delete(schema, "x-video-parameter-metadata")
		cap.ParameterSchema, _ = json.Marshal(schema)
		if profiledVideoCapability(cap) {
			t.Fatal("unversioned catalog opted into new reference behavior")
		}
	}
}

func TestNewOfficialVideoKeepsOnlyCurrentReferencesAndPreservesHistory(t *testing.T) {
	s, _, graph, _ := catalogVideoFixture(t, "FIRST_FRAME", "IMAGE_TO_VIDEO")
	mutateImageFrontierNode(t, &graph, "C", func(data map[string]any) {
		data["subType"] = "start-video"
		data["videoUrl"] = "rhtv-asset:video"
		data["sourceObjects"] = []string{"rhtv-asset:video"}
	})
	task, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	if !task.Plans[0].CatalogVideoRoles || !task.Plans[0].VideoCancelUnsupported || !task.Plans[0].MediaInputFrontier || !reflect.DeepEqual(requestAssetIDs(frozenRequest(t, task)), []string{"last"}) {
		t.Fatal("new provider inherited an ancestor or old video output")
	}
	if !strings.Contains(string(task.Snapshot), "rhtv-asset:video") {
		t.Fatal("display history was destructively rewritten")
	}
}

func TestCatalogVideoCancellationDoesNotClaimUpstreamWasStopped(t *testing.T) {
	for _, ref := range []string{"seedance-official-profile", "wan-animate2-motion-transfer-v1", "scail2-person-replacement-v1"} {
		s, underlying, _ := promptTestService(t, "VIDEO_TO_VIDEO")
		store := &cancelCatalogVideoStore{promptTestStore: underlying}
		s.store = store
		underlying.task = domain.Task{ID: "task", State: "RUNNING", Plans: []domain.Plan{{CapabilityRef: ref, VideoCancelUnsupported: true}}}
		if _, err := s.Cancel(context.Background(), "owner", "task"); err == nil || store.cancels != 0 || underlying.task.State != "RUNNING" {
			t.Fatal("unsupported video cancellation was reported locally", ref, err)
		}
		underlying.task.State = "SUCCEEDED"
		if _, err := s.Cancel(context.Background(), "owner", "task"); err != nil || store.cancels != 1 || underlying.task.State != "SUCCEEDED" {
			t.Fatal("terminal receipt could not be read truthfully", ref, err)
		}
	}
}

func TestSupportedCatalogVideoCancellationKeepsExistingPath(t *testing.T) {
	for _, testMode := range []bool{false, true} {
		created, _, graph, cap := catalogVideoFixture(t, "FIRST_FRAME", "IMAGE_TO_VIDEO")
		cap.TestMode, cap.SupportsCancel = testMode, !testMode
		created.gateway.(*promptTestGateway).pages[""] = gateway.CapabilityPage{Items: []gateway.Capability{cap}}
		task, err := createImageFrontierTask(t, created, graph)
		if err != nil || task.Plans[0].VideoCancelUnsupported {
			t.Fatal("acceptance changed supported or explicit test cancellation semantics", err)
		}
	}
	s, underlying, _ := promptTestService(t, "VIDEO_TO_VIDEO")
	store := &cancelCatalogVideoStore{promptTestStore: underlying}
	s.store = store
	underlying.task = domain.Task{ID: "task", State: "RUNNING", Plans: []domain.Plan{{CapabilityRef: "future-video-profile"}}}
	if _, err := s.Cancel(context.Background(), "owner", "task"); err != nil || store.cancels != 1 {
		t.Fatal("a supported adapter lost the existing cancel path", err)
	}
}

func TestCatalogMotionHonorsExplicitAssetRolesWithoutOpaqueEdgeGuesses(t *testing.T) {
	s, _, graph, _ := catalogVideoFixture(t, "MOTION_TRANSFER", "VIDEO_TO_VIDEO")
	graph.Nodes = append(graph.Nodes, json.RawMessage(`{"id":"V","type":"rh-video","data":{"sourceObjects":["rhtv-asset:video"]}}`))
	graph.Edges = append(graph.Edges, domain.Edge{Source: "V", Target: "C"})
	mutateImageFrontierNode(t, &graph, "C", func(data map[string]any) {
		data["subType"] = "video-motion-transfer"
		data["promptSelection"] = map[string]any{"schemaVersion": "1", "referenceBindings": []any{
			map[string]any{"assetId": "last", "role": "REFERENCE_IMAGE"}, map[string]any{"assetId": "video", "role": "MOTION_REFERENCE"},
		}}
	})
	task, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	roles := requestRoles(frozenRequest(t, task))
	if roles["last"] != "REFERENCE_IMAGE" || roles["video"] != "MOTION_REFERENCE" || !task.Plans[0].CatalogVideoRoles {
		t.Fatal("motion roles were guessed or discarded", roles)
	}
	if _, err := upstreamConditioning(graph, "V", "C", "VIDEO"); err == nil {
		t.Fatal("old opaque motion edges silently acquired new behavior")
	}
	if role, err := upstreamConditioningForAsset(graph, "V", "C", "VIDEO", "foreign", true); err == nil || role != "" {
		t.Fatal("a binding for another asset authorized an opaque edge")
	}
}

func TestEndFrameNativeModeBindsTheSingleImageToLastFrame(t *testing.T) {
	s, _, graph, _ := catalogVideoFixture(t, "LAST_FRAME", "IMAGE_TO_VIDEO")
	mutateImageFrontierNode(t, &graph, "C", func(data map[string]any) { data["subType"] = "end-video" })
	task, err := createImageFrontierTask(t, s, graph)
	if err != nil {
		t.Fatal(err)
	}
	if requestRoles(frozenRequest(t, task))["last"] != "LAST_FRAME" {
		t.Fatal("tail frame became a first frame")
	}
}
