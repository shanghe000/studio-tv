package router

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

func priceRequest() application.PriceEstimateRequest {
	zero := 0
	return application.PriceEstimateRequest{CapabilityRef: "h3-official-text-to-video-v1", CapabilityVersion: "1", Parameters: map[string]json.RawMessage{"outputPreset": json.RawMessage("\"768p-16x9-5s\"")}, Media: application.PriceEstimateMedia{ImageCount: &zero, VideoDurationsMS: []*int64{}}}
}
func quoteFixture() application.PriceEstimate {
	amount, currency := "0.4", "USD"
	return application.PriceEstimate{SchemaVersion: "1", CapabilityRef: "h3-official-text-to-video-v1", CapabilityVersion: "1", Status: "ESTIMATE", Currency: &currency, Amount: &amount, ProviderRef: "minimax-official", Region: "global", PricingRevision: "official-video-list-2026-11-02", CheckedAt: "2026-11-02", Basis: []string{"输出计价"}, Warnings: []string{"以厂商账单为准"}, Sources: []application.PriceSource{{Title: "MiniMax 公开价", URL: "https://platform.minimax.io/docs/pricing/overview"}}}
}
func TestPriceEstimateSignsExactBodyAndVerifiedActor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Method != "POST" || r.URL.Path != "/v1/price-estimates" || r.Header.Get("X-Router-Subject-Ref") != "usr_pricing" {
			t.Error("untrusted estimate route")
		}
		want := proofSignature(bytes.Repeat([]byte("k"), 32), r.Method, r.URL.RequestURI(), "studio-tv", "usr_pricing", r.Header.Get("X-Router-Actor-Timestamp"), r.Header.Get("X-Router-Actor-Nonce"), body)
		if r.Header.Get("X-Router-Actor-Signature") != want {
			t.Error("estimate not signed")
		}
		var req application.PriceEstimateRequest
		if json.Unmarshal(body, &req) != nil || req.Media.ImageCount == nil || req.Media.VideoDurationsMS == nil {
			t.Error("material summary missing")
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Models-Router-Version", "1")
		_ = json.NewEncoder(w).Encode(quoteFixture())
	}))
	defer server.Close()
	c, _ := New(configFor(server.URL))
	q, err := c.EstimatePrice(context.Background(), application.Actor{SubjectRef: "usr_pricing"}, priceRequest())
	if err != nil || q.Amount == nil || *q.Amount != "0.4" {
		t.Fatal(q, err)
	}
}
func TestPriceEstimateCannotTurnUnknownIntoFreeOrAcceptMalformedMoney(t *testing.T) {
	for _, change := range []func(*application.PriceEstimate){
		func(q *application.PriceEstimate) { q.Status = "UNKNOWN" },
		func(q *application.PriceEstimate) { q.Status = "RANGE"; q.MinimumAmount = q.Amount; q.Amount = nil },
		func(q *application.PriceEstimate) { bad := "-1"; q.Amount = &bad },
		func(q *application.PriceEstimate) { q.CapabilityVersion = "2" },
		func(q *application.PriceEstimate) { q.Region = "cn" },
		func(q *application.PriceEstimate) { q.Sources[0].URL = "javascript:alert(1)" },
	} {
		q := quoteFixture()
		change(&q)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("X-Models-Router-Version", "1")
			_ = json.NewEncoder(w).Encode(q)
		}))
		c, _ := New(configFor(server.URL))
		_, err := c.EstimatePrice(context.Background(), application.Actor{SubjectRef: "usr_pricing"}, priceRequest())
		server.Close()
		var fault *application.Fault
		if !errors.As(err, &fault) || fault.Code != "PROTOCOL_MISMATCH" {
			t.Fatal("untrusted money accepted", err)
		}
	}
	q := quoteFixture()
	q.Status = "LOWER_BOUND"
	q.MinimumAmount = q.Amount
	q.Amount = nil
	if !validPriceEstimate(q) {
		t.Fatal("honest lower bound rejected")
	}
	q.Status = "UNKNOWN"
	q.MinimumAmount = nil
	q.Currency = nil
	if !validPriceEstimate(q) {
		t.Fatal("unknown must stay unknown")
	}
}
