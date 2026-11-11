package core

import (
	"net/http"
	"strings"

	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
)

func capabilityFor(method, path string) string {
	switch {
	case path == "/api/v2/project-previews/query":
		return authorization.TVAccess
	case path == "/api/v2/projects/{projectId}/canvas-operations" || path == "/api/v2/projects/{projectId}/edit-session" || strings.HasPrefix(path, "/api/v2/projects/{projectId}/edit-session/"):
		return authorization.TVAccess
	case path == "/api/v1/projects" || strings.HasPrefix(path, "/api/v1/projects/{projectId}"):
		if strings.Contains(path, "share-link") {
			return ""
		}
		return authorization.TVAccess
	case path == "/api/v1/assets" || path == "/api/v1/assets/{assetId}" || path == "/api/v2/assets/resolve-batch":
		return authorization.TVAccess
	case path == "/api/v1/asset-uploads" || strings.HasPrefix(path, "/api/v1/asset-uploads/{uploadId}"):
		return authorization.TVAccess
	}
	return ""
}

func (s *Server) requireCapability(method, path string, next httpapi.Handler) httpapi.Handler {
	capability := capabilityFor(method, path)
	if capability == "" {
		return next
	}
	return func(w http.ResponseWriter, r *http.Request) error {
		if err := s.authorization.Check(r.Context(), httpapi.IdentityFrom(r), capability); err != nil {
			return err
		}
		return next(w, r)
	}
}

func (s *Server) ownedProject(r *http.Request, db DB, id string, lock bool) (Project, error) {
	role := collaboration.VIEWER
	if r.Method != "GET" && r.Method != "HEAD" {
		role = collaboration.EDITOR
	}
	return projectWithRole(r.Context(), db, owner(r), id, role, lock)
}

// signedRequest verifies the issuing session, then repeats the same live IPAC
// check as API requests. A valid signature alone never grants stale authority.
func (s *Server) signedRequest(r *http.Request, userID, sessionID, capability string) (*http.Request, error) {
	identity, err := s.authorization.SignedIdentity(r.Context(), userID, sessionID)
	if err != nil {
		return r, err
	}
	if err = s.authorization.Check(r.Context(), identity, capability); err != nil {
		return r, err
	}
	return httpapi.WithIdentity(r, identity), nil
}
