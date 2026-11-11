package application

import (
	"context"
	"encoding/json"
	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

// ResolveCanvasSelection uses the same exact capability and parameter contract
// as generation; selecting a model does not submit a model invocation.
func (s *Service) ResolveCanvasSelection(ctx context.Context, owner, ref, version string, parameters json.RawMessage) (gateway.Capability, error) {
	if owner == "" || ref == "" || version == "" {
		return gateway.Capability{}, domain.ErrInvalid
	}
	catalog, err := s.capabilities(ctx, owner, "")
	if err != nil {
		return gateway.Capability{}, err
	}
	cap, err := s.exactCapability(ctx, owner, ref, version, catalog)
	if err != nil {
		return cap, err
	}
	if !s.CanExecute(cap) {
		return cap, &gateway.Fault{Code: "CAPABILITY_UNAVAILABLE"}
	}
	if err = validateParameters(cap, parameters); err != nil {
		return cap, err
	}
	return cap, nil
}
