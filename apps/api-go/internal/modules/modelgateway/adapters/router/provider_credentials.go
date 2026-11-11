package router

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"unicode"

	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

func (c *Client) ProviderCredentials(ctx context.Context, actor application.Actor) ([]application.ProviderCredential, error) {
	var dto struct {
		Items           []application.ProviderCredential `json:"items"`
		ProtocolVersion string                           `json:"protocolVersion"`
	}
	if err := c.do(ctx, actor, http.MethodGet, "/v1/provider-credentials", nil, &dto); err != nil {
		return nil, err
	}
	if dto.ProtocolVersion != "1" || dto.Items == nil || len(dto.Items) != 2 {
		return nil, &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	seen := map[string]bool{}
	for _, item := range dto.Items {
		if !validCredentialStatus(item) || seen[item.ProviderRef] {
			return nil, &application.Fault{Code: "PROTOCOL_MISMATCH"}
		}
		seen[item.ProviderRef] = true
	}
	return dto.Items, nil
}

func (c *Client) SaveProviderCredential(ctx context.Context, actor application.Actor, provider, rawKey, region string) (application.ProviderCredential, error) {
	key, ok := application.NormalizeProviderAPIKey(rawKey)
	if !application.SupportedCredentialProvider(provider) || !ok || !application.ValidCredentialRegion(provider, region) {
		return application.ProviderCredential{}, &application.Fault{Code: "INVALID_REQUEST"}
	}
	body, _ := json.Marshal(struct {
		APIKey string `json:"apiKey"`
		Region string `json:"region,omitempty"`
	}{key, region})
	return c.mutateProviderCredential(ctx, actor, http.MethodPut, provider, body)
}

func (c *Client) DeleteProviderCredential(ctx context.Context, actor application.Actor, provider string) (application.ProviderCredential, error) {
	if !application.SupportedCredentialProvider(provider) {
		return application.ProviderCredential{}, &application.Fault{Code: "INVALID_REQUEST"}
	}
	return c.mutateProviderCredential(ctx, actor, http.MethodDelete, provider, nil)
}

func (c *Client) mutateProviderCredential(ctx context.Context, actor application.Actor, method, provider string, body []byte) (application.ProviderCredential, error) {
	var dto struct {
		application.ProviderCredential
		ProtocolVersion string `json:"protocolVersion"`
	}
	if err := c.do(ctx, actor, method, "/v1/provider-credentials/"+provider, body, &dto); err != nil {
		return application.ProviderCredential{}, err
	}
	if dto.ProtocolVersion != "1" || dto.ProviderRef != provider || !validCredentialStatus(dto.ProviderCredential) || (method == http.MethodPut) != dto.Configured {
		return application.ProviderCredential{}, &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	return dto.ProviderCredential, nil
}

func validCredentialStatus(item application.ProviderCredential) bool {
	if !application.SupportedCredentialProvider(item.ProviderRef) || item.Title == "" || len(item.Title) > 200 || strings.ContainsAny(item.Title, "\x00\r\n") {
		return false
	}
	if item.Region != nil && (*item.Region == "" || !application.ValidCredentialRegion(item.ProviderRef, *item.Region)) {
		return false
	}
	if item.Reason != nil && (len(*item.Reason) > 500 || strings.ContainsAny(*item.Reason, "\x00\r\n")) {
		return false
	}
	if !item.Configured {
		return item.MaskedKey == ""
	}
	if item.MaskedKey == "" || item.UpdatedAt == nil || item.UpdatedAt.IsZero() {
		return false
	}
	// The vault emits a fixed mask and at most four opaque suffix characters.
	// Never accept a provider-controlled full key as a display label.
	mask := item.MaskedKey
	var suffix string
	if strings.HasPrefix(mask, "********") {
		suffix = strings.TrimPrefix(mask, "********")
	} else if strings.HasPrefix(mask, "••••") {
		suffix = strings.TrimPrefix(mask, "••••")
	} else {
		return false
	}
	if len([]rune(suffix)) > 4 {
		return false
	}
	for _, r := range suffix {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	return true
}

var _ application.ProviderCredentialGateway = (*Client)(nil)
