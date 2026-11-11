package http

import (
	"errors"
	"net/http"

	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

const capabilityVersionPath = "/api/v2/model-capability-version"

func registerCapabilityVersion(register func(string, httpapi.Handler), gateway application.Gateway) {
	register(capabilityVersionPath, func(w http.ResponseWriter, r *http.Request) error {
		if r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
			return httpapi.Fail(400, "VALIDATION_FAILED", "模型版本查询只接受查询参数。")
		}
		values, err := query(r, "ref", "version")
		if err != nil {
			return err
		}
		ref, version := values.Get("ref"), values.Get("version")
		if !application.ValidCapabilityVersionQuery(ref, version) {
			return httpapi.Fail(400, "VALIDATION_FAILED", "须提供有效的能力标识与版本。")
		}
		exact, ok := gateway.(application.ExactCapabilityGateway)
		if !ok {
			return httpapi.Fail(501, "MODEL_ROUTER_NOT_CONFIGURED", "模型版本查询尚未配置。")
		}
		item, err := exact.CapabilityVersion(r.Context(), application.Actor{SubjectRef: httpapi.IdentityFrom(r).UserID}, ref, version)
		if err != nil {
			if errors.Is(err, application.ErrNotConfigured) {
				return httpapi.Fail(501, "MODEL_ROUTER_NOT_CONFIGURED", "模型版本查询尚未配置。")
			}
			var fault *application.Fault
			if errors.As(err, &fault) {
				switch fault.Code {
				case "CAPABILITY_NOT_FOUND", "CAPABILITY_VERSION_NOT_FOUND", "NOT_FOUND":
					return httpapi.Fail(404, "MODEL_CAPABILITY_VERSION_NOT_FOUND", "所选模型版本不存在。")
				case "INVALID_QUERY", "INVALID_REQUEST":
					return httpapi.Fail(400, "VALIDATION_FAILED", "模型版本查询参数不支持。")
				}
			}
			return httpapi.Retry(503, "MODEL_CATALOG_UNAVAILABLE", "模型版本目录暂时不可用。")
		}
		if item.Ref != ref || item.Version != version {
			return httpapi.Retry(503, "MODEL_CATALOG_UNAVAILABLE", "模型版本目录暂时不可用。")
		}
		return httpapi.OK(w, r, 200, capabilityDTO{item.Ref, item.Version, item.Kind, item.ExecutionKind, item.ParameterSchemaVersion, item.ParameterSchema, item.InputKinds, item.OutputKinds, item.SupportsSession, item.SessionMode, item.SupportsStream, item.SupportsCancel, item.Available, item.Reason, item.Title, item.TestMode, item.Model})
	})
}
