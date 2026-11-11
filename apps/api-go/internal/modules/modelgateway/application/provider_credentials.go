package application

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// ProviderCredential is a write-only personal credential's public status. The
// credential itself is never part of a capability, invocation, or canvas.
type ProviderCredential struct {
	ProviderRef  string     `json:"providerRef"`
	Title        string     `json:"title"`
	Configured   bool       `json:"configured"`
	MaskedKey    string     `json:"maskedKey"`
	Region       *string    `json:"region,omitempty"`
	UpdatedAt    *time.Time `json:"updatedAt"`
	Configurable bool       `json:"configurable"`
	Reason       *string    `json:"reason,omitempty"`
}

// ProviderCredentialGateway is separate from the catalog/session port so an
// unavailable personal credential service cannot manufacture model availability.
type ProviderCredentialGateway interface {
	ProviderCredentials(context.Context, Actor) ([]ProviderCredential, error)
	SaveProviderCredential(context.Context, Actor, string, string, string) (ProviderCredential, error)
	DeleteProviderCredential(context.Context, Actor, string) (ProviderCredential, error)
}

func SupportedCredentialProvider(ref string) bool {
	return ref == "minimax-official" || ref == "volcengine-official"
}

func ValidCredentialRegion(provider, region string) bool {
	if provider == "minimax-official" {
		return region == "" || region == "global" || region == "cn"
	}
	return provider == "volcengine-official" && region == ""
}

// NormalizeProviderAPIKey accepts opaque tokens, while excluding whitespace and
// control characters that can change HTTP authentication semantics.
func NormalizeProviderAPIKey(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	if value == "" || len(value) > 4096 || !utf8.ValidString(value) {
		return "", false
	}
	for _, r := range value {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return "", false
		}
	}
	return value, true
}

// OfficialVideoErrorMessage is an allowlisted product explanation, never the
// upstream provider's diagnostic text (which may contain authentication data).
func OfficialVideoErrorMessage(code string) (string, bool) {
	switch code {
	case "COMFY_GENERATION_INTERRUPTED":
		return "生成任务已被中断，未完成生成。请确认服务状态后重新提交。", true
	case "PROVIDER_CREDENTIAL_REQUIRED":
		return "请先在个人设置中配置该厂商的 API Key。", true
	case "PROVIDER_CREDENTIAL_PARAMETER_FORBIDDEN":
		return "生成参数不能包含 API Key 或认证信息，请在个人设置中配置。", true
	case "PROVIDER_CREDENTIALS_DISABLED":
		return "个人 API Key 服务暂未开放，请稍后重试。", true
	case "PROVIDER_CREDENTIAL_KEY_REMOVED":
		return "本次任务使用的 API Key 已被移除，请在个人设置中重新配置后提交。", true
	case "OFFICIAL_VIDEO_NOT_CONFIGURED":
		return "该厂商视频服务暂未开放，请稍后重试。", true
	case "OFFICIAL_VIDEO_INSUFFICIENT_BALANCE":
		return "该厂商账户余额不足，请充值后重试。", true
	case "OFFICIAL_VIDEO_AUTH_FAILED":
		return "该厂商 API Key 无效或权限不足，请在个人设置中更新。", true
	case "OFFICIAL_VIDEO_RATE_LIMITED":
		return "该厂商调用频率已达上限，请稍后重试。", true
	case "OFFICIAL_VIDEO_USAGE_LIMIT":
		return "该厂商账户的调用额度已达上限，请检查套餐或配额后重试。", true
	case "OFFICIAL_VIDEO_CONTENT_REJECTED":
		return "提示词或参考素材未通过该厂商的内容审核，请调整后重试。", true
	case "OFFICIAL_VIDEO_INPUT_INVALID":
		return "输入参数或参考素材不符合该模型要求，请检查后重试。", true
	case "OFFICIAL_VIDEO_REJECTED":
		return "该厂商拒绝了本次生成请求，请检查提示词和参考素材后重试。", true
	}
	return "", false
}

// CredentialUnavailableCode reads only trusted catalog metadata, never graph
// fields. It keeps an actionable personal-key failure at acceptance/resume.
func CredentialUnavailableCode(cap Capability) string {
	var schema struct {
		Source struct {
			Kind            string `json:"kind"`
			Provider        string `json:"credentialProviderRef"`
			UnavailableCode string `json:"unavailableCode"`
		} `json:"x-model-source"`
	}
	if json.Unmarshal(cap.ParameterSchema, &schema) != nil || schema.Source.Kind != "API" || !SupportedCredentialProvider(schema.Source.Provider) {
		return ""
	}
	switch schema.Source.UnavailableCode {
	case "PROVIDER_CREDENTIAL_REQUIRED", "PROVIDER_CREDENTIALS_DISABLED", "PROVIDER_CREDENTIAL_KEY_REMOVED", "OFFICIAL_VIDEO_NOT_CONFIGURED":
		return schema.Source.UnavailableCode
	}
	return ""
}
