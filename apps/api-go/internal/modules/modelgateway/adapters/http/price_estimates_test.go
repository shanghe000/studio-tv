package http

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

type pricingGateway struct {
	catalogGateway
	pricingErr error
	req        application.PriceEstimateRequest
}

func (g *pricingGateway) EstimatePrice(_ context.Context, actor application.Actor, req application.PriceEstimateRequest) (application.PriceEstimate, error) {
	g.calls++
	g.seen = actor
	g.req = req
	return application.PriceEstimate{SchemaVersion: "1", CapabilityRef: req.CapabilityRef, CapabilityVersion: req.CapabilityVersion, Status: "UNKNOWN", Basis: []string{}, Warnings: []string{"未知费用不等于免费"}, Sources: []application.PriceSource{}}, g.pricingErr
}
func TestPriceEstimatesUseVerifiedUserAndPrivateResponses(t *testing.T) {
	g := &pricingGateway{}
	body := "{\"capabilityRef\":\"model-a\",\"capabilityVersion\":\"1\",\"parameters\":{},\"media\":{\"imageCount\":0,\"videoDurationsMs\":[]}}"
	req := httptest.NewRequest(http.MethodPost, "/api/v2/model-price-estimates", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Router-Subject-Ref", "forged")
	w := httptest.NewRecorder()
	catalogHandler(t, g, "usr_verified").ServeHTTP(w, req)
	if w.Code != 200 || g.seen.SubjectRef != "usr_verified" || g.req.Media.ImageCount == nil || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), "UNKNOWN") {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestPriceEstimateRejectsAnonymousAndNeverLeaksUpstreamDiagnostic(t *testing.T) {
	g := &pricingGateway{}
	w := httptest.NewRecorder()
	catalogHandler(t, g, "").ServeHTTP(w, httptest.NewRequest("POST", "/api/v2/model-price-estimates", nil))
	if w.Code != 401 || g.calls != 0 {
		t.Fatal("anonymous quote accepted")
	}
	g.pricingErr = errors.New("private provider key diagnostic")
	req := httptest.NewRequest("POST", "/api/v2/model-price-estimates", strings.NewReader("{}"))
	req.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	catalogHandler(t, g, "usr_verified").ServeHTTP(w, req)
	if w.Code != 503 || strings.Contains(w.Body.String(), "private provider key") {
		t.Fatal("upstream failure exposed", w.Body.String())
	}
}
