// Package domain describes product canvas context without transport authority.
package domain

import (
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

var ErrInvalid = errors.New("invalid canvas context")
var ErrNotFound = errors.New("canvas not found")

const MaxNodes = 100
const MaxEdges = 200
const MaxTextRunes = 1200
const MaxReferenceBytes = 200

var contextURL = regexp.MustCompile(`(?:(?i:https?://)|/storage/|/api/)[^\s"<>]+`)
var contextReference = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$`)
var credentialQuery = regexp.MustCompile(`(?i)(?:signature|token|credential|x-amz|x-tos|api[_-]?key|access[_-]?key)`)
var contextPercentEscape = regexp.MustCompile(`%[A-Fa-f0-9]{2}`)

type Position struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type Node struct {
	ID                string   `json:"id"`
	Type              string   `json:"type"`
	Position          Position `json:"position"`
	Label             string   `json:"label,omitempty"`
	Prompt            string   `json:"prompt,omitempty"`
	Text              string   `json:"text,omitempty"`
	AssetID           string   `json:"assetId,omitempty"`
	CapabilityRef     string   `json:"capabilityRef,omitempty"`
	CapabilityVersion string   `json:"capabilityVersion,omitempty"`
	TextTruncated     bool     `json:"textTruncated"`
}
type Edge struct {
	ID     string `json:"id"`
	Source string `json:"source"`
	Target string `json:"target"`
}
type Context struct {
	SchemaVersion          string `json:"schemaVersion"`
	ProjectID              string `json:"projectId"`
	GraphRevision          int64  `json:"graphRevision"`
	Nodes                  []Node `json:"nodes"`
	Edges                  []Edge `json:"edges"`
	TotalNodes             int    `json:"totalNodes"`
	TotalEdges             int    `json:"totalEdges"`
	Truncated              bool   `json:"truncated"`
	ToolExecutionAvailable bool   `json:"toolExecutionAvailable"`
}

// Build is a bounded, explicit projection. Native config, reserved sidecars,
// signed URLs, task states and arbitrary object keys never become model input.
func Build(project string, revision int64, raw json.RawMessage) (Context, error) {
	c := Context{SchemaVersion: "STUDIO_CANVAS_CONTEXT_V1", ProjectID: project, GraphRevision: revision, Nodes: []Node{}, Edges: []Edge{}}
	if project == "" || revision < 1 {
		return c, ErrInvalid
	}
	var graph struct {
		Nodes []struct {
			ID       string                     `json:"id"`
			Type     string                     `json:"type"`
			Position Position                   `json:"position"`
			Data     map[string]json.RawMessage `json:"data"`
		} `json:"nodes"`
		Edges []Edge `json:"edges"`
	}
	if json.Unmarshal(raw, &graph) != nil || graph.Nodes == nil || graph.Edges == nil {
		return c, ErrInvalid
	}
	selected := map[string]bool{}
	for _, n := range graph.Nodes {
		if n.ID == "rhtv_meta_v1" || n.Type == "__rhtv_meta" {
			continue
		}
		c.TotalNodes++
		if len(c.Nodes) >= MaxNodes {
			c.Truncated = true
			continue
		}
		if n.ID == "" || n.Type == "" || selected[n.ID] || math.IsNaN(n.Position.X) || math.IsInf(n.Position.X, 0) || math.IsNaN(n.Position.Y) || math.IsInf(n.Position.Y, 0) {
			return c, ErrInvalid
		}
		if len(n.ID) > MaxReferenceBytes || len(n.Type) > MaxReferenceBytes {
			c.Truncated = true
			continue
		}
		v := Node{ID: n.ID, Type: n.Type, Position: n.Position}
		v.Label = stringField(n.Data, "label", "name", "title")
		v.Prompt = stringField(n.Data, "prompt", "description")
		if v.Prompt == "" {
			var params map[string]json.RawMessage
			if json.Unmarshal(n.Data["params"], &params) == nil {
				v.Prompt = stringField(params, "prompt")
			}
		}
		v.Text = stringField(n.Data, "text", "content", "generatedText")
		v.AssetID = primaryAssetID(n.Data)
		v.CapabilityRef = stringField(n.Data, "capabilityRef", "modelCode")
		v.CapabilityVersion = stringField(n.Data, "capabilityVersion")
		for _, target := range []*string{&v.AssetID, &v.CapabilityRef, &v.CapabilityVersion} {
			if *target != "" && (strings.Contains(*target, "://") || !contextReference.MatchString(*target)) {
				*target = ""
				c.Truncated = true
			}
		}
		if len(v.CapabilityVersion) > 100 {
			v.CapabilityVersion = ""
			c.Truncated = true
		}
		for _, target := range []*string{&v.Label, &v.Prompt, &v.Text} {
			var redacted bool
			*target, redacted = safeText(*target)
			if redacted {
				v.TextTruncated = true
				c.Truncated = true
			}
			runes := []rune(*target)
			if len(runes) > MaxTextRunes {
				*target = string(runes[:MaxTextRunes])
				v.TextTruncated = true
				c.Truncated = true
			}
		}
		selected[n.ID] = true
		c.Nodes = append(c.Nodes, v)
	}
	c.TotalEdges = len(graph.Edges)
	for _, e := range graph.Edges {
		if len(e.ID) > MaxReferenceBytes || len(e.Source) > MaxReferenceBytes || len(e.Target) > MaxReferenceBytes {
			c.Truncated = true
			continue
		}
		if !selected[e.Source] || !selected[e.Target] {
			c.Truncated = true
			continue
		}
		if len(c.Edges) >= MaxEdges {
			c.Truncated = true
			continue
		}
		c.Edges = append(c.Edges, e)
	}
	return c, nil
}

func stringField(data map[string]json.RawMessage, keys ...string) string {
	for _, k := range keys {
		var value string
		if json.Unmarshal(data[k], &value) == nil && strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// Creative URLs remain user data, while signed reads and embedded URL credentials
// must not escape the saved-product boundary as reusable model input.
func SafeContextText(value string) (string, bool) { return safeText(value) }

func safeText(value string) (string, bool) {
	changed := false
	// Remove controls first so normalization cannot reconstruct a credential
	// URL after the authorization-link check has already completed.
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' {
			changed = true
			return -1
		}
		return r
	}, value)
	value = contextURL.ReplaceAllStringFunc(value, func(raw string) string {
		// Inspect the original keys before Parse/Query can reject an escaped
		// path or silently drop credential pairs with malformed values.
		base, rawFragment, _ := strings.Cut(raw, "#")
		_, query, _ := strings.Cut(base, "?")
		if containsCredentialQuery(query) || containsCredentialQuery(rawFragment) {
			changed = true
			return "[已省略授权链接]"
		}
		parsed, err := url.Parse(raw)
		if err != nil {
			// Malformed paths must not expose credentials in the authority.
			if _, authority, ok := strings.Cut(base, "://"); ok {
				authority, _, _ = strings.Cut(authority, "/")
				authority, _, _ = strings.Cut(authority, "?")
				if strings.Contains(authority, "@") {
					changed = true
					return "[已省略授权链接]"
				}
			}
			return raw
		}
		if parsed.User != nil {
			changed = true
			return "[已省略授权链接]"
		}
		fragment, _ := url.ParseQuery(parsed.Fragment)
		for key := range fragment {
			if credentialQuery.MatchString(key) {
				changed = true
				return "[已省略授权链接]"
			}
		}
		for key := range parsed.Query() {
			if credentialQuery.MatchString(key) {
				changed = true
				return "[已省略授权链接]"
			}
		}
		return raw
	})
	return value, changed
}

func containsCredentialQuery(query string) bool {
	// A semicolon makes net/url discard an entire query pair. Treat it as a
	// separator here so either side can still identify an authorization key.
	for _, pair := range strings.FieldsFunc(query, func(r rune) bool { return r == '&' || r == ';' }) {
		key, _, _ := strings.Cut(pair, "=")
		if credentialQuery.MatchString(key) {
			return true
		}
		decoded, err := url.QueryUnescape(key)
		if err != nil {
			// Decode valid escapes even when another escape is malformed;
			// an invalid suffix must not hide an otherwise recognizable key.
			decoded = contextPercentEscape.ReplaceAllStringFunc(key, func(escape string) string {
				value, _ := url.QueryUnescape(escape)
				return value
			})
		}
		if credentialQuery.MatchString(decoded) {
			return true
		}
	}
	return false
}

var contextAssetID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

// These are the explicit media fields used by STUDIO native nodes and execution
// inputs. Storage replaces their signed URLs with canonical asset references.
// Inspecting only this allowlist avoids exposing URL values or hidden sidecars.
func primaryAssetID(data map[string]json.RawMessage) string {
	if value := stringField(data, "assetId"); contextAssetID.MatchString(value) {
		return value
	}
	canonical := func(value string) string {
		if !strings.HasPrefix(value, "rhtv-asset:") {
			return ""
		}
		id := strings.TrimPrefix(value, "rhtv-asset:")
		if contextAssetID.MatchString(id) {
			return id
		}
		return ""
	}
	for _, key := range []string{"imageUrl", "videoUrl", "audioUrl", "url", "toolsSourceUrl"} {
		if id := canonical(stringField(data, key)); id != "" {
			return id
		}
	}
	first := func(raw json.RawMessage) string {
		var values []string
		if json.Unmarshal(raw, &values) != nil {
			return ""
		}
		for index, value := range values {
			if index >= 16 {
				break
			}
			if id := canonical(value); id != "" {
				return id
			}
		}
		return ""
	}
	if id := first(data["sourceObjects"]); id != "" {
		return id
	}
	var params map[string]json.RawMessage
	if json.Unmarshal(data["params"], &params) == nil {
		for _, key := range []string{"imageUrl", "videoUrl", "audioUrl"} {
			if id := canonical(stringField(params, key)); id != "" {
				return id
			}
		}
		for _, key := range []string{"imageUrls", "videoUrls", "audioUrls"} {
			if id := first(params[key]); id != "" {
				return id
			}
		}
	}
	return ""
}
