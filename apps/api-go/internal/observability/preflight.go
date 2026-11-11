package observability

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// PreflightContext contains bounded client claims, never provider evidence or
// arbitrary error text. Symbolic fields are shared with the browser validator.
type PreflightContext struct {
	SchemaVersion     string           `json:"schemaVersion"`
	CapabilityRef     string           `json:"capabilityRef,omitempty"`
	CapabilityVersion string           `json:"capabilityVersion,omitempty"`
	RequestedKind     string           `json:"requestedKind,omitempty"`
	InputKinds        []string         `json:"inputKinds,omitempty"`
	Issues            []PreflightIssue `json:"issues,omitempty"`
	Sync              *PreflightSync   `json:"sync,omitempty"`
}

// PreflightSync locates a blocked canvas observation without sending arbitrary
// graph paths or any of the conflicting values to the logging boundary.
type PreflightSync struct {
	BlockedReason string                  `json:"blockedReason"`
	Generation    *int64                  `json:"generation,omitempty"`
	Conflicts     []PreflightSyncConflict `json:"conflicts,omitempty"`
}

type PreflightSyncConflict struct {
	Reason       string `json:"reason"`
	Component    string `json:"component"`
	SourceNodeID string `json:"sourceNodeId,omitempty"`
}

type PreflightIssue struct {
	Component     string   `json:"component,omitempty"`
	Field         string   `json:"field"`
	Reason        string   `json:"reason"`
	InputKind     string   `json:"inputKind,omitempty"`
	InputIndex    *int     `json:"inputIndex,omitempty"`
	AssetID       string   `json:"assetId,omitempty"`
	SourceNodeID  string   `json:"sourceNodeId,omitempty"`
	Actual        *float64 `json:"actual,omitempty"`
	Expected      *float64 `json:"expected,omitempty"`
	Minimum       *float64 `json:"minimum,omitempty"`
	Maximum       *float64 `json:"maximum,omitempty"`
	ExpectedKinds []string `json:"expectedKinds,omitempty"`
	ParameterPath []any    `json:"parameterPath,omitempty"`
	ParameterRule string   `json:"parameterRule,omitempty"`
}

