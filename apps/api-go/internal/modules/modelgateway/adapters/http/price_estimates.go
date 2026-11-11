package http

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

func registerPriceEstimates(router chi.Router, gateway application.Gateway, protect Protect) {
	pricing, configured := gateway.(application.PriceEstimateGateway)
	handler := protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
		identity := httpapi.IdentityFrom(r)
		if identity.UserID == "" {
			return httpapi.Fail(401, "UNAUTHENTICATED", "需要已验证的登录身份。")
		}
		if _, err := query(r); err != nil {
			return err
		}
		if !configured {
			return httpapi.Fail(501, "PRICE_ESTIMATE_UNAVAILABLE", "厂商费用估算暂未开放。")
		}
		var req application.PriceEstimateRequest
		if err := httpapi.DecodeLimit(w, r, &req, 32*1024); err != nil {
			return err
		}
		quote, err := pricing.EstimatePrice(r.Context(), application.Actor{SubjectRef: identity.UserID}, req)
		if err != nil {
			var fault *application.Fault
			if errors.As(err, &fault) {
				switch fault.Code {
				case "INVALID_REQUEST":
					return httpapi.Fail(422, "PRICE_ESTIMATE_INVALID", "所选型号、参数或素材统计不符合该模型要求。")
				case "NOT_FOUND":
					return httpapi.Fail(404, "MODEL_CAPABILITY_NOT_FOUND", "该模型版本不可用，请重新选择。")
				}
			}
			return httpapi.Retry(503, "PRICE_ESTIMATE_UNAVAILABLE", "厂商费用估算暂时不可用；当前费用未知。")
		}
		return httpapi.OK(w, r, 200, quote)
	})
	router.MethodFunc(http.MethodPost, "/api/v2/model-price-estimates", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		handler(w, r)
	})
}
