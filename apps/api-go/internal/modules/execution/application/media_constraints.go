package application

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	modelmedia "studiotv.local/service/api/internal/modules/modelmedia/application"
)

// MediaInputError contains only messages generated from trusted asset facts and
// the authenticated capability catalog. It never includes caller text or URLs.
type MediaInputError struct{ Message string }

func (e *MediaInputError) Error() string { return e.Message }
func (e *MediaInputError) Unwrap() error { return &gateway.Fault{Code: "MEDIA_INPUT_INVALID"} }

type mediaKindConstraint struct {
	knownBytesOnly, knownMimeOnly bool     // A transport ceiling alone does not require metadata on historical inputs.
	MinWidth                      int64    `json:"minWidth"`
	MinHeight                     int64    `json:"minHeight"`
	MinAspect                     float64  `json:"minAspect"`
	MaxAspect                     float64  `json:"maxAspect"`
	MimeTypes                     []string `json:"mimeTypes"`

	MaxTotalBytes      int64 `json:"maxTotalBytes"`
	MaxBytes           int64 `json:"maxBytes"`
	MaxWidth           int64 `json:"maxWidth"`
	MaxHeight          int64 `json:"maxHeight"`
	MaxPixels          int64 `json:"maxPixels"`
	MinDurationMs      int64 `json:"minDurationMs"`
	MaxDurationMs      int64 `json:"maxDurationMs"`
	MaxTotalDurationMs int64 `json:"maxTotalDurationMs"`
}

type mediaConstraintSet struct {
	SchemaVersion string                         `json:"schemaVersion"`
	Kinds         map[string]mediaKindConstraint `json:"kinds"`
}

func capabilityMediaConstraints(cap gateway.Capability) (*mediaConstraintSet, error) {
	constraints, err := modelMediaConstraints(cap)
	if err != nil || cap.TestMode || (cap.ExecutionKind != "MODEL" && !(cap.ExecutionKind == "" && cap.Model != nil)) {
		return constraints, err
	}
	for _, kind := range []string{"IMAGE", "AUDIO", "VIDEO"} {
		maximum, formats := modelmedia.ReferenceMediaPolicy(kind)
		var limit mediaKindConstraint
		var declared bool
		if constraints != nil {
			limit, declared = constraints.Kinds[kind]
		}
		if !declared && !slices.Contains(cap.InputKinds, kind) {
			continue
		}
		if constraints == nil {
			constraints = &mediaConstraintSet{SchemaVersion: "1"}
		}
		if constraints.Kinds == nil {
			constraints.Kinds = map[string]mediaKindConstraint{}
		}
		limit.knownBytesOnly = limit.MaxBytes <= 0
		limit.knownMimeOnly = limit.MimeTypes == nil
		if limit.knownBytesOnly || maximum < limit.MaxBytes {
			limit.MaxBytes = maximum
		}
		if limit.knownMimeOnly {
			limit.MimeTypes = formats
		} else {
			allowed := make([]string, 0, len(formats))
			for _, mime := range formats {
				if slices.Contains(limit.MimeTypes, mime) {
					allowed = append(allowed, mime)
				}
			}
			limit.MimeTypes = allowed
		}
		constraints.Kinds[kind] = limit
	}
	return constraints, nil
}

