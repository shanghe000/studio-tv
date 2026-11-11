package router

import (
	"context"
	"encoding/json"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

var priceDecimal = regexp.MustCompile("^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,6})?$")

func (c *Client) EstimatePrice(ctx context.Context, actor application.Actor, req application.PriceEstimateRequest) (application.PriceEstimate, error) {
	if !refPattern.MatchString(req.CapabilityRef) || !refPattern.MatchString(req.CapabilityVersion) || req.Parameters == nil || req.Media.ImageCount == nil || *req.Media.ImageCount < 0 || *req.Media.ImageCount > 100 || req.Media.VideoDurationsMS == nil || len(req.Media.VideoDurationsMS) > 100 {
		return application.PriceEstimate{}, &application.Fault{Code: "INVALID_REQUEST"}
	}
	for _, ms := range req.Media.VideoDurationsMS {
		if ms != nil && (*ms <= 0 || *ms > 86400000) {
			return application.PriceEstimate{}, &application.Fault{Code: "INVALID_REQUEST"}
		}
	}
	body, err := json.Marshal(req)
	if err != nil {
		return application.PriceEstimate{}, &application.Fault{Code: "INVALID_REQUEST"}
	}
	var quote application.PriceEstimate
	if err = c.do(ctx, actor, http.MethodPost, "/v1/price-estimates", body, &quote); err != nil {
		return application.PriceEstimate{}, err
	}
	if quote.CapabilityRef != req.CapabilityRef || quote.CapabilityVersion != req.CapabilityVersion || !validPriceEstimate(quote) {
		return application.PriceEstimate{}, &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	return quote, nil
}

func validPriceEstimate(q application.PriceEstimate) bool {
	if q.SchemaVersion != "1" || q.Basis == nil || q.Warnings == nil || q.Sources == nil || len(q.Basis) > 20 || len(q.Warnings) > 20 || len(q.Sources) > 10 {
		return false
	}
	for _, list := range [][]string{q.Basis, q.Warnings} {
		for _, text := range list {
			if text == "" || len(text) > 2000 {
				return false
			}
		}
	}
	for _, source := range q.Sources {
		u, err := url.Parse(source.URL)
		if err != nil || u.Scheme != "https" || u.User != nil || u.Host == "" || source.Title == "" || len(source.Title) > 200 || len(source.URL) > 2000 {
			return false
		}
	}
	if q.Status == "UNKNOWN" {
		return q.Currency == nil && q.Amount == nil && q.MinimumAmount == nil && q.MaximumAmount == nil
	}
	if q.Currency == nil || (*q.Currency != "CNY" && *q.Currency != "USD") || !application.SupportedCredentialProvider(q.ProviderRef) || q.PricingRevision == "" || len(q.Sources) == 0 {
		return false
	}
	if _, err := time.Parse("2006-01-02", q.CheckedAt); err != nil {
		return false
	}
	if (q.ProviderRef == "minimax-official" && ((q.Region != "cn" && q.Region != "global") || (q.Region == "cn" && *q.Currency != "CNY") || (q.Region == "global" && *q.Currency != "USD"))) || (q.ProviderRef == "volcengine-official" && (q.Region != "cn" || *q.Currency != "CNY")) {
		return false
	}
	valid := func(value *string) bool { return value != nil && priceDecimal.MatchString(*value) }
	switch q.Status {
	case "ESTIMATE":
		return valid(q.Amount) && q.MinimumAmount == nil && q.MaximumAmount == nil
	case "LOWER_BOUND":
		return q.Amount == nil && valid(q.MinimumAmount) && q.MaximumAmount == nil
	case "RANGE":
		if q.Amount != nil || !valid(q.MinimumAmount) || !valid(q.MaximumAmount) {
			return false
		}
		low, _ := new(big.Rat).SetString(*q.MinimumAmount)
		high, _ := new(big.Rat).SetString(*q.MaximumAmount)
		return low.Cmp(high) <= 0
	}
	return false
}

var _ application.PriceEstimateGateway = (*Client)(nil)
