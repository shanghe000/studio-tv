// Package model reserves provider-neutral capability contracts. No provider is connected.
package model

import (
	"context"
	"errors"
)

type Capability string

const (
	LLM           Capability = "LLM"
	TextToImage   Capability = "TEXT_TO_IMAGE"
	ImageToVideo  Capability = "IMAGE_TO_VIDEO"
	OmniReference Capability = "OMNI_REFERENCE"
)

var ErrNotConfigured = errors.New("model provider is not configured")

type Attachment struct {
	AssetID string
	Role    string
}
type Input struct {
	Capability  Capability
	ModelID     string
	Prompt      string
	Attachments []Attachment
	Parameters  map[string]any
}
type Result struct {
	Text           string
	AssetIDs       []string
	ProviderTaskID string
}
type Provider interface {
	Capabilities() []Capability
	Generate(context.Context, Input) (Result, error)
}
type Unconfigured struct{}

func (Unconfigured) Capabilities() []Capability {
	return []Capability{LLM, TextToImage, ImageToVideo, OmniReference}
}
func (Unconfigured) Generate(context.Context, Input) (Result, error) {
	return Result{}, ErrNotConfigured
}
