package core

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"studiotv.local/service/api/internal/authorization"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	longformHTTP "studiotv.local/service/api/internal/modules/longform/adapters/http"
	longform "studiotv.local/service/api/internal/modules/longform/application"
	"studiotv.local/service/api/internal/testdb"
)

type archivedContentRepository struct {
	longform.Repository
	binding longform.Binding
}

func (r archivedContentRepository) Get(_ context.Context, actor, id string, _ bool) (longform.Binding, error) {
	if actor != r.binding.ActorID || id != r.binding.ID {
		return longform.Binding{}, httpapi.Fail(404, "LONGFORM_NOT_FOUND", "fixture not accessible")
	}
	return r.binding, nil
}

// Exercise actual HTTPS requests through the existing signed asset reader,
// including its permission checks and byte ranges. No model/GPU is used.
func TestPostgresLongformArchiveStreamsSignedAssetWithoutRedirectAndPreservesRange(t *testing.T) {
	db := testdb.New(t).Open(t)
	ctx := context.Background()
	if err := database.Migrate(ctx, db); err != nil {
		t.Fatal(err)
	}
	cfg := testConfig(t)
	cfg.PublicBaseURL = "http://192.0.2.10:18880"
	content := []byte("\x00\x00\x00\x18ftypisom00000000longform-content-fixture")
	sum := sha256.Sum256(content)
	if _, err := db.Exec(ctx, `INSERT INTO users(id,email,password_hash,display_name) VALUES('usr_a','longform-content@example.test','','A');
	 INSERT INTO projects(id,owner_id,name) VALUES('prj_content','usr_a','Longform content fixture');`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `INSERT INTO assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,storage_key)
	 VALUES('ast_content','usr_a','prj_content','longform.mp4','VIDEO','video/mp4',$1,$2,'READY','ast_content')`, len(content), hex.EncodeToString(sum[:])); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg.StorageRoot, "ast_content"), content, 0600); err != nil {
		t.Fatal(err)
	}
	runtime, sessions := &integrationRuntime{}, &integrationSessions{}
	authorizer := authorization.New(runtime, "cli_test", sessions)
	auth := httpapi.AuthFunc(func(_ context.Context, r *http.Request) (httpapi.Identity, error) {
		if r.Header.Get("Authorization") == "Bearer fixture-owner" {
			return integrationPrincipal("usr_a"), nil
		}
		return httpapi.Identity{}, httpapi.Fail(401, "UNAUTHENTICATED", "fixture identity unavailable")
	})
	resources, err := PrepareResources(cfg)
	if err != nil {
		t.Fatal(err)
	}
	router, err := NewWithAuthorization(cfg, db, auth, authorizer, resources)
	if err != nil {
		t.Fatal(err)
	}
	assets, err := NewProductAssetStore(cfg, db)
	if err != nil {
		t.Fatal(err)
	}
	const projectID = "8d9be37e-2a83-4bd9-88d4-16037f78656c"
	const artifactID = "242ba26c-90c5-4f29-b1e2-38150cc629c5"
	repo := archivedContentRepository{binding: longform.Binding{ID: projectID, ActorID: "usr_a", Snapshot: json.RawMessage(`{"compositions":[{"artifactId":"` + artifactID + `","assetId":"ast_content"}]}`)}}
	// Archived playback must remain available while the native gateway is offline.
	service := longform.New(repo, nil, assets, false)
	if err := longformHTTP.RegisterRoutes(router, service, func(scope string, h httpapi.Handler) http.HandlerFunc {
		return httpapi.RequireAuth(auth, func(w http.ResponseWriter, r *http.Request) error {
			if err := authorizer.Check(r.Context(), httpapi.IdentityFrom(r), scope); err != nil {
				return err
			}
			return h(w, r)
		})
	}, resources.ServeSignedAsset); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(router)
	defer server.Close()
	path := "/api/v2/longform/projects/" + projectID + "/artifacts/" + artifactID + "/content"
	noRedirect := server.Client()
	noRedirect.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	request := func(client *http.Client, target, bearer, rangeHeader string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, target, nil)
		if err != nil {
			t.Fatal(err)
		}
		if bearer != "" {
			req.Header.Set("Authorization", bearer)
		}
		if rangeHeader != "" {
			req.Header.Set("Range", rangeHeader)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal("archive HTTP request failed")
		}
		return res
	}
	response := request(noRedirect, server.URL+path, "", "")
	response.Body.Close()
	if response.StatusCode != 401 || response.Header.Get("Location") != "" {
		t.Fatal("anonymous download exposed a redirect")
	}
	for _, tc := range []struct {
		rangeHeader  string
		status       int
		body         []byte
		contentRange string
	}{{"", 200, content, ""}, {"bytes=4-11", 206, content[4:12], "bytes 4-11/44"}} {
		response = request(noRedirect, server.URL+path, "Bearer fixture-owner", tc.rangeHeader)
		body, err := io.ReadAll(response.Body)
		response.Body.Close()
		if err != nil || response.StatusCode != tc.status || !bytes.Equal(body, tc.body) || response.Header.Get("Content-Type") != "video/mp4" || response.Header.Get("Content-Range") != tc.contentRange || response.Header.Get("Location") != "" {
			t.Fatal("archive did not return actual asset bytes/range without redirect", response.StatusCode, len(body), response.Header.Get("Content-Range"))
		}
	}
	// Internal dispatch does not remove session-bound storage authorization.
	sessions.revoked.Store(true)
	response = request(noRedirect, server.URL+path, "Bearer fixture-owner", "bytes=4-11")
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal("revoked asset session remained readable", response.StatusCode)
	}
}
