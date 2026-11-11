package application

import (
	"strings"

	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

// Only the explicit v2/v3 image contracts permits verified images alongside a
// terminal error. Import them normally without promoting the task to success
// or proceeding with dependent plans.
func hasPartialImageBatch(request gateway.InvocationRequest, inv gateway.Invocation) bool {
	if (request.Capability.Version != "2" && request.Capability.Version != "3") || (request.Capability.Ref != "codex-image-generate-v1" && request.Capability.Ref != "codex-image-edit-v1") || (inv.State != "FAILED" && inv.State != "CANCELED") || len(inv.OutputParts) == 0 || len(inv.OutputParts) > 4 || len(inv.Artifacts) != len(inv.OutputParts) {
		return false
	}
	artifacts := map[string]gateway.Artifact{}
	for _, a := range inv.Artifacts {
		if a.Ref == "" || artifacts[a.Ref].Ref != "" || !strings.HasPrefix(a.MediaType, "image/") {
			return false
		}
		artifacts[a.Ref] = a
	}
	outputs := map[string]bool{}
	for _, part := range inv.OutputParts {
		if part.Type != "ARTIFACT" || part.ArtifactRef == nil || part.OutputRef == "" || outputs[part.OutputRef] {
			return false
		}
		a, ok := artifacts[*part.ArtifactRef]
		if !ok || a.OutputRef != part.OutputRef {
			return false
		}
		delete(artifacts, *part.ArtifactRef)
		outputs[part.OutputRef] = true
	}
	return len(artifacts) == 0
}
