package collaboration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
)

const PresenceTTL = 20 * time.Second
const MaxPresenceMembers = 64
const maxSelectedNodes = 32

type CanvasCursor struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

func (c *CanvasCursor) UnmarshalJSON(raw []byte) error {
	var value struct {
		X *float64 `json:"x"`
		Y *float64 `json:"y"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return presenceInvalid()
	}
	if value.X == nil || value.Y == nil {
		return presenceInvalid()
	}
	c.X, c.Y = *value.X, *value.Y
	return nil
}

type PresenceMember struct {
	ClientID        string        `json:"clientId"`
	UserID          string        `json:"userId"`
	DisplayName     string        `json:"displayName"`
	Role            string        `json:"role"`
	Cursor          *CanvasCursor `json:"cursor"`
	SelectedNodeIDs []string      `json:"selectedNodeIds"`
	LastSeenAt      time.Time     `json:"lastSeenAt"`
}
type PresenceSnapshot struct {
	SchemaVersion     string           `json:"schemaVersion"`
	ProjectID         string           `json:"projectId"`
	Epoch             string           `json:"epoch"`
	Sequence          string           `json:"sequence"`
	ServerTime        time.Time        `json:"serverTime"`
	PresenceTTLMillis int64            `json:"presenceTtlMs"`
	LeaseTTLMillis    int64            `json:"leaseTtlMs"`
	Members           []PresenceMember `json:"members"`
	Leases            []NodeLease      `json:"leases"`
}
type presenceParticipant struct {
	PresenceMember
	session    string
	lastUpdate time.Time
}
type presenceProject struct {
	sequence uint64
	members  map[string]presenceParticipant
	watchers map[chan struct{}]struct{}
}
type PresenceService struct {
	pool          *pgxpool.Pool
	mu            sync.Mutex
	projects      map[string]*presenceProject
	epoch         string
	activeStreams int
	userStreams   map[string]int
	// Test seam bounds the same authenticated stream loop without slow sleeps.
	streamLifetime, streamPoll, streamReauthorize time.Duration
}

func NewPresenceService(pool *pgxpool.Pool) (*PresenceService, error) {
	if pool == nil {
		return nil, errors.New("presence pool required")
	}
	return &PresenceService{pool: pool, projects: map[string]*presenceProject{}, epoch: uuid.NewString(), userStreams: map[string]int{}, streamLifetime: 30 * time.Second, streamPoll: 100 * time.Millisecond, streamReauthorize: time.Second}, nil
}
func safePresenceName(name string) string {
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return ' '
		}
		if unicode.Is(unicode.Cf, r) {
			return -1
		}
		return r
	}, name)
	r := []rune(strings.Join(strings.Fields(name), " "))
	if len(r) > 80 {
		r = r[:80]
	}
	return string(r)
}
func presenceInvalid() error {
	return httpapi.Fail(422, "VALIDATION_FAILED", "画布协作状态无效。")
}
func presenceUnavailable() error {
	return httpapi.Retry(503, "CANVAS_PRESENCE_UNAVAILABLE", "协作状态暂时不可用，请稍后重试。")
}
func presenceIdentity(id httpapi.Identity) error {
	if id.UserID == "" || id.SessionID == "" {
		return httpapi.Fail(401, "UNAUTHENTICATED", "请先使用飞书登录。")
	}
	return nil
}
func validCanvasNodeID(id string) bool {
	if len(id) < 1 || len(id) > 200 {
		return false
	}
	for i, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || i > 0 && (c == '_' || c == '-' || c == '.' || c == ':')) {
			return false
		}
	}
	return true
}
func validatePresenceIDs(ids []string, max int) error {
	if len(ids) > max {
		return presenceInvalid()
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !validCanvasNodeID(id) || seen[id] {
			return presenceInvalid()
		}
		seen[id] = true
	}
	return nil
}
func (s *PresenceService) projectLocked(project string) *presenceProject {
	p := s.projects[project]
	if p == nil {
		p = &presenceProject{members: map[string]presenceParticipant{}, watchers: map[chan struct{}]struct{}{}}
		s.projects[project] = p
	}
	return p
}
func (s *PresenceService) signalLocked(p *presenceProject) {
	p.sequence++
	for ch := range p.watchers {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}
func (s *PresenceService) expireLocked(p *presenceProject, now time.Time) {
	expired := false
	for id, m := range p.members {
		if now.Sub(m.LastSeenAt) >= PresenceTTL {
			delete(p.members, id)
			expired = true
		}
	}
	if expired {
		s.signalLocked(p)
	}
}
func (s *PresenceService) bump(project string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.signalLocked(s.projectLocked(project))
}
func (s *PresenceService) currentClient(project string, id httpapi.Identity, client string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.projects[project]
	if p == nil {
		return false
	}
	s.expireLocked(p, time.Now())
	m, ok := p.members[client]
	return ok && m.UserID == id.UserID && m.session == id.SessionID
}

func (s *PresenceService) Heartbeat(ctx context.Context, id httpapi.Identity, project, client string, cursor *CanvasCursor, selection []string) (PresenceSnapshot, error) {
	if presenceIdentity(id) != nil {
		return PresenceSnapshot{}, presenceIdentity(id)
	}
	if ValidateID(client) != nil || validatePresenceIDs(selection, maxSelectedNodes) != nil {
		return PresenceSnapshot{}, presenceInvalid()
	}
	if cursor != nil && (math.IsNaN(cursor.X) || math.IsNaN(cursor.Y) || math.IsInf(cursor.X, 0) || math.IsInf(cursor.Y, 0) || math.Abs(cursor.X) > 1e7 || math.Abs(cursor.Y) > 1e7) {
		return PresenceSnapshot{}, presenceInvalid()
	}
	access, err := RequireProject(ctx, s.pool, id.UserID, project, VIEWER, false)
	if err != nil {
		return PresenceSnapshot{}, err
	}
	var name string
	if err = s.pool.QueryRow(ctx, `SELECT display_name FROM public.users WHERE id=$1`, id.UserID).Scan(&name); err != nil {
		return PresenceSnapshot{}, presenceUnavailable()
	}
	now := time.Now()
	s.mu.Lock()
	if s.projects[project] == nil && len(s.projects) >= 1024 {
		for key, room := range s.projects {
			s.expireLocked(room, now)
			if len(room.members) == 0 && len(room.watchers) == 0 {
				delete(s.projects, key)
			}
		}
		if len(s.projects) >= 1024 {
			s.mu.Unlock()
			return PresenceSnapshot{}, httpapi.Retry(429, "PRESENCE_ROOM_LIMIT", "当前协作画布过多，请稍后重试。")
		}
	}
	p := s.projectLocked(project)
	s.expireLocked(p, now)
	old, exists := p.members[client]
	if exists && (old.UserID != id.UserID || old.session != id.SessionID) {
		s.mu.Unlock()
		return PresenceSnapshot{}, httpapi.Fail(409, "PRESENCE_CLIENT_CONFLICT", "画布协作会话已变更，请重新打开作品。")
	}
	if !exists && len(p.members) >= MaxPresenceMembers {
		s.mu.Unlock()
		return PresenceSnapshot{}, httpapi.Retry(429, "PRESENCE_MEMBER_LIMIT", "当前画布在线页面已达到上限。")
	}
	if exists && now.Sub(old.lastUpdate) < 75*time.Millisecond {
		s.mu.Unlock()
		return PresenceSnapshot{}, httpapi.Retry(429, "PRESENCE_RATE_LIMIT", "协作状态发送过于频繁。")
	}
	var copiedCursor *CanvasCursor
	if cursor != nil {
		v := *cursor
		copiedCursor = &v
	}
	selected := append([]string{}, selection...)
	p.members[client] = presenceParticipant{PresenceMember: PresenceMember{ClientID: client, UserID: id.UserID, DisplayName: safePresenceName(name), Role: access.Role, Cursor: copiedCursor, SelectedNodeIDs: selected, LastSeenAt: now}, session: id.SessionID, lastUpdate: now}
	s.signalLocked(p)
	s.mu.Unlock()
	// The heartbeat never claims new nodes. It renews only already-held leases.
	if _, err = s.pool.Exec(ctx, `UPDATE collaboration.canvas_node_leases SET expires_at=clock_timestamp()+interval '15 seconds',updated_at=clock_timestamp() WHERE project_id=$1 AND actor_id=$2 AND session_id=$3 AND client_id=$4 AND expires_at>clock_timestamp() AND collaboration.project_role(project_id,actor_id) IN ('OWNER','EDITOR')`, project, id.UserID, id.SessionID, client); err != nil {
		return PresenceSnapshot{}, presenceUnavailable()
	}
	return s.Snapshot(ctx, id, project)
}

func (s *PresenceService) Snapshot(ctx context.Context, id httpapi.Identity, project string) (PresenceSnapshot, error) {
	empty := PresenceSnapshot{}
	if err := presenceIdentity(id); err != nil {
		return empty, err
	}
	if _, err := RequireProject(ctx, s.pool, id.UserID, project, VIEWER, false); err != nil {
		return empty, err
	}
	now := time.Now()
	s.mu.Lock()
	p := s.projects[project]
	if p == nil {
		p = &presenceProject{members: map[string]presenceParticipant{}, watchers: map[chan struct{}]struct{}{}}
	}
	s.expireLocked(p, now)
	p.sequence++ // A snapshot read also versions lease expiry/renewal, without broadcasting.
	result := PresenceSnapshot{SchemaVersion: "1", ProjectID: project, Epoch: s.epoch, Sequence: strconv.FormatUint(p.sequence, 10), ServerTime: now, PresenceTTLMillis: PresenceTTL.Milliseconds(), LeaseTTLMillis: NodeLeaseTTL.Milliseconds(), Members: []PresenceMember{}, Leases: []NodeLease{}}
	ids := make([]string, 0, len(p.members))
	members := make([]PresenceMember, 0, len(p.members))
	for _, m := range p.members {
		ids = append(ids, m.UserID)
		v := m.PresenceMember
		v.SelectedNodeIDs = append([]string{}, v.SelectedNodeIDs...)
		if v.Cursor != nil {
			c := *v.Cursor
			v.Cursor = &c
		}
		members = append(members, v)
	}
	s.mu.Unlock()
	// Permission/name truth is queried anew; revoked participants disappear from
	// the next snapshot even if their browser has not sent a leave frame.
	visible := map[string]struct{ name, role string }{}
	if len(ids) > 0 {
		rows, err := s.pool.Query(ctx, `SELECT u.id,u.display_name,collaboration.project_role($1,u.id) FROM public.users u WHERE u.id=ANY($2::text[]) AND NOT u.disabled`, project, ids)
		if err != nil {
			return empty, presenceUnavailable()
		}
		for rows.Next() {
			var uid, name string
			var role *string
			if err = rows.Scan(&uid, &name, &role); err != nil {
				rows.Close()
				return empty, presenceUnavailable()
			}
			if role != nil && Rank(*role) > 0 {
				visible[uid] = struct{ name, role string }{safePresenceName(name), *role}
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return empty, presenceUnavailable()
		}
	}
	for _, m := range members {
		if row, ok := visible[m.UserID]; ok {
			m.DisplayName, m.Role = row.name, row.role
			result.Members = append(result.Members, m)
		}
	}
	sort.Slice(result.Members, func(i, j int) bool { return result.Members[i].ClientID < result.Members[j].ClientID })
	rows, err := s.pool.Query(ctx, `SELECT l.node_id,l.client_id,l.actor_id,u.display_name,l.expires_at FROM collaboration.canvas_node_leases l JOIN public.users u ON u.id=l.actor_id WHERE l.project_id=$1 AND l.expires_at>clock_timestamp() AND NOT u.disabled AND collaboration.project_role(l.project_id,l.actor_id) IN ('OWNER','EDITOR') ORDER BY l.node_id LIMIT 2048`, project)
	if err != nil {
		return empty, presenceUnavailable()
	}
	defer rows.Close()
	for rows.Next() {
		var lease NodeLease
		if err = rows.Scan(&lease.NodeID, &lease.ClientID, &lease.UserID, &lease.DisplayName, &lease.ExpiresAt); err != nil {
			return empty, presenceUnavailable()
		}
		lease.DisplayName = safePresenceName(lease.DisplayName)
		result.Leases = append(result.Leases, lease)
	}
	if rows.Err() != nil {
		return empty, presenceUnavailable()
	}
	return result, nil
}

func (s *PresenceService) Acquire(ctx context.Context, id httpapi.Identity, project, client string, nodeIDs []string) (PresenceSnapshot, error) {
	if err := presenceIdentity(id); err != nil {
		return PresenceSnapshot{}, err
	}
	if ValidateID(client) != nil || len(nodeIDs) == 0 || validatePresenceIDs(nodeIDs, MaxLeaseBatch) != nil {
		return PresenceSnapshot{}, presenceInvalid()
	}
	if !s.currentClient(project, id, client) {
		return PresenceSnapshot{}, httpapi.Fail(409, "PRESENCE_REQUIRED", "请先连接当前画布协作会话。")
	}
	_, err := database.Transaction(ctx, s.pool, func(tx pgx.Tx) (bool, error) {
		if _, err := RequireProject(ctx, tx, id.UserID, project, EDITOR, true); err != nil {
			return false, err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM collaboration.canvas_node_leases WHERE project_id=$1 AND (expires_at<=clock_timestamp() OR NOT EXISTS(SELECT 1 FROM public.users u WHERE u.id=actor_id AND NOT u.disabled) OR collaboration.project_role(project_id,actor_id) NOT IN ('OWNER','EDITOR') OR collaboration.project_role(project_id,actor_id) IS NULL)`, project); err != nil {
			return false, presenceUnavailable()
		}
		if err := CheckNodeLeases(ctx, tx, project, id, client, nodeIDs); err != nil {
			// Old clients acquire individual nodes before autosave. A public
			// presence ID cannot authenticate a page on an upgraded canvas.
			var refusal *httpapi.Error
			proof, _ := ctx.Value(canvasProofKey{}).(canvasWriteCredential)
			if errors.As(err, &refusal) && refusal.Code == "EDIT_SESSION_EXPIRED" && (proof.proof == "" || proof.lease == "") {
				return false, LegacyCanvasPageUpdateRequired()
			}
			return false, err
		}
		var existing int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM public.projects p,jsonb_array_elements(p.graph->'nodes') n WHERE p.id=$1 AND n->>'id'=ANY($2::text[])`, project, nodeIDs).Scan(&existing); err != nil {
			return false, presenceUnavailable()
		}
		if existing != len(nodeIDs) {
			return false, httpapi.Fail(404, "CANVAS_NODE_NOT_FOUND", "部分节点已删除，请等待画布同步后再操作。")
		}
		var total, own, added int
		if err := tx.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE actor_id=$2 AND session_id=$3 AND client_id=$4),count(*) FILTER(WHERE node_id=ANY($5::text[])) FROM collaboration.canvas_node_leases WHERE project_id=$1`, project, id.UserID, id.SessionID, client, nodeIDs).Scan(&total, &own, &added); err != nil {
			return false, presenceUnavailable()
		}
		if total+len(nodeIDs)-added > MaxCanvasLeases || own+len(nodeIDs)-added > MaxClientLeases {
			return false, httpapi.Retry(429, "NODE_LEASE_LIMIT", "同时编辑的节点过多，请先完成其他节点的操作。")
		}
		for _, node := range nodeIDs {
			if _, err := tx.Exec(ctx, `INSERT INTO collaboration.canvas_node_leases(project_id,node_id,actor_id,session_id,client_id,expires_at) VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '15 seconds') ON CONFLICT(project_id,node_id) DO UPDATE SET actor_id=EXCLUDED.actor_id,session_id=EXCLUDED.session_id,client_id=EXCLUDED.client_id,expires_at=EXCLUDED.expires_at,updated_at=clock_timestamp()`, project, node, id.UserID, id.SessionID, client); err != nil {
				return false, presenceUnavailable()
			}
		}
		return true, nil
	})
	if err != nil {
		return PresenceSnapshot{}, err
	}
	s.bump(project)
	return s.Snapshot(ctx, id, project)
}

