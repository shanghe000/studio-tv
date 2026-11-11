package product

import (
	"context"
	"encoding/json"
	"errors"
	canvas "studiotv.local/service/api/internal/modules/canvasagent/application"
	canvasDomain "studiotv.local/service/api/internal/modules/canvasagent/domain"
	executionDomain "studiotv.local/service/api/internal/modules/execution/domain"
)

// Composition adapter keeps each bounded context's concrete types out of the
// execution application port and never accepts a browser-supplied graph.
type canvasContextInput struct{ service *canvas.Service }

func (r canvasContextInput) ReadCanvasContext(ctx context.Context, owner, project string) (json.RawMessage, error) {
	value, err := r.service.Read(ctx, owner, project)
	if errors.Is(err, canvasDomain.ErrNotFound) {
		return nil, executionDomain.ErrNotFound
	}
	if errors.Is(err, canvasDomain.ErrInvalid) {
		return nil, executionDomain.ErrInvalid
	}
	if err != nil {
		return nil, err
	}
	return json.Marshal(value)
}
