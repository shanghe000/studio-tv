package product

import (
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"net/http"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/observability"
	"regexp"
	"strings"
)

var diagnosticID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$`)
var diagnosticRequestID = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`)
var diagnosticCode = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)

func registerGenerationDiagnostics(r chi.Router, pool *pgxpool.Pool, o *observability.Observer) {
	if o == nil {
		return
	}
	r.MethodFunc("POST", "/api/v2/generation-diagnostics", protectedHandler("tv.access", func(w http.ResponseWriter, r *http.Request) error {
		var b struct {
			ProjectID        string                          `json:"projectId"`
			NodeID           string                          `json:"nodeId"`
			SceneCode        string                          `json:"sceneCode"`
			ErrorCode        string                          `json:"errorCode"`
			ClientSnapshot   *observability.ClientSnapshot   `json:"clientSnapshot,omitempty"`
			RelatedRequestID string                          `json:"relatedRequestId,omitempty"`
			Preflight        *observability.PreflightContext `json:"preflight,omitempty"`
		}
		if e := httpapi.DecodeLimit(w, r, &b, 16*1024); e != nil {
			return e
		}
		if !diagnosticID.MatchString(b.ProjectID) || !diagnosticID.MatchString(b.NodeID) || !diagnosticCode.MatchString(b.ErrorCode) || b.SceneCode != "" && (!diagnosticID.MatchString(b.SceneCode) || !strings.HasPrefix(b.SceneCode, "canvas-")) {
			return httpapi.Fail(422, "VALIDATION_FAILED", "诊断字段无效。")
		}
		if b.Preflight != nil && !b.Preflight.Valid() {
			return httpapi.Fail(422, "VALIDATION_FAILED", "前置校验诊断字段无效。")
		}
		if b.ClientSnapshot != nil && !b.ClientSnapshot.Valid() || b.RelatedRequestID != "" && (b.ClientSnapshot == nil || !diagnosticRequestID.MatchString(b.RelatedRequestID)) {
			return httpapi.Fail(422, "VALIDATION_FAILED", "网页状态快照字段无效。")
		}
		if _, e := collaboration.RequireProject(r.Context(), pool, httpapi.IdentityFrom(r).UserID, b.ProjectID, "EDITOR", false); e != nil {
			return e
		}
		// Client claims are marked distinctly; never accept stack/body/prompt/URL.
		stage, state, notify := "CLIENT_PREFLIGHT", "REJECTED", true
		if b.RelatedRequestID != "" || b.ClientSnapshot != nil && b.ClientSnapshot.Phase == "SUBMIT" {
			// An HTTP error already has its own notification. A transport failure
			// after dispatch does not establish whether the task was accepted.
			stage, state, notify = "CLIENT_SUBMISSION_SNAPSHOT", "OBSERVED", false
		}
		o.Generation(r.Context(), observability.Generation{ActorID: httpapi.IdentityFrom(r).UserID, ProjectID: b.ProjectID, NodeID: b.NodeID, SceneCode: b.SceneCode, ErrorCode: b.ErrorCode, State: state, Stage: stage, Preflight: b.Preflight, Notify: notify, ClientSnapshot: b.ClientSnapshot, RelatedRequestID: b.RelatedRequestID})
		return httpapi.OK(w, r, 202, map[string]string{"logId": observability.LogID(r.Context())})
	}))
}