func (s *PresenceService) Release(ctx context.Context, id httpapi.Identity, project, client string, nodeIDs []string, leave bool) (PresenceSnapshot, error) {
	if err := presenceIdentity(id); err != nil {
		return PresenceSnapshot{}, err
	}
	if ValidateID(client) != nil || validatePresenceIDs(nodeIDs, MaxLeaseBatch) != nil {
		return PresenceSnapshot{}, presenceInvalid()
	}
	_, err := database.Transaction(ctx, s.pool, func(tx pgx.Tx) (bool, error) {
		if _, e := RequireProject(ctx, tx, id.UserID, project, VIEWER, true); e != nil {
			return false, e
		}
		query := `DELETE FROM collaboration.canvas_node_leases WHERE project_id=$1 AND actor_id=$2 AND session_id=$3 AND client_id=$4`
		args := []any{project, id.UserID, id.SessionID, client}
		if !leave {
			query += ` AND node_id=ANY($5::text[])`
			args = append(args, nodeIDs)
		}
		_, e := tx.Exec(ctx, query, args...)
		return e == nil, e
	})
	if err != nil {
		return PresenceSnapshot{}, err
	}
	s.mu.Lock()
	p := s.projects[project]
	if p == nil {
		p = &presenceProject{members: map[string]presenceParticipant{}, watchers: map[chan struct{}]struct{}{}}
	}
	if m, ok := p.members[client]; leave && ok && m.UserID == id.UserID && m.session == id.SessionID {
		delete(p.members, client)
	}
	s.signalLocked(p)
	s.mu.Unlock()
	return s.Snapshot(ctx, id, project)
}