var preflightFields = map[string]string{
	"model.kind": "模型类型", "output.kind": "输出类型", "inputs.kind": "输入类型",
	"inputs.command": "生成命令输入", "inputs.snapshot": "画布当前输入",
	"references.kind": "参考素材类型", "references.count": "参考素材数量", "references.total": "参考素材总数",
	"references.visual": "图片或视频参考", "references.any": "参考素材", "references.upload": "素材上传状态",
	"media.byteSize": "素材大小", "media.durationMs": "素材时长", "media.totalDurationMs": "素材合计时长",
	"media.width": "素材宽度", "media.height": "素材高度", "media.pixels": "素材像素数", "parameters": "模型参数",
}
var preflightReasons = map[string]string{
	"KIND_UNSUPPORTED": "不支持此类型", "KIND_MISMATCH": "类型不匹配", "OUTPUT_UNSUPPORTED": "不支持所需输出",
	"REFERENCE_FORBIDDEN": "不接受参考素材", "COUNT_EXCEEDED": "数量超出上限", "COUNT_REQUIRED": "数量不符合要求",
	"REFERENCE_REQUIRED": "缺少必需参考", "UPLOAD_PENDING": "尚未上传完成", "UPLOAD_FAILED": "上传失败",
	"MAXIMUM_EXCEEDED": "超出上限", "MINIMUM_NOT_MET": "低于下限", "METADATA_MISSING": "缺少有效元数据",
	"PARAMETER_INVALID": "参数无效", "MODEL_UNAVAILABLE": "模型不可用", "MODEL_VERSION_CHANGED": "模型版本已变化",
	"COMMAND_MISMATCH": "生成命令投影不一致", "INPUT_CHANGED": "提交期间输入已变化",
}
var preflightComponents = map[string]string{"MODEL": "模型", "PROMPT": "描述", "REFERENCES": "参考素材", "PARAMETERS": "生成参数", "PRESETS": "预设", "HISTORY": "历史选择", "OUTPUT": "生成结果", "TOPOLOGY": "连线", "IDENTITY": "节点身份", "PERMISSIONS": "项目权限", "METADATA": "节点辅助信息"}
var preflightSyncBlockedReasons = map[string]string{"MERGE_CONFLICT": "修改合并冲突", "BASE_UNKNOWN": "缺少已确认的同步基线", "CAS_UNCERTAIN": "保存结果待确认"}
var preflightSyncConflictReasons = map[string]string{"FIELD_CHANGED": "同一内容发生变更", "DELETE_EDIT": "删除与编辑冲突", "MODEL_PARAMETERS": "模型与参数组合发生变更", "GROUP_POSITION": "分组与位置发生变更", "DANGLING_REFERENCE": "连线端点缺失", "BASE_UNKNOWN": "缺少已确认的同步基线"}
var preflightKinds = map[string]string{"TEXT": "文字", "STRUCTURED": "结构化内容", "IMAGE": "图片", "VIDEO": "视频", "AUDIO": "音频", "UNKNOWN": "未知类型"}
var preflightParameterNames = map[string]string{
	"outputPreset": "输出规格", "count": "生成数量", "transparentBackground": "透明背景", "reasoningEffort": "推理强度", "reasoning_effort": "推理强度",
	"seed": "随机种子", "width": "宽度", "height": "高度", "aspectRatio": "画面比例", "steps": "采样步数", "guidanceScale": "引导强度", "cfgScale": "引导强度", "cfg": "引导强度", "strength": "强度", "denoise": "降噪强度", "sampler": "采样器", "scheduler": "调度器",
	"quality": "质量", "format": "格式", "background": "背景", "mode": "模式", "prompt": "描述", "text": "文字", "voice": "音色", "voiceId": "音色编号", "language": "语言", "speed": "速度", "pitch": "音高", "volume": "音量",
	"temperature": "采样温度", "topP": "采样概率", "topK": "候选数量", "maxTokens": "最大输出长度", "maxOutputTokens": "最大输出长度", "maxCompletionTokens": "最大输出长度", "minP": "最低采样概率", "presencePenalty": "出现惩罚", "frequencyPenalty": "频率惩罚", "stop": "停止条件",
	"generateAudio": "生成音频", "returnLastFrame": "返回尾帧", "subjectMapping": "人物配对", "referenceSubjectIndex": "参考人物序号", "sourceSubjectIndex": "源人物序号", "duration": "时长", "durationSeconds": "时长", "fps": "帧率", "resolution": "分辨率", "numFrames": "帧数", "batchSize": "批次数量", "numImages": "图片数量", "guidance": "引导参数", "style": "风格", "enabled": "启用状态",
}
var preflightParameterRules = map[string]string{
	"required": "缺少必填参数", "type": "类型不受支持", "enum": "不是模型支持的选项", "const": "不符合固定要求", "minimum": "低于范围下限", "maximum": "超过范围上限", "multipleOf": "不符合步长", "minLength": "长度不足", "maxLength": "长度超限", "pattern": "格式不符", "minItems": "数量不足", "maxItems": "数量超限", "uniqueItems": "存在重复项", "additionalProperties": "存在未声明字段", "forbidden": "不允许使用", "anyOf": "不符合允许的组合", "oneOf": "不符合唯一组合", "not": "使用了禁止组合", "contains": "缺少符合要求的项目", "minProperties": "字段数量不足", "maxProperties": "字段数量超限", "unsupportedSchema": "参数规则暂不受支持", "complexity": "参数规则过于复杂",
}

