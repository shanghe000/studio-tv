package http

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

const providerCredentialsPath = "/api/v2/me/model-provider-credentials"

func registerProviderCredentials(router chi.Router, gateway application.Gateway, protect Protect) {
	credentials, configured := gateway.(application.ProviderCredentialGateway)
	register := func(method, path string, next httpapi.Handler) {
		handler := protect("tv.access", func(w http.ResponseWriter, r *http.Request) error {
			if httpapi.IdentityFrom(r).UserID == "" {
				return httpapi.Fail(401, "UNAUTHENTICATED", "需要已验证的登录身份。")
			}
			if _, err := query(r); err != nil {
				return err
			}
			if method == http.MethodGet && (r.ContentLength != 0 || len(r.TransferEncoding) != 0) {
				return httpapi.Fail(400, "MALFORMED_REQUEST", "查询密钥状态请求不接受请求体。")
			}
			if !configured {
				return httpapi.Fail(501, "PROVIDER_CREDENTIALS_DISABLED", "个人 API Key 服务暂未开放。")
			}
			return next(w, r)
		})
		router.MethodFunc(method, path, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			handler(w, r)
		})
	}
	actor := func(r *http.Request) application.Actor {
		return application.Actor{SubjectRef: httpapi.IdentityFrom(r).UserID}
	}
	register(http.MethodGet, providerCredentialsPath, func(w http.ResponseWriter, r *http.Request) error {
		items, err := credentials.ProviderCredentials(r.Context(), actor(r))
		if err != nil {
			return credentialError(err)
		}
		if items == nil {
			items = []application.ProviderCredential{}
		}
		return httpapi.OK(w, r, 200, struct {
			Items         []application.ProviderCredential `json:"items"`
			SchemaVersion string                           `json:"schemaVersion"`
		}{items, "1"})
	})
	path := providerCredentialsPath + "/{providerRef}"
	register(http.MethodPut, path, func(w http.ResponseWriter, r *http.Request) error {
		provider := chi.URLParam(r, "providerRef")
		if !application.SupportedCredentialProvider(provider) {
			return httpapi.Fail(422, "PROVIDER_UNSUPPORTED", "该厂商尚不支持个人 API Key。")
		}
		var body struct {
			APIKey string  `json:"apiKey"`
			Region *string `json:"region,omitempty"`
		}
		if err := httpapi.DecodeLimit(w, r, &body, 16*1024); err != nil {
			return err
		}
		key, valid := application.NormalizeProviderAPIKey(body.APIKey)
		if !valid {
			return httpapi.Fail(422, "PROVIDER_CREDENTIAL_INVALID", "请输入有效 API Key（最多 4096 字节，不含空白或控制字符）。")
		}
		region := ""
		if body.Region != nil {
			region = *body.Region
			if region == "" || !application.ValidCredentialRegion(provider, region) {
				return httpapi.Fail(422, "PROVIDER_CREDENTIAL_INVALID", "MiniMax 地区请选择 global 或 cn；其他厂商无需地区参数。")
			}
		}
		item, err := credentials.SaveProviderCredential(r.Context(), actor(r), provider, key, region)
		if err != nil {
			return credentialError(err)
		}
		return httpapi.OK(w, r, 200, item)
	})
	register(http.MethodDelete, path, func(w http.ResponseWriter, r *http.Request) error {
		provider := chi.URLParam(r, "providerRef")
		if !application.SupportedCredentialProvider(provider) {
			return httpapi.Fail(422, "PROVIDER_UNSUPPORTED", "该厂商尚不支持个人 API Key。")
		}
		if r.ContentLength != 0 || r.Header.Get("Transfer-Encoding") != "" || len(r.TransferEncoding) != 0 {
			return httpapi.Fail(400, "MALFORMED_REQUEST", "删除密钥请求不接受请求体。")
		}
		item, err := credentials.DeleteProviderCredential(r.Context(), actor(r), provider)
		if err != nil {
			return credentialError(err)
		}
		return httpapi.OK(w, r, 200, item)
	})
}

func credentialError(err error) error {
	if errors.Is(err, application.ErrNotConfigured) {
		return httpapi.Fail(501, "PROVIDER_CREDENTIALS_DISABLED", "个人 API Key 服务暂未开放。")
	}
	var fault *application.Fault
	if errors.As(err, &fault) {
		switch fault.Code {
		case "INVALID_REQUEST", "PROVIDER_CREDENTIAL_INVALID":
			return httpapi.Fail(422, "PROVIDER_CREDENTIAL_INVALID", "API Key 格式不正确，请重新填写。")
		case "PROVIDER_UNSUPPORTED":
			return httpapi.Fail(422, fault.Code, "该厂商尚不支持个人 API Key。")
		case "PROVIDER_CREDENTIALS_DISABLED":
			return httpapi.Retry(503, fault.Code, "个人 API Key 服务暂未开放。")
		case "OFFICIAL_VIDEO_AUTH_FAILED":
			message, _ := application.OfficialVideoErrorMessage(fault.Code)
			return httpapi.Fail(422, fault.Code, message)
		}
	}
	return httpapi.Retry(503, "PROVIDER_CREDENTIAL_SERVICE_UNAVAILABLE", "API Key 配置服务暂时不可用，请稍后重试。")
}