func RegisterPresenceRoutes(r chi.Router, service *PresenceService, protect Protect) error {
	if r == nil || service == nil || protect == nil {
		return errors.New("presence route dependencies required")
	}
	base := "/api/v2/projects/{projectId}"
	route := func(method, path string, handler httpapi.Handler) {
		r.MethodFunc(method, base+path, protect("tv.access", handler))
	}
	route("POST", "/presence", func(w http.ResponseWriter, r *http.Request) error {
		if r.URL.RawQuery != "" {
			return presenceInvalid()
		}
		var body struct {
			ClientID        string        `json:"clientId"`
			Cursor          *CanvasCursor `json:"cursor"`
			SelectedNodeIDs []string      `json:"selectedNodeIds"`
		}
		if err := httpapi.DecodeLimit(w, r, &body, 8192); err != nil {
			return err
		}
		value, err := service.Heartbeat(r.Context(), httpapi.IdentityFrom(r), chi.URLParam(r, "projectId"), body.ClientID, body.Cursor, body.SelectedNodeIDs)
		if err != nil {
			return err
		}
		w.Header().Set("Cache-Control", "no-store")
		return httpapi.OK(w, r, 200, value)
	})
	clientQuery := func(r *http.Request) error {
		query, parseErr := url.ParseQuery(r.URL.RawQuery)
		if parseErr != nil || len(query) > 1 || len(query["clientId"]) > 1 {
			return presenceInvalid()
		}
		for key := range query {
			if key != "clientId" {
				return presenceInvalid()
			}
		}
		if client := query.Get("clientId"); client != "" && ValidateID(client) != nil {
			return presenceInvalid()
		}
		return nil
	}
	route("GET", "/presence", func(w http.ResponseWriter, r *http.Request) error {
		if err := clientQuery(r); err != nil {
			return err
		}
		if strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
			return httpapi.Fail(406, "PRESENCE_STREAM_ROUTE", "协作事件流请使用presence/events接口。")
		}
		value, err := service.Snapshot(r.Context(), httpapi.IdentityFrom(r), chi.URLParam(r, "projectId"))
		if err != nil {
			return err
		}
		w.Header().Set("Cache-Control", "no-store")
		return httpapi.OK(w, r, 200, value)
	})
	route("GET", "/presence/events", func(w http.ResponseWriter, r *http.Request) error {
		if err := clientQuery(r); err != nil {
			return err
		}
		if !strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
			return httpapi.Fail(406, "PRESENCE_STREAM_REQUIRED", "协作事件流需要text/event-stream。")
		}
		return service.serveStream(w, r, chi.URLParam(r, "projectId"))
	})
	route("DELETE", "/presence/{clientId}", func(w http.ResponseWriter, r *http.Request) error {
		if r.URL.RawQuery != "" {
			return presenceInvalid()
		}
		value, err := service.Release(r.Context(), httpapi.IdentityFrom(r), chi.URLParam(r, "projectId"), chi.URLParam(r, "clientId"), nil, true)
		if err != nil {
			return err
		}
		return httpapi.OK(w, r, 200, value)
	})
	for _, method := range []string{"POST", "DELETE"} {
		method := method
		route(method, "/node-leases", func(w http.ResponseWriter, r *http.Request) error {
			if r.URL.RawQuery != "" {
				return presenceInvalid()
			}
			var body struct {
				ClientID string   `json:"clientId"`
				NodeIDs  []string `json:"nodeIds"`
			}
			if err := httpapi.DecodeLimit(w, r, &body, 8192); err != nil {
				return err
			}
			var value PresenceSnapshot
			var err error
			if method == "POST" {
				value, err = service.Acquire(r.Context(), httpapi.IdentityFrom(r), chi.URLParam(r, "projectId"), body.ClientID, body.NodeIDs)
			} else {
				value, err = service.Release(r.Context(), httpapi.IdentityFrom(r), chi.URLParam(r, "projectId"), body.ClientID, body.NodeIDs, false)
			}
			if err != nil {
				return err
			}
			return httpapi.OK(w, r, 200, value)
		})
	}
	return nil
}