func preflightParameterIndex(value any) (int, bool) {
	var number float64
	switch v := value.(type) {
	case int:
		number = float64(v)
	case int64:
		number = float64(v)
	case float64:
		number = v
	case json.Number:
		var err error
		number, err = v.Float64()
		if err != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	return int(number), !math.IsNaN(number) && !math.IsInf(number, 0) && number >= 0 && number <= 9999 && math.Trunc(number) == number
}

func validPreflightParameterPath(path []any) bool {
	if len(path) > 12 {
		return false
	}
	for _, part := range path {
		if name, ok := part.(string); ok {
			if _, known := preflightParameterNames[name]; !known {
				return false
			}
		} else if _, ok := preflightParameterIndex(part); !ok {
			return false
		}
	}
	return true
}

func preflightParameterLabel(path []any) string {
	var result strings.Builder
	for _, part := range path {
		if name, ok := part.(string); ok {
			if result.Len() > 0 {
				result.WriteString(" / ")
			}
			result.WriteString(preflightParameterNames[name])
		} else if index, ok := preflightParameterIndex(part); ok {
			fmt.Fprintf(&result, "[第%d项]", index+1)
		}
	}
	return result.String()
}

func validPreflightKinds(kinds []string) bool {
	if len(kinds) > len(preflightKinds) {
		return false
	}
	seen := map[string]bool{}
	for _, kind := range kinds {
		if _, ok := preflightKinds[kind]; !ok || seen[kind] {
			return false
		}
		seen[kind] = true
	}
	return true
}

// Valid is also checked at the logging boundary so accidental internal callers
// cannot bypass the same limits enforced by the diagnostic HTTP endpoint.
func (p *PreflightContext) Valid() bool {
	if p == nil || p.SchemaVersion != "1" || len(p.Issues) > 16 ||
		p.CapabilityRef != "" && safeID(p.CapabilityRef) == "" ||
		p.CapabilityVersion != "" && (len(p.CapabilityVersion) > 100 || safeID(p.CapabilityVersion) == "") ||
		p.RequestedKind != "" && !codePattern.MatchString(p.RequestedKind) || !validPreflightKinds(p.InputKinds) {
		return false
	}
	if p.Sync != nil {
		if _, ok := preflightSyncBlockedReasons[p.Sync.BlockedReason]; !ok || len(p.Sync.Conflicts) > 16 ||
			p.Sync.Generation != nil && (*p.Sync.Generation < 0 || *p.Sync.Generation > 9007199254740991) {
			return false
		}
		for _, conflict := range p.Sync.Conflicts {
			if _, ok := preflightSyncConflictReasons[conflict.Reason]; !ok {
				return false
			}
			if _, ok := preflightComponents[conflict.Component]; !ok || conflict.SourceNodeID != "" && safeID(conflict.SourceNodeID) == "" {
				return false
			}
		}
	}
	for _, issue := range p.Issues {
		if !validPreflightParameterPath(issue.ParameterPath) {
			return false
		}
		if issue.ParameterRule != "" {
			if _, ok := preflightParameterRules[issue.ParameterRule]; !ok {
				return false
			}
		}
		if (len(issue.ParameterPath) > 0 || issue.ParameterRule != "") && (issue.Field != "parameters" || issue.Reason != "PARAMETER_INVALID") {
			return false
		}
		if issue.Component != "" {
			if _, ok := preflightComponents[issue.Component]; !ok {
				return false
			}
		}
		if _, ok := preflightFields[issue.Field]; !ok {
			return false
		}
		if _, ok := preflightReasons[issue.Reason]; !ok {
			return false
		}
		if issue.InputKind != "" {
			if _, ok := preflightKinds[issue.InputKind]; !ok {
				return false
			}
		}
		if issue.InputIndex != nil && (*issue.InputIndex < 0 || *issue.InputIndex > 9999) ||
			issue.AssetID != "" && safeID(issue.AssetID) == "" || issue.SourceNodeID != "" && safeID(issue.SourceNodeID) == "" || !validPreflightKinds(issue.ExpectedKinds) {
			return false
		}
		for _, value := range []*float64{issue.Actual, issue.Expected, issue.Minimum, issue.Maximum} {
			if value != nil && (math.IsNaN(*value) || math.IsInf(*value, 0) || *value < 0 || *value > 9007199254740991) {
				return false
			}
		}
		if issue.Minimum != nil && issue.Maximum != nil && *issue.Minimum > *issue.Maximum {
			return false
		}
	}
	return true
}

func preflightNumber(value *float64) string { return strconv.FormatFloat(*value, 'f', -1, 64) }

func (p *PreflightContext) summary() string {
	if !p.Valid() {
		return ""
	}
	parts := []string{"客户端前置校验"}
	if p.Sync != nil {
		parts = append(parts, "画布同步："+preflightSyncBlockedReasons[p.Sync.BlockedReason]+"（"+p.Sync.BlockedReason+"）")
		if p.Sync.Generation != nil {
			parts = append(parts, "同步检查序号="+strconv.FormatInt(*p.Sync.Generation, 10))
		}
		for _, conflict := range p.Sync.Conflicts {
			label := "同步冲突·" + preflightComponents[conflict.Component] + "：" + preflightSyncConflictReasons[conflict.Reason] + "（" + conflict.Reason + "）"
			if conflict.SourceNodeID != "" {
				label += "，source_node_id=" + conflict.SourceNodeID
			}
			parts = append(parts, label)
		}
	}
	if len(p.InputKinds) > 0 {
		kinds := make([]string, 0, len(p.InputKinds))
		for _, kind := range p.InputKinds {
			kinds = append(kinds, preflightKinds[kind])
		}
		parts = append(parts, "输入="+strings.Join(kinds, "、"))
	}
	for _, issue := range p.Issues {
		label := preflightFields[issue.Field]
		if issue.Component != "" {
			label += "·" + preflightComponents[issue.Component]
		}
		if len(issue.ParameterPath) > 0 {
			label += "（" + preflightParameterLabel(issue.ParameterPath) + "）"
		}
		if issue.InputIndex != nil {
			label = fmt.Sprintf("第%d项%s", *issue.InputIndex+1, label)
		}
		if issue.InputKind != "" {
			label += "(" + preflightKinds[issue.InputKind] + ")"
		}
		unit := ""
		switch issue.Field {
		case "media.byteSize":
			unit = "字节"
		case "media.durationMs", "media.totalDurationMs":
			unit = "毫秒"
		case "media.width", "media.height", "media.pixels":
			unit = "像素"
		}
		values := []string{preflightReasons[issue.Reason]}
		if issue.ParameterRule != "" {
			values = append(values, "规则："+preflightParameterRules[issue.ParameterRule])
		}
		for _, row := range []struct {
			label string
			value *float64
		}{{"实际", issue.Actual}, {"要求", issue.Expected}, {"下限", issue.Minimum}, {"上限", issue.Maximum}} {
			if row.value != nil {
				values = append(values, row.label+preflightNumber(row.value)+unit)
			}
		}
		if len(issue.ExpectedKinds) > 0 {
			kinds := []string{}
			for _, kind := range issue.ExpectedKinds {
				kinds = append(kinds, preflightKinds[kind])
			}
			values = append(values, "支持"+strings.Join(kinds, "、"))
		}
		if issue.AssetID != "" {
			values = append(values, "asset_id="+issue.AssetID)
		}
		if issue.SourceNodeID != "" {
			values = append(values, "source_node_id="+issue.SourceNodeID)
		}
		parts = append(parts, label+"："+strings.Join(values, "，"))
	}
	return strings.Join(parts, "；")
}

func (p *PreflightContext) signature() string {
	if !p.Valid() {
		return ""
	}
	data, _ := json.Marshal(p)
	digest := sha256.Sum256(data)
	return fmt.Sprintf("%x", digest[:16])
}
