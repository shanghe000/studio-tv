package router

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

// CapabilityVersion uses the independent exact-version extension, not the
// latest-only v1 catalog. The successful response is a single Capability.
func (c *Client) CapabilityVersion(ctx context.Context, actor application.Actor, ref, version string) (application.Capability, error) {
	if !application.ValidCapabilityVersionQuery(ref, version) {
		return application.Capability{}, &application.Fault{Code: "INVALID_REQUEST"}
	}
	values := url.Values{"ref": {ref}, "version": {version}}
	var item capabilityDTO
	if err := c.doHeaders(ctx, actor, http.MethodGet, "/extensions/capability-versions/v1/capability?"+values.Encode(), nil, &item, http.Header{"Cache-Control": {"no-store"}}, false); err != nil {
		return application.Capability{}, err
	}
	if item.Ref != ref || item.Version != version || !validExactCapability(item) {
		return application.Capability{}, &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	return application.Capability{Title: item.Title, TestMode: item.TestMode, Ref: item.Ref, Version: item.Version, Kind: item.Kind, ExecutionKind: item.ExecutionKind, ParameterSchemaVersion: item.ParameterSchemaVersion, ParameterSchema: item.ParameterSchema, InputKinds: item.InputKinds, OutputKinds: item.OutputKinds, SupportsSession: item.SupportsSession, SessionMode: item.SessionMode, SupportsStream: item.SupportsStream, SupportsCancel: item.SupportsCancel, Available: item.Available, Reason: item.Reason, Model: item.Model}, nil
}

func validExactCapability(item capabilityDTO) bool {
	if item.Model != nil && (!refPattern.MatchString(item.Model.ProviderRef) || !refPattern.MatchString(item.Model.ModelRef) || item.Model.Title == "" || len(item.Model.Title) > 200 || item.Model.Version == "" || len(item.Model.Version) > 100 || strings.ContainsAny(item.Model.Title+item.Model.Version, "\x00\r\n")) {
		return false
	}
	var schema map[string]any
	if !application.ValidCapabilityVersionQuery(item.Ref, item.Version) || item.ParameterSchemaVersion == "" || json.Unmarshal(item.ParameterSchema, &schema) != nil || schema == nil || item.InputKinds == nil || item.OutputKinds == nil {
		return false
	}
	if item.ExecutionKind != "MODEL" && item.ExecutionKind != "AGENT" {
		return false
	}
	if item.SessionMode != nil {
		mode := *item.SessionMode
		if (mode != "NONE" && mode != "OPTIONAL" && mode != "REQUIRED") || (mode != "NONE") != item.SupportsSession {
			return false
		}
	}
	return true
}

var _ application.ExactCapabilityGateway = (*Client)(nil)
