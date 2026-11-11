package postgres_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

type mediaPreflightCatalog struct{ gateway.Unconfigured }

func (mediaPreflightCatalog) Capabilities(context.Context, gateway.Actor, gateway.CapabilityQuery) (gateway.CapabilityPage, error) {
	return gateway.CapabilityPage{Items: []gateway.Capability{{Ref: "h3-motion-transfer-v1", Version: "2", Kind: "VIDEO_TO_VIDEO", ExecutionKind: "MODEL", Available: true, TestMode: true, ParameterSchemaVersion: "2", Model: &gateway.ModelDescriptor{ProviderRef: "fixture", ModelRef: "motion-fixture", Version: "1"}, InputKinds: []string{"TEXT", "STRUCTURED", "IMAGE", "VIDEO"}, OutputKinds: []string{"VIDEO"}, ParameterSchema: json.RawMessage(`{"type":"object","properties":{"outputPreset":{"type":"string","enum":["wide"]}},"x-video-mode":"MOTION_TRANSFER","x-video-parameter-metadata":{"schemaVersion":"1","presets":[{"value":"wide","resolution":"480p","aspectRatio":"16:9","durationSeconds":0}]},"x-input-media-constraints":{"schemaVersion":"1","kinds":{"IMAGE":{"maxBytes":10485760,"maxWidth":8192,"maxHeight":8192,"maxPixels":16777216},"VIDEO":{"maxBytes":67108864,"minDurationMs":2000,"maxDurationMs":30000,"maxPixels":2073600}}}}`)}}}, nil
}

func TestPostgresServerCanvasRejectsMediaBeforeTasksGrantsEventsOrGraphLease(t *testing.T) {
	f := newHistoryInputFixture(t) // testdb requires explicit isolated TEST_DATABASE_URL.
	if _, err := f.pool.Exec(f.ctx, `UPDATE public.assets SET byte_size=12474445,width=4800,height=2848 WHERE id='input-new-image';
INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,width,height,duration_seconds) VALUES('input-video','input-owner','input-project','motion.mp4','VIDEO','video/mp4',2924634,repeat('c',64),'READY',360,640,55.519)`); err != nil {
		t.Fatal(err)
	}
	graph := `{"nodes":[{"id":"target","type":"rh-video","data":{"capabilityRef":"h3-motion-transfer-v1","capabilityVersion":"2","subType":"video-motion-transfer","params":{"imageUrls":["rhtv-asset:input-new-image"],"videoUrls":["rhtv-asset:input-video"]},"routerParameters":{"outputPreset":"wide"},"promptSelection":{"schemaVersion":"1","referenceBindings":[{"assetId":"input-new-image","role":"REFERENCE_IMAGE"},{"assetId":"input-video","role":"SOURCE_VIDEO"}]}}}],"edges":[]}`
	revision := setManagedGraph(t, f, graph)
	before, _ := currentManagedGraph(t, f)
	counts := func() [5]int {
		t.Helper()
		var values [5]int
		if err := f.pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM execution.tasks),(SELECT count(*) FROM execution.read_grants),(SELECT count(*) FROM execution.events),(SELECT count(*) FROM canvas.project_events),(SELECT count(*) FROM canvas.command_receipts)`).Scan(&values[0], &values[1], &values[2], &values[3], &values[4]); err != nil {
			t.Fatal(err)
		}
		return values
	}
	// Saving the fixture graph already creates a canvas event. Rejection must
	// leave that existing history intact and create no additional records.
	beforeCounts := counts()
	s, err := execution.New(f.store, mediaPreflightCatalog{}, selectionImporter{})
	if err != nil {
		t.Fatal(err)
	}
	var cmd execution.ServerCanvasCommand
	cmd.Target.Type, cmd.Target.ID = "NODE", "target"
	key := uuid.NewString()
	_, err = s.ServerCanvas(f.ctx, "input-owner", "input-project", key, revision, cmd)
	var invalid *execution.MediaInputError
	if !errors.As(err, &invalid) || !strings.Contains(invalid.Message, "55.519") || !strings.Contains(invalid.Message, "12474445") {
		t.Fatal("trusted asset limits did not reject before acceptance", err)
	}
	afterCounts := counts()
	after, afterRevision := currentManagedGraph(t, f)
	if beforeCounts != afterCounts || before != after || afterRevision != revision {
		t.Fatalf("rejection mutated persistence: counts before=%v after=%v revision=%d", beforeCounts, afterCounts, afterRevision)
	}
	// A supported input is a positive acceptance control. It queues an explicit
	// TEST MODE receipt only; this test never starts a worker or calls a model.
	if _, err := f.pool.Exec(f.ctx, `UPDATE public.assets SET byte_size=1024 WHERE id='input-new-image'; UPDATE public.assets SET duration_seconds=30 WHERE id='input-video'`); err != nil {
		t.Fatal(err)
	}
	accepted, err := s.ServerCanvas(f.ctx, "input-owner", "input-project", key, revision, cmd)
	if err != nil || accepted.ID == "" || !accepted.TestMode {
		t.Fatal("valid boundary did not reach normal acceptance", err)
	}
}
