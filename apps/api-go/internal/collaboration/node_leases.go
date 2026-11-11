package collaboration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"time"

	"studiotv.local/service/api/internal/httpapi"
)

const CanvasSessionHeader = "X-STUDIO-Canvas-Session"
const NodeLeaseTTL = 15 * time.Second
const MaxCanvasLeases = 2048
const MaxClientLeases = 128
const MaxLeaseBatch = 32

type NodeLease struct {
	NodeID      string    `json:"nodeId"`
	ClientID    string    `json:"clientId"`
	UserID      string    `json:"userId"`
	DisplayName string    `json:"displayName"`
	ExpiresAt   time.Time `json:"expiresAt"`
}

func occupiedNode(node, name string) error {
	name = safePresenceName(name)
	if name == "" {
		name = "其他协作者"
	}
	err := httpapi.Fail(409, "NODE_EDIT_OCCUPIED", fmt.Sprintf("%s正在编辑此节点，请等待对方完成后再操作。", safePresenceName(name)))
	err.Details = []httpapi.Detail{{Field: "nodeId", Code: "NODE_EDIT_OCCUPIED", Message: node}}
	return err
}

// Caller must hold the same project row lock used by snapshot/command writes.
// Acquisition uses that lock too, so an ownership change cannot race the write.
// Missing client headers remain compatible only when no active node lease exists.
func CheckNodeLeases(ctx context.Context, db DB, projectID string, identity httpapi.Identity, clientID string, nodeIDs []string) error {
	if active, err := CheckProjectEditSession(ctx, db, projectID, identity, clientID, false); err != nil || active {
		return err
	}
	if len(nodeIDs) == 0 {
		return nil
	}
	if clientID != "" && ValidateID(clientID) != nil {
		return httpapi.Fail(400, "INVALID_CANVAS_SESSION", "画布协作会话无效，请重新打开作品。")
	}
	rows, err := db.Query(ctx, `SELECT l.node_id,l.actor_id,l.session_id,l.client_id,u.display_name
 FROM collaboration.canvas_node_leases l JOIN public.users u ON u.id=l.actor_id
 WHERE l.project_id=$1 AND l.node_id=ANY($2::text[]) AND l.expires_at>clock_timestamp()
 AND NOT u.disabled AND collaboration.project_role(l.project_id,l.actor_id) IN ('OWNER','EDITOR')
 ORDER BY l.node_id`, projectID, nodeIDs)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var node, actor, session, client, name string
		if err = rows.Scan(&node, &actor, &session, &client, &name); err != nil {
			return err
		}
		if actor != identity.UserID || session != identity.SessionID || clientID == "" || clientID != client {
			return occupiedNode(node, name)
		}
	}
	return rows.Err()
}

// ChangedNodeIDs includes layout/data edits, deletions, and both ends of any
// edited connection. It never copies graph contents into an error or log.
func leaseDecode(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	return decoder.Decode(target)
}

func ChangedNodeIDs(before, after json.RawMessage) ([]string, error) {
	type graph struct {
		Nodes []json.RawMessage `json:"nodes"`
		Edges []json.RawMessage `json:"edges"`
	}
	var a, b graph
	if json.Unmarshal(before, &a) != nil || json.Unmarshal(after, &b) != nil {
		return nil, httpapi.Fail(422, "INVALID_GRAPH", "画布数据无效。")
	}
	changed := map[string]bool{}
	nodes := func(rows []json.RawMessage) (map[string]any, error) {
		out := map[string]any{}
		for _, raw := range rows {
			var v map[string]any
			if leaseDecode(raw, &v) != nil {
				return nil, httpapi.Fail(422, "INVALID_GRAPH", "画布节点无效。")
			}
			id, ok := v["id"].(string)
			if !ok || id == "" {
				return nil, httpapi.Fail(422, "INVALID_GRAPH", "画布节点无效。")
			}
			if _, exists := out[id]; exists {
				return nil, httpapi.Fail(422, "INVALID_GRAPH", "画布节点重复。")
			}
			if id == "rhtv_meta_v1" {
				continue
			}
			out[id] = v
		}
		return out, nil
	}
	old, err := nodes(a.Nodes)
	if err != nil {
		return nil, err
	}
	next, err := nodes(b.Nodes)
	if err != nil {
		return nil, err
	}
	for id, v := range old {
		if !reflect.DeepEqual(v, next[id]) {
			changed[id] = true
		}
	}
	for id, v := range next {
		if !reflect.DeepEqual(v, old[id]) {
			changed[id] = true
		}
	}
	// Edge ids are optional in native command projections; use the complete
	// symbolic/metadata representation as a multiset key rather than array order.
	edges := func(rows, graphNodes []json.RawMessage) (map[string]int, map[string][2]string, error) {
		count := map[string]int{}
		ends := map[string][2]string{}
		extras := map[string]any{}
		for _, raw := range graphNodes {
			var meta struct {
				ID   string `json:"id"`
				Data struct {
					Edges map[string]any `json:"edges"`
				} `json:"data"`
			}
			if leaseDecode(raw, &meta) == nil && meta.ID == "rhtv_meta_v1" {
				extras = meta.Data.Edges
			}
		}
		for _, raw := range rows {
			var v map[string]any
			if leaseDecode(raw, &v) != nil {
				return nil, nil, httpapi.Fail(422, "INVALID_GRAPH", "画布连线无效。")
			}
			src, ok := v["source"].(string)
			dst, ok2 := v["target"].(string)
			if !ok || !ok2 || src == "" || dst == "" {
				return nil, nil, httpapi.Fail(422, "INVALID_GRAPH", "画布连线无效。")
			}
			var extra any
			if edgeID, ok := v["id"].(string); ok {
				extra = extras[edgeID]
			}
			canonical, _ := json.Marshal(struct {
				Edge   map[string]any `json:"edge"`
				Native any            `json:"native"`
			}{v, extra})
			key := string(canonical)
			count[key]++
			ends[key] = [2]string{src, dst}
		}
		return count, ends, nil
	}
	ae, ap, err := edges(a.Edges, a.Nodes)
	if err != nil {
		return nil, err
	}
	be, bp, err := edges(b.Edges, b.Nodes)
	if err != nil {
		return nil, err
	}
	for key, n := range ae {
		if be[key] != n {
			for _, id := range ap[key] {
				changed[id] = true
			}
		}
	}
	for key, n := range be {
		if ae[key] != n {
			for _, id := range bp[key] {
				changed[id] = true
			}
		}
	}
	result := make([]string, 0, len(changed))
	for id := range changed {
		result = append(result, id)
	}
	sort.Strings(result)
	return result, nil
}
