package application

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func TestCanvasGroupCreatesNoMaterialPlansAndRetainsTheirInputs(t *testing.T) {
	for _, kind := range []string{"GROUP", "CANVAS"} {
		t.Run(kind, func(t *testing.T) {
			s, store, catalog := promptTestService(t, "TEXT_TO_IMAGE")
			edit := promptCapability("edit", "IMAGE_TO_IMAGE")
			edit.Model = &gateway.ModelDescriptor{ProviderRef: "fixture", ModelRef: "fixture", Version: "1"}
			page := catalog.pages[""]
			page.Items = append(page.Items, edit)
			catalog.pages[""] = page
			graph := json.RawMessage(`{"nodes":[{"id":"group","type":"group"},{"id":"upload","parentId":"group","type":"rh-image","data":{"isUpload":true,"modelCode":"mock","sourceObjects":["rhtv-asset:img"]}},{"id":"legacy","parentNode":"group","type":"rh-image","data":{"label":"Image","width":900,"height":1200,"status":"finished","subType":"text-image","aspectRatio":"3:4","sourceObjects":["rhtv-asset:last"]}},{"id":"configured-history","parentId":"group","type":"rh-image","data":{"modelCode":"mock","params":{"prompt":"regenerate the configured result"},"sourceObjects":["rhtv-asset:last"]}},{"id":"target","parentId":"group","type":"rh-image","data":{"modelCode":"edit","params":{"prompt":"combine both supplied references"}}}],"edges":[{"source":"upload","target":"target"},{"source":"legacy","target":"target"}]}`)
			task, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: kind, TargetID: "group", Graph: graph})
			if err != nil {
				t.Fatal(err)
			}
			if store.creates != 1 || len(task.Plans) != 2 || task.Plans[0].NodeID != "configured-history" || task.Plans[1].NodeID != "target" {
				t.Fatalf("materials created unnecessary generation plans: %+v", task.Plans)
			}
			var request gateway.InvocationRequest
			if err = json.Unmarshal(task.Plans[1].Request, &request); err != nil {
				t.Fatal(err)
			}
			if len(request.Attachments) != 2 {
				t.Fatalf("material references did not reach downstream generation: %+v", request.Attachments)
			}
			seen := map[string]bool{}
			for _, attachment := range request.Attachments {
				seen[attachment.SourceRef] = true
			}
			if !seen["img"] || !seen["last"] || string(task.Snapshot) != string(graph) {
				t.Fatal("material graph or authoritative reference provenance was altered")
			}
		})
	}
}

func TestCanvasMaterialOnlySelectionNeverCreatesATask(t *testing.T) {
	for _, kind := range []string{"NODE", "GROUP", "CANVAS"} {
		s, store, _ := promptTestService(t, "TEXT_TO_IMAGE")
		graph := json.RawMessage(`{"nodes":[{"id":"upload","type":"rh-image","data":{"isUpload":true,"sourceObjects":["rhtv-asset:img"]}}],"edges":[]}`)
		_, err := s.Canvas(context.Background(), "owner", uuid.NewString(), domain.CanvasCommand{ProjectID: "project", TargetType: kind, TargetID: "upload", Graph: graph})
		if err == nil || store.creates != 0 {
			t.Fatal("material-only command accepted a queued model task", kind, err)
		}
		if kind == "NODE" && !errors.Is(err, domain.ErrMaterialOnly) {
			t.Fatal("standalone material error lost its specific meaning", err)
		}
	}
}
