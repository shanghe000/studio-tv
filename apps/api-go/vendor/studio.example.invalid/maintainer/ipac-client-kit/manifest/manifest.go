// Package manifest previews and submits application capability manifests.
package manifest

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"studio.example.invalid/maintainer/ipac-client-kit/internal/httpclient"
)

const SchemaVersion = 1

var capabilityCodePattern = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`)

type Capability struct {
	Code        string `json:"code"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

type Document struct {
	SchemaVersion   int          `json:"schema_version"`
	ApplicationCode string       `json:"application_code"`
	ManifestVersion string       `json:"manifest_version"`
	Capabilities    []Capability `json:"capabilities"`
}

type RegisteredCapability struct {
	Capability
	ID     string `json:"id"`
	Status string `json:"status"`
}

type Change struct {
	Type   string                `json:"type"`
	Code   string                `json:"code"`
	Before *RegisteredCapability `json:"before,omitempty"`
	After  *Capability           `json:"after,omitempty"`
}

type Result struct {
	ManifestID      string    `json:"manifest_id"`
	ApplicationID   string    `json:"application_id"`
	ApplicationCode string    `json:"application_code"`
	ManifestVersion string    `json:"manifest_version"`
	ManifestHash    string    `json:"manifest_hash"`
	Status          string    `json:"status"`
	Persisted       bool      `json:"persisted"`
	Changes         []Change  `json:"changes"`
	SubmittedAt     time.Time `json:"submitted_at"`
}

type Config struct {
	BaseURL           string
	ApplicationID     string
	ApplicationSecret string
	ApplicationCode   string
	HTTPClient        *http.Client
	RequestTimeout    time.Duration
	AllowInsecureHTTP bool
}

type Client struct {
	applicationCode string
	client          *httpclient.Client
}

func NewClient(config Config) (*Client, error) {
	if strings.TrimSpace(config.ApplicationCode) == "" {
		return nil, errors.New("application code is required")
	}
	client, err := httpclient.New(httpclient.Config{
		BaseURL: config.BaseURL, ClientID: config.ApplicationID,
		ClientSecret: config.ApplicationSecret, HTTPClient: config.HTTPClient,
		RequestTimeout: config.RequestTimeout, AllowInsecureHTTP: config.AllowInsecureHTTP,
	})
	if err != nil {
		return nil, err
	}
	return &Client{applicationCode: strings.TrimSpace(config.ApplicationCode), client: client}, nil
}

// Preview computes a diff without persisting the manifest or modifying IPAC.
func (c *Client) Preview(ctx context.Context, document Document) (Result, error) {
	if err := c.validate(document); err != nil {
		return Result{}, err
	}
	var result Result
	if err := c.client.DoJSON(ctx, "preview capability manifest", http.MethodPost,
		"/api/v1/applications/capability-manifests/preview", document, &result); err != nil {
		return Result{}, err
	}
	return result, nil
}

// Submit saves a complete capability snapshot as PENDING. An IPAC
// administrator still needs to review and apply it.
func (c *Client) Submit(ctx context.Context, document Document) (Result, error) {
	if err := c.validate(document); err != nil {
		return Result{}, err
	}
	var result Result
	if err := c.client.DoJSON(ctx, "submit capability manifest", http.MethodPost,
		"/api/v1/applications/capability-manifests", document, &result); err != nil {
		return Result{}, err
	}
	return result, nil
}

func (c *Client) validate(document Document) error {
	if document.SchemaVersion != SchemaVersion {
		return fmt.Errorf("schema version must be %d", SchemaVersion)
	}
	if document.ApplicationCode != c.applicationCode {
		return errors.New("manifest application code does not match the client configuration")
	}
	if strings.TrimSpace(document.ManifestVersion) == "" || utf8.RuneCountInString(document.ManifestVersion) > 64 {
		return errors.New("manifest version must contain between 1 and 64 characters")
	}
	seen := make(map[string]struct{}, len(document.Capabilities))
	for index, capability := range document.Capabilities {
		if !capabilityCodePattern.MatchString(capability.Code) || len(capability.Code) > 128 {
			return fmt.Errorf("capability %d has an invalid code", index)
		}
		if strings.TrimSpace(capability.Name) == "" || utf8.RuneCountInString(capability.Name) > 128 {
			return fmt.Errorf("capability %q name must contain between 1 and 128 characters", capability.Code)
		}
		if strings.TrimSpace(capability.Description) == "" || utf8.RuneCountInString(capability.Description) > 1024 {
			return fmt.Errorf("capability %q description must contain between 1 and 1024 characters", capability.Code)
		}
		if _, exists := seen[capability.Code]; exists {
			return fmt.Errorf("capability code %q is duplicated", capability.Code)
		}
		seen[capability.Code] = struct{}{}
	}
	return nil
}
