package application

import (
	"context"
	"encoding/json"
)

// Price estimates are vendor list-price previews, independent of frozen Billing.
type PriceEstimateRequest struct {
	CapabilityRef     string                     `json:"capabilityRef"`
	CapabilityVersion string                     `json:"capabilityVersion"`
	Parameters        map[string]json.RawMessage `json:"parameters"`
	Media             PriceEstimateMedia         `json:"media"`
}
type PriceEstimateMedia struct {
	ImageCount       *int     `json:"imageCount"`
	VideoDurationsMS []*int64 `json:"videoDurationsMs"`
}
type PriceSource struct {
	Title string `json:"title"`
	URL   string `json:"url"`
}
type PriceEstimate struct {
	SchemaVersion     string        `json:"schemaVersion"`
	CapabilityRef     string        `json:"capabilityRef"`
	CapabilityVersion string        `json:"capabilityVersion"`
	Status            string        `json:"status"`
	Currency          *string       `json:"currency"`
	Amount            *string       `json:"amount"`
	MinimumAmount     *string       `json:"minimumAmount"`
	MaximumAmount     *string       `json:"maximumAmount"`
	ProviderRef       string        `json:"providerRef"`
	Region            string        `json:"region"`
	PricingRevision   string        `json:"pricingRevision"`
	CheckedAt         string        `json:"checkedAt"`
	Basis             []string      `json:"basis"`
	Warnings          []string      `json:"warnings"`
	Sources           []PriceSource `json:"sources"`
}
type PriceEstimateGateway interface {
	EstimatePrice(context.Context, Actor, PriceEstimateRequest) (PriceEstimate, error)
}