func modelMediaConstraints(cap gateway.Capability) (*mediaConstraintSet, error) {
	var schema struct {
		Constraints *mediaConstraintSet `json:"x-input-media-constraints"`
	}
	if json.Unmarshal(cap.ParameterSchema, &schema) != nil {
		return nil, &gateway.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	if schema.Constraints != nil && schema.Constraints.SchemaVersion != "1" {
		return nil, &gateway.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	if schema.Constraints == nil && !cap.TestMode && slices.Contains(cap.InputKinds, "IMAGE") && cap.Version == cap.ParameterSchemaVersion {
		versions := map[string][]string{"codex-text-v1": {"1"}, "codex-vision-text-v1": {"1"}, "codex-6-vision-text-v1": {"1", "2"}, "codex-6-1-vision-text-v1": {"1", "2"}, "codex-image-edit-v1": {"1", "2", "3"}}
		if slices.Contains(versions[cap.Ref], cap.Version) {
			return &mediaConstraintSet{SchemaVersion: "1", Kinds: map[string]mediaKindConstraint{"IMAGE": {MaxBytes: 10 << 20, MaxTotalBytes: 16 << 20, MimeTypes: []string{"image/png", "image/jpeg", "image/webp"}}}}, nil
		}
	}
	if schema.Constraints == nil && officialVideoMediaProvider(cap) != "" {
		mini := cap.Model.ProviderRef == "minimax-official"
		minSide, maxSide, videoBytes := int64(300), int64(6000), int64(64<<20)
		if mini {
			minSide, maxSide, videoBytes = 256, 5760, 50<<20
		}
		videoMin, total := int64(2000), int64(15000)
		if cap.Model.ModelRef == "seedance-2-5-official" {
			total = 30000
			if cap.Kind == "OMNI_REFERENCE" {
				videoMin = 4000
			}
		}
		return &mediaConstraintSet{SchemaVersion: "1", Kinds: map[string]mediaKindConstraint{
			"IMAGE": {MaxBytes: 10 << 20, MinWidth: minSide, MinHeight: minSide, MaxWidth: maxSide, MaxHeight: maxSide, MinAspect: 0.4, MaxAspect: 2.5, MaxPixels: 16777216, MimeTypes: []string{"image/png", "image/jpeg", "image/webp"}},
			"VIDEO": {MaxBytes: videoBytes, MinWidth: 300, MinHeight: 300, MaxPixels: 2073600, MinDurationMs: videoMin, MaxDurationMs: 15000, MaxTotalDurationMs: total, MimeTypes: []string{"video/mp4"}},
			"AUDIO": {MaxBytes: 15 << 20, MinDurationMs: 2000, MaxDurationMs: 15000, MaxTotalDurationMs: total, MimeTypes: []string{"audio/wav", "audio/mpeg"}},
		}}, nil
	}
	return schema.Constraints, nil
}

func officialVideoMediaProvider(cap gateway.Capability) string {
	if cap.TestMode || cap.Model == nil || cap.Version != "1" || cap.ParameterSchemaVersion != "1" || !slices.Contains(cap.OutputKinds, "VIDEO") || cap.Model.ModelRef == "" || !strings.HasPrefix(cap.Ref, cap.Model.ModelRef+"-") {
		return ""
	}
	if cap.Model.ProviderRef != "minimax-official" && cap.Model.ProviderRef != "volcengine-official" {
		return ""
	}
	return cap.Model.ProviderRef
}
func mediaNumber(n float64) string {
	return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.3f", n), "0"), ".")
}

func validateMediaAssets(cap gateway.Capability, assets []Asset) error {
	constraints, err := capabilityMediaConstraints(cap)
	if err != nil || constraints == nil {
		return err
	}
	issues, seen := []string{}, map[string]bool{}
	add := func(message string) {
		if !seen[message] && len(issues) < 8 {
			issues = append(issues, message)
			seen[message] = true
		}
	}
	provider, embedded := officialVideoMediaProvider(cap), int64(0)
	totals, byteTotals := map[string]int64{}, map[string]int64{}
	for _, a := range assets {
		limit, ok := constraints.Kinds[a.Kind]
		if !ok {
			continue
		}
		label := map[string]string{"IMAGE": "参考图片", "AUDIO": "参考音频", "VIDEO": "参考视频"}[a.Kind]
		if label == "" {
			label = "参考素材"
		}
		mime := strings.ToLower(strings.TrimSpace(strings.SplitN(a.MimeType, ";", 2)[0]))
		if limit.MimeTypes != nil && len(limit.MimeTypes) == 0 {
			add(label + "没有可用于此模型的文件格式，请移除此参考或切换模型。")
		} else if len(limit.MimeTypes) > 0 && (mime != "" || !limit.knownMimeOnly) && !slices.Contains(limit.MimeTypes, mime) {
			add(fmt.Sprintf("%s文件格式不支持，请使用 %s。", label, strings.Join(limit.MimeTypes, " / ")))
		}
		if provider != "" && (provider != "volcengine-official" || a.Kind != "VIDEO") && a.ByteSize > 0 && a.ByteSize <= 64<<20 {
			embedded += 4 * ((a.ByteSize + 2) / 3)
		}
		if limit.MaxTotalBytes > 0 && a.ByteSize > 0 && a.ByteSize <= limit.MaxBytes {
			byteTotals[a.Kind] += a.ByteSize
		}
		if limit.MaxBytes > 0 {
			if a.ByteSize < 1 && !limit.knownBytesOnly {
				add(label + "的文件大小尚未就绪，请重新上传后重试。")
			} else if a.ByteSize > limit.MaxBytes {
				add(fmt.Sprintf("%s大小为 %.2f MiB（%d 字节），当前模型最多支持 %s MiB（%d 字节）；请压缩或重新导出后重试。", label, float64(a.ByteSize)/(1<<20), a.ByteSize, mediaNumber(float64(limit.MaxBytes)/(1<<20)), limit.MaxBytes))
			}
		}
		if limit.MinDurationMs > 0 || limit.MaxDurationMs > 0 {
			if a.DurationMs == nil || *a.DurationMs < 1 {
				add(label + "的时长尚未就绪，请重新上传后重试。")
			} else {
				ms := *a.DurationMs
				totals[a.Kind] += ms
				if ms < limit.MinDurationMs || limit.MaxDurationMs > 0 && ms > limit.MaxDurationMs {
					add(fmt.Sprintf("%s时长为 %s 秒，当前模型支持 %s–%s 秒；请裁剪或更换素材后重试。", label, mediaNumber(float64(ms)/1000), mediaNumber(float64(limit.MinDurationMs)/1000), mediaNumber(float64(limit.MaxDurationMs)/1000)))
				}
			}
		}
		if limit.MaxPixels > 0 || limit.MaxWidth > 0 || limit.MaxHeight > 0 {
			if a.Width == nil || a.Height == nil || *a.Width < 1 || *a.Height < 1 {
				add(label + "的尺寸尚未就绪，请重新上传后重试。")
			} else {
				w, h := int64(*a.Width), int64(*a.Height)
				if limit.MinWidth > 0 && w < limit.MinWidth || limit.MinHeight > 0 && h < limit.MinHeight {
					add(fmt.Sprintf("%s尺寸为 %d×%d，至少需要 %d×%d 像素。", label, w, h, limit.MinWidth, limit.MinHeight))
				}
				ratio := float64(w) / float64(h)
				if limit.MinAspect > 0 && ratio < limit.MinAspect || limit.MaxAspect > 0 && ratio > limit.MaxAspect {
					add(fmt.Sprintf("%s宽高比须在 %g–%g 之间，请裁剪后再提交。", label, limit.MinAspect, limit.MaxAspect))
				}
				if limit.MaxWidth > 0 && w > limit.MaxWidth || limit.MaxHeight > 0 && h > limit.MaxHeight || limit.MaxPixels > 0 && w > limit.MaxPixels/h {
					bounds := []string{}
					if limit.MaxWidth > 0 && limit.MaxHeight > 0 {
						bounds = append(bounds, fmt.Sprintf("宽高不超过 %d×%d", limit.MaxWidth, limit.MaxHeight))
					}
					if limit.MaxPixels > 0 {
						bounds = append(bounds, fmt.Sprintf("总像素不超过 %d", limit.MaxPixels))
					}
					add(fmt.Sprintf("%s尺寸为 %d×%d，当前模型要求%s；请缩小分辨率后重试。", label, w, h, strings.Join(bounds, "、")))
				}
			}
		}
	}
	if embedded >= 64<<20 {
		add("参考素材编码后超过官方服务单次 64 MiB 请求上限，请压缩或减少素材。")
	}
	for _, kind := range []string{"IMAGE", "AUDIO", "VIDEO"} {
		if limit := constraints.Kinds[kind]; limit.MaxTotalBytes > 0 && byteTotals[kind] > limit.MaxTotalBytes {
			add(fmt.Sprintf("参考素材合计超过当前模型 %s MiB 上限，请压缩或减少素材。", mediaNumber(float64(limit.MaxTotalBytes)/(1<<20))))
		}
		if limit := constraints.Kinds[kind]; limit.MaxTotalDurationMs > 0 && totals[kind] > limit.MaxTotalDurationMs {
			add(fmt.Sprintf("参考%s总时长为 %s 秒，当前模型合计最多支持 %s 秒；请裁剪或减少素材后重试。", map[string]string{"AUDIO": "音频", "VIDEO": "视频"}[kind], mediaNumber(float64(totals[kind])/1000), mediaNumber(float64(limit.MaxTotalDurationMs)/1000)))
		}
	}
	if len(issues) > 0 {
		return &MediaInputError{Message: strings.Join(issues, " ")}
	}
	return nil
}

func (s *Service) validateRequestMedia(ctx context.Context, owner string, cap gateway.Capability, request gateway.InvocationRequest) error {
	constraints, err := capabilityMediaConstraints(cap)
	if err != nil || constraints == nil || len(request.Attachments) == 0 {
		return err
	}
	ids, seen := []string{}, map[string]bool{}
	for _, a := range request.Attachments {
		if !seen[a.SourceRef] {
			ids = append(ids, a.SourceRef)
			seen[a.SourceRef] = true
		}
	}
	assets, err := s.store.Assets(ctx, owner, ids)
	if err != nil {
		return err
	}
	if len(assets) != len(ids) {
		return &MediaInputError{Message: "参考素材尚未就绪，请重新选择或上传后重试。"}
	}
	return validateMediaAssets(cap, assets)
}
