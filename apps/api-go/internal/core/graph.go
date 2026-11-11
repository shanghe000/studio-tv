package core

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"studiotv.local/service/api/internal/httpapi"
	"sort"
	"strings"
)

var sensitiveKey = regexp.MustCompile(`(?i)(?:password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|platform[_-]?key|authorization|credential)`)

// ValidateProductGraph is the composition seam for typed canvas commands.
// Shared validation preserves the same references and graph rules as Web saves.
func ValidateProductGraph(graph map[string]any) ([]string, error) { return validateGraph(graph) }

func validateGraph(graph map[string]any) ([]string, error) {
	nodes := map[string]bool{}
	parents := map[string]string{}
	edges := map[string]bool{}
	refs := map[string]bool{}
	list, ok := graph["nodes"].([]any)
	if !ok {
		return nil, httpapi.Fail(422, "GRAPH_INVALID", "节点结构无效。")
	}
	for _, value := range list {
		node, ok := value.(map[string]any)
		if !ok {
			return nil, httpapi.Fail(422, "GRAPH_INVALID", "节点结构无效。")
		}
		id, _ := node["id"].(string)
		kind, _ := node["type"].(string)
		data, _ := node["data"].(map[string]any)
		if nodes[id] {
			return nil, httpapi.Fail(422, "GRAPH_INVALID", "节点ID不得重复。")
		}
		if id == "rhtv_meta_v1" && (kind != "__rhtv_meta" || data["version"] != "1") || kind == "__rhtv_meta" && id != "rhtv_meta_v1" {
			return nil, httpapi.Fail(422, "GRAPH_META_INVALID", "保留元节点ID/type/version无效。")
		}
		nodes[id] = true
		if ext, ok := data["__rhtv"].(map[string]any); ok {
			if native, ok := ext["native"].(map[string]any); ok {
				if parent, exists := native["parentId"]; exists && parent != nil {
					pid, ok := parent.(string)
					if !ok || pid == "" || id == "rhtv_meta_v1" {
						return nil, httpapi.Fail(422, "GRAPH_GROUP_INVALID", "分组parentId无效。")
					}
					parents[id] = pid
				}
			}
		}
	}
	done := map[string]bool{}
	for node, parent := range parents {
		if !nodes[parent] || parent == "rhtv_meta_v1" {
			return nil, httpapi.Fail(422, "GRAPH_GROUP_INVALID", "分组引用不存在的节点。")
		}
		if done[node] {
			continue
		}
		seen := map[string]bool{node: true}
		current := parent
		for current != "" && !done[current] {
			if seen[current] {
				return nil, httpapi.Fail(422, "GRAPH_GROUP_CYCLE", "节点分组不能形成循环。")
			}
			seen[current] = true
			current = parents[current]
		}
		for id := range seen {
			done[id] = true
		}
	}
	list, ok = graph["edges"].([]any)
	if !ok {
		return nil, httpapi.Fail(422, "GRAPH_INVALID", "连线结构无效。")
	}
	for _, value := range list {
		edge, ok := value.(map[string]any)
		if !ok {
			return nil, httpapi.Fail(422, "GRAPH_INVALID", "连线结构无效。")
		}
		id, _ := edge["id"].(string)
		source, _ := edge["source"].(string)
		target, _ := edge["target"].(string)
		if edges[id] || !nodes[source] || !nodes[target] || source == "rhtv_meta_v1" || target == "rhtv_meta_v1" {
			return nil, httpapi.Fail(422, "GRAPH_INVALID", "连线重复或引用无效节点。")
		}
		edges[id] = true
	}
	var inspect func(any, int) error
	inspect = func(value any, depth int) error {
		if depth > 100 {
			return httpapi.Fail(422, "GRAPH_INVALID", "节点数据嵌套过深。")
		}
		switch v := value.(type) {
		case json.Number:
			number, err := v.Float64()
			if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
				return httpapi.Fail(422, "GRAPH_INVALID", "画布包含超出有限数字范围的值。")
			}
		case float64:
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return httpapi.Fail(422, "GRAPH_INVALID", "画布包含无效数字。")
			}
		case string:
			if strings.HasPrefix(v, "rhtv-asset:") {
				refs[strings.TrimPrefix(v, "rhtv-asset:")] = true
			}
			if strings.HasPrefix(v, "blob:") || strings.HasPrefix(v, "data:") {
				return httpapi.Fail(422, "GRAPH_LOCAL_MEDIA_FORBIDDEN", "请上传素材并引用assetId。")
			}
		case []any:
			for _, child := range v {
				if err := inspect(child, depth+1); err != nil {
					return err
				}
			}
		case map[string]any:
			for key, child := range v {
				if key == "__proto__" || key == "prototype" || key == "constructor" {
					return httpapi.Fail(422, "GRAPH_KEY_FORBIDDEN", "画布包含不允许的字段。")
				}
				if s, ok := child.(string); ok && s != "" {
					if sensitiveKey.MatchString(key) {
						return httpapi.Fail(422, "GRAPH_SECRET_FORBIDDEN", "画布不能保存密钥或登录凭据。")
					}
					if key == "modelAssetId" {
						return httpapi.Fail(422, "MODEL_ASSET_UNAVAILABLE", "3D模型素材服务尚未启用。")
					}
					if key == "assetId" {
						refs[s] = true
					}
				}
				if err := inspect(child, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := inspect(graph, 0); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(refs))
	for id := range refs {
		if err := requireID(id); err != nil {
			return nil, httpapi.Fail(422, "ASSET_UNAVAILABLE", fmt.Sprintf("素材引用格式无效。"))
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, nil
}
