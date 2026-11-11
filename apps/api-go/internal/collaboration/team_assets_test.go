package collaboration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/database"
	"studiotv.local/service/api/internal/httpapi"
	library "studiotv.local/service/api/internal/modules/library/domain"
	"studiotv.local/service/api/internal/testdb"
)

func teamStatus(t *testing.T, err error, want int) {
	t.Helper()
	var e *httpapi.Error
	if !errors.As(err, &e) || e.Status != want {
		t.Fatalf("status wanted %d, got %v", want, err)
	}
}
func TestTeamContentRemappingAndPrivacy(t *testing.T) {
	raw := json.RawMessage(`{"id":"old","type":"rh-image","data":{"url":"rhtv-asset:image","nested":{"assetId":"model","prompt":"image","taskId":"private-task","accessToken":"private-token"},"status":"SUCCEEDED","__rhtv":{"grant":"private"}},"ownerId":"private-owner","unknown":"drop"}`)
	portable, e := portableTeamNode(raw)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(portable), "private") || strings.Contains(string(portable), "SUCCEEDED") {
		t.Fatal("runtime/private authority survived publication")
	}
	primary := "image"
	content := library.NodeContent{NodeType: "rh-image", NodeContent: portable, AssetIDs: []string{"image"}, ModelAssetIDs: []string{"model"}, PrimaryAssetID: &primary}
	remapped, e := remapTeamContent(content, map[string]string{"image": "newimage", "model": "newmodel"})
	if e != nil {
		t.Fatal(e)
	}
	if *remapped.PrimaryAssetID != "newimage" || remapped.AssetIDs[0] != "newimage" || remapped.ModelAssetIDs[0] != "newmodel" || !strings.Contains(string(remapped.NodeContent), "rhtv-asset:newimage") || !strings.Contains(string(remapped.NodeContent), `"assetId":"newmodel"`) || !strings.Contains(string(remapped.NodeContent), `"prompt":"image"`) {
		t.Fatal("reference remapping changed text or missed references")
	}
	if _, e = remapTeamContent(content, map[string]string{"image": "newimage"}); e == nil {
		t.Fatal("missing model mapping accepted")
	}
	if content.AssetIDs[0] != "image" || *content.PrimaryAssetID != "image" {
		t.Fatal("source content mutated")
	}
	var patch TeamAssetPatch
	if json.Unmarshal([]byte(`{"folderId":null}`), &patch) != nil || !patch.folderPresent || patch.FolderID != nil {
		t.Fatal("explicit root move lost")
	}
	if json.Unmarshal([]byte(`{"ownerId":"spoof"}`), &patch) == nil {
		t.Fatal("unknown field accepted")
	}
}

func TestTeamBlobCopyIndependentAndFailClosed(t *testing.T) {
	root := t.TempDir()
	data := []byte("immutable team fixture")
	sum := sha256.Sum256(data)
	source := sourceTeamAsset{TeamAssetDTO: TeamAssetDTO{ID: "source", ByteSize: int64(len(data)), ChecksumSHA256: hex.EncodeToString(sum[:])}}
	if e := os.WriteFile(filepath.Join(root, "source"), data, 0600); e != nil {
		t.Fatal(e)
	}
	created, e := materializeTeamCopy(root, source, "copy")
	if e != nil || !created {
		t.Fatal("real copy failed", e)
	}
	a, _ := os.Stat(filepath.Join(root, "source"))
	b, _ := os.Stat(filepath.Join(root, "copy"))
	if os.SameFile(a, b) {
		t.Fatal("project copy shares mutable inode")
	}
	if e = os.WriteFile(filepath.Join(root, "source"), []byte("source mutated"), 0600); e != nil {
		t.Fatal(e)
	}
	actual, _ := os.ReadFile(filepath.Join(root, "copy"))
	if string(actual) != string(data) {
		t.Fatal("source mutation changed project copy")
	}
	if _, e = materializeTeamCopy(root, source, "other"); e == nil {
		t.Fatal("tampered source copied")
	}
	if e = os.Remove(filepath.Join(root, "source")); e != nil {
		t.Fatal(e)
	}
	if e = os.Symlink(filepath.Join(root, "copy"), filepath.Join(root, "source")); e != nil {
		t.Fatal(e)
	}
	if _, e = materializeTeamCopy(root, source, "symlinkcopy"); e == nil {
		t.Fatal("symlink source accepted")
	}
	if _, e = os.Stat(filepath.Join(root, "symlinkcopy")); !os.IsNotExist(e) {
		t.Fatal("failed copy left file")
	}
}

type teamFixture struct {
	db   *pgxpool.Pool
	ctx  context.Context
	s    *TeamAssetService
	root string
}

func newTeamFixture(t *testing.T) *teamFixture {
	t.Helper()
	db := testdb.New(t).Open(t)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	t.Cleanup(cancel)
	if e := database.Migrate(ctx, db); e != nil {
		t.Fatal("isolated migration failed", e)
	}
	root := t.TempDir()
	s, e := NewTeamAssetService(db, root)
	if e != nil {
		t.Fatal(e)
	}
	f := &teamFixture{db, ctx, s, root}
	for _, id := range []string{"a", "b", "c", "d"} {
		f.exec(t, `INSERT INTO public.users(id,email,display_name) VALUES($1,$1||'@example.test',$1)`, id)
		f.exec(t, `INSERT INTO public.projects(id,owner_id,name) VALUES($1,$2,'isolated project')`, "project_"+id, id)
	}
	f.exec(t, `INSERT INTO collaboration.teams(id,owner_id,name) VALUES('team','a','isolated team'),('otherteam','d','isolated other')`)
	f.exec(t, `INSERT INTO collaboration.team_members(team_id,user_id,role,created_by) VALUES('team','b','EDITOR','a'),('team','c','VIEWER','a')`)
	f.exec(t, `INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('project_d','b','EDITOR','d'),('project_d','c','VIEWER','d')`)
	return f
}
func (f *teamFixture) exec(t *testing.T, q string, args ...any) {
	t.Helper()
	if _, e := f.db.Exec(f.ctx, q, args...); e != nil {
		t.Fatal("isolated fixture query failed", e)
	}
}
func (f *teamFixture) asset(t *testing.T, id, owner, kind, mime string) []byte {
	t.Helper()
	data := []byte("isolated bytes " + id)
	sum := sha256.Sum256(data)
	f.exec(t, `INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,storage_key) VALUES($1,$2,$3,$1,$4,$5,$6,$7,'READY',$1)`, id, owner, "project_"+owner, kind, mime, len(data), hex.EncodeToString(sum[:]))
	if e := os.WriteFile(filepath.Join(f.root, id), data, 0600); e != nil {
		t.Fatal(e)
	}
	return data
}

func TestTeamAssetsLifecycleRealPostgres(t *testing.T) {
	f := newTeamFixture(t)
	ctx := f.ctx
	image := f.asset(t, "image", "a", "IMAGE", "image/png")
	f.asset(t, "thumb", "a", "IMAGE", "image/png")
	f.asset(t, "model", "a", "FILE", "model/gltf-binary")
	f.asset(t, "personal", "b", "IMAGE", "image/png")
	primary, thumb := "image", "thumb"
	content := library.NodeContent{NodeType: "rh-image", NodeContent: json.RawMessage(`{"id":"private-node","type":"rh-image","data":{"url":"rhtv-asset:image","cover":"rhtv-asset:thumb","modelUri":"rhtv-asset:model","prompt":"explicitly shared input","taskId":"private-task","accessToken":"private-token"}}`), AssetIDs: []string{"image", "thumb"}, ModelAssetIDs: []string{"model"}, PrimaryAssetID: &primary}
	raw, _ := json.Marshal(content)
	f.exec(t, `INSERT INTO library.collections(owner_id) VALUES('a') ON CONFLICT DO NOTHING`)
	f.exec(t, `INSERT INTO library.nodes(id,owner_id,name,kind,category_code,content,thumbnail_asset_id) VALUES('librarynode','a','published node','IMAGE','USER_OTHER',$1,$2)`, raw, thumb)
	folder, e := f.s.CreateFolder(ctx, "a", "team", "Shared", nil, uuid.NewString())
	if e != nil {
		t.Fatal(e)
	}
	key := uuid.NewString()
	input := PublishTeamAsset{SourceNodeID: "librarynode", FolderID: &folder.ID}
	entry, e := f.s.Publish(ctx, "a", "team", input, key)
	if e != nil {
		t.Fatal(e)
	}
	if entry.Kind != "NODE" || len(entry.Assets) != 3 || strings.Contains(string(entry.Content.NodeContent), "private-task") || strings.Contains(string(entry.Content.NodeContent), "private-token") {
		t.Fatal("publication references/privacy failed")
	}
	replay, e := f.s.Publish(ctx, "a", "team", input, key)
	if e != nil || replay.ID != entry.ID {
		t.Fatal("publish receipt replay failed", e)
	}
	input.Name = "different"
	_, e = f.s.Publish(ctx, "a", "team", input, key)
	teamStatus(t, e, 409)
	if _, e = f.s.Entry(ctx, "c", "team", entry.ID); e != nil {
		t.Fatal("viewer read failed", e)
	}
	_, e = f.s.Entry(ctx, "d", "team", entry.ID)
	teamStatus(t, e, 404)
	_, e = f.s.Publish(ctx, "b", "team", PublishTeamAsset{SourceAssetID: "image"}, uuid.NewString())
	teamStatus(t, e, 404)
	_, e = f.s.Publish(ctx, "c", "team", PublishTeamAsset{SourceAssetID: "image"}, uuid.NewString())
	teamStatus(t, e, 403)
	name := "changed"
	_, e = f.s.ChangeEntry(ctx, "c", "team", entry.ID, 1, TeamAssetPatch{Name: &name}, false, uuid.NewString())
	teamStatus(t, e, 403)
	_, e = f.s.ChangeEntry(ctx, "b", "team", entry.ID, 999, TeamAssetPatch{Name: &name}, false, uuid.NewString())
	teamStatus(t, e, 412)
	_, e = f.s.ChangeFolder(ctx, "a", "team", folder.ID, folder.Revision, nil, true, uuid.NewString())
	teamStatus(t, e, 409)
	if e = RequireAssetGrant(ctx, f.db, "c", "image"); e != nil {
		t.Fatal("viewer asset grant failed", e)
	}
	if e = RequireAssetGrant(ctx, f.db, "c", "personal"); e == nil {
		t.Fatal("team grant leaked private asset")
	}
	pinned, e := TeamAssetPinned(ctx, f.db, "image")
	if e != nil || !pinned {
		t.Fatal("source not pinned", e)
	}
	importKey := uuid.NewString()
	imported, e := f.s.Import(ctx, "b", "team", entry.ID, "project_d", importKey)
	if e != nil {
		t.Fatal(e)
	}
	if len(imported.AssetIDMap) != 3 || imported.AssetIDMap["image"] == "image" || len(imported.Assets) != 3 || *imported.Entry.Content.PrimaryAssetID != imported.AssetIDMap["image"] || *imported.Entry.ThumbnailAssetID != imported.AssetIDMap["thumb"] {
		t.Fatal("import missed media/model/thumbnail mapping")
	}
	if strings.Contains(string(imported.Node), "private-node") || !strings.Contains(string(imported.Node), "rhtv-asset:"+imported.AssetIDMap["image"]) {
		t.Fatal("native node not remapped")
	}
	for _, a := range imported.Assets {
		var owner, createdBy, pid string
		if e = f.db.QueryRow(ctx, `SELECT owner_id,created_by,project_id FROM public.assets WHERE id=$1`, a.ID).Scan(&owner, &createdBy, &pid); e != nil || owner != "d" || createdBy != "b" || pid != "project_d" {
			t.Fatal("actor/storage owner confused", e)
		}
	}
	bytes, e := os.ReadFile(filepath.Join(f.root, imported.AssetIDMap["image"]))
	if e != nil || string(bytes) != string(image) {
		t.Fatal("project copy is not actual bytes", e)
	}
	repeated, e := f.s.Import(ctx, "b", "team", entry.ID, "project_d", importKey)
	if e != nil {
		t.Fatal(e)
	}
	one, _ := json.Marshal(imported)
	two, _ := json.Marshal(repeated)
	if string(one) != string(two) {
		t.Fatal("import replay changed result")
	}
	_, e = f.s.Import(ctx, "c", "team", entry.ID, "project_d", uuid.NewString())
	teamStatus(t, e, 403)
	if _, e = f.s.Import(ctx, "c", "team", entry.ID, "project_c", uuid.NewString()); e != nil {
		t.Fatal("team viewer cannot import into owned project", e)
	}
	personal, e := CopyAssetsToProject(ctx, f.db, f.root, "b", "project_d", []string{"personal"}, uuid.NewString())
	if e != nil || personal.AssetIDMap["personal"] == "personal" {
		t.Fatal("personal asset not copied for shared target", e)
	}
	identity, e := CopyAssetsToProject(ctx, f.db, f.root, "b", "project_d", []string{personal.AssetIDMap["personal"]}, uuid.NewString())
	if e != nil || identity.AssetIDMap[personal.AssetIDMap["personal"]] != personal.AssetIDMap["personal"] {
		t.Fatal("existing project asset duplicated", e)
	}
	_, e = CopyAssetsToProject(ctx, f.db, f.root, "b", "project_d", []string{"missing"}, uuid.NewString())
	teamStatus(t, e, 404)
	f.exec(t, `UPDATE public.projects SET deleted_at=now() WHERE id='project_a'`)
	if e = RequireAssetGrant(ctx, f.db, "c", "image"); e != nil {
		t.Fatal("private project soft deletion retracted active publication", e)
	}
	if _, e = f.s.Import(ctx, "b", "team", entry.ID, "project_d", uuid.NewString()); e != nil {
		t.Fatal("pinned real asset after source project deletion unavailable", e)
	}
	f.exec(t, `DELETE FROM collaboration.team_members WHERE team_id='team' AND user_id='b'`)
	if e = RequireAssetGrant(ctx, f.db, "b", "image"); e == nil {
		t.Fatal("revoked member kept source media grant")
	}
	_, e = f.s.Import(ctx, "b", "team", entry.ID, "project_d", importKey)
	teamStatus(t, e, 404)
	if e = AuthorizeProjectAssets(ctx, f.db, "b", "project_d", []string{imported.AssetIDMap["image"]}); e != nil {
		t.Fatal("team revoke improperly revoked independent project copy", e)
	}
	if _, e = f.s.ChangeEntry(ctx, "a", "team", entry.ID, entry.Revision, TeamAssetPatch{}, true, uuid.NewString()); e != nil {
		t.Fatal(e)
	}
	pinned, e = TeamAssetPinned(ctx, f.db, "image")
	if e != nil || pinned {
		t.Fatal("unpublished asset remains pinned", e)
	}
	if e = RequireAssetGrant(ctx, f.db, "c", "image"); e == nil {
		t.Fatal("unpublished entry still grants reads")
	}
	if _, e = f.s.ChangeFolder(ctx, "a", "team", folder.ID, folder.Revision, nil, true, uuid.NewString()); e != nil {
		t.Fatal(e)
	}
}

func TestTeamAssetsConcurrentReceiptsAndHTTPBoundariesRealPostgres(t *testing.T) {
	f := newTeamFixture(t)
	f.asset(t, "image", "a", "IMAGE", "image/png")
	key := uuid.NewString()
	var wg sync.WaitGroup
	ids := make(chan string, 6)
	errs := make(chan error, 6)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			entry, e := f.s.Publish(f.ctx, "a", "team", PublishTeamAsset{SourceAssetID: "image"}, key)
			if e != nil {
				errs <- e
			} else {
				ids <- entry.ID
			}
		}()
	}
	wg.Wait()
	close(ids)
	close(errs)
	for e := range errs {
		t.Fatal(e)
	}
	id := ""
	for got := range ids {
		if id != "" && id != got {
			t.Fatal("concurrent publish created duplicate entries")
		}
		id = got
	}
	router := chi.NewRouter()
	protect := func(_ string, h httpapi.Handler) http.HandlerFunc {
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return h(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: "a"}))
		})
	}
	if e := RegisterAssetRoutes(router, f.db, f.root, protect); e != nil {
		t.Fatal(e)
	}
	cases := []struct {
		method, path, body, etag string
		status                   int
	}{
		{"GET", "/api/v2/collaboration/teams/team/assets?ownerId=d", "", "", 400},
		{"PATCH", "/api/v2/collaboration/teams/team/assets/" + id, `{"name":"changed"}`, "", 428},
		{"PATCH", "/api/v2/collaboration/teams/team/assets/" + id, `{"ownerId":"d"}`, `"1"`, 400},
		{"PATCH", "/api/v2/collaboration/teams/team/assets/" + id, `{"name":"changed"}`, `W/"1"`, 400},
		{"POST", "/api/v2/collaboration/teams/team/assets", `{"sourceAssetId":"image"}`, "", 400},
	}
	for _, c := range cases {
		request := httptest.NewRequest(c.method, c.path, strings.NewReader(c.body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("If-Match", c.etag)
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != c.status {
			t.Fatalf("HTTP %s expected %d got %d", c.method, c.status, response.Code)
		}
	}
}

func TestTeamTextImportMutationReceiptsAndRevocationLockRealPostgres(t *testing.T) {
	f := newTeamFixture(t)
	f.exec(t, `INSERT INTO library.collections(owner_id) VALUES('a') ON CONFLICT DO NOTHING`)
	content := library.NodeContent{NodeType: "rh-text", NodeContent: json.RawMessage(`{"id":"text","type":"rh-text","data":{"text":"explicitly published text","params":{"seed":9007199254740993}}}`), AssetIDs: []string{}, ModelAssetIDs: []string{}}
	raw, _ := json.Marshal(content)
	f.exec(t, `INSERT INTO library.nodes(id,owner_id,name,kind,category_code,content) VALUES('textnode','a','text source','TEXT','USER_OTHER',$1)`, raw)
	entry, e := f.s.Publish(f.ctx, "a", "team", PublishTeamAsset{SourceNodeID: "textnode"}, uuid.NewString())
	if e != nil {
		t.Fatal(e)
	}
	key := uuid.NewString()
	result, e := f.s.Import(f.ctx, "b", "team", entry.ID, "project_d", key)
	if e != nil {
		t.Fatal(e)
	}
	if len(result.Assets) != 0 || len(result.AssetIDMap) != 0 || !strings.Contains(string(result.Node), "9007199254740993") || !strings.Contains(string(result.Node), "explicitly published text") {
		t.Fatal("text-only import lost content or numeric precision")
	}
	repeated, e := f.s.Import(f.ctx, "b", "team", entry.ID, "project_d", key)
	if e != nil {
		t.Fatal(e)
	}
	first, _ := json.Marshal(result)
	second, _ := json.Marshal(repeated)
	if string(first) != string(second) {
		t.Fatal("text import receipt changed")
	}
	name := "renamed"
	mutationKey := uuid.NewString()
	changed, e := f.s.ChangeEntry(f.ctx, "b", "team", entry.ID, entry.Revision, TeamAssetPatch{Name: &name}, false, mutationKey)
	if e != nil {
		t.Fatal(e)
	}
	replay, e := f.s.ChangeEntry(f.ctx, "b", "team", entry.ID, entry.Revision, TeamAssetPatch{Name: &name}, false, mutationKey)
	if e != nil || changed.Revision != replay.Revision {
		t.Fatal("stale If-Match did not replay original mutation", e)
	}
	name = "different"
	_, e = f.s.ChangeEntry(f.ctx, "b", "team", entry.ID, entry.Revision, TeamAssetPatch{Name: &name}, false, mutationKey)
	teamStatus(t, e, 409)
	folderKey := uuid.NewString()
	folder, e := f.s.CreateFolder(f.ctx, "a", "team", "root", nil, folderKey)
	if e != nil {
		t.Fatal(e)
	}
	again, e := f.s.CreateFolder(f.ctx, "a", "team", "root", nil, folderKey)
	if e != nil || again.ID != folder.ID {
		t.Fatal("folder create duplicate", e)
	}
	other, e := f.s.CreateFolder(f.ctx, "d", "otherteam", "foreign", nil, uuid.NewString())
	if e != nil {
		t.Fatal(e)
	}
	_, e = f.s.ChangeEntry(f.ctx, "a", "team", entry.ID, changed.Revision, TeamAssetPatch{FolderID: &other.ID, folderPresent: true}, false, uuid.NewString())
	teamStatus(t, e, 404)
	name = "folder rename"
	folderMutation := uuid.NewString()
	renamed, e := f.s.ChangeFolder(f.ctx, "a", "team", folder.ID, folder.Revision, &name, false, folderMutation)
	if e != nil {
		t.Fatal(e)
	}
	renamedAgain, e := f.s.ChangeFolder(f.ctx, "a", "team", folder.ID, folder.Revision, &name, false, folderMutation)
	if e != nil || renamedAgain.Revision != renamed.Revision {
		t.Fatal("folder mutation receipt failed", e)
	}
	// Revocation owns the source TEAM lock before a copy can authorize it. The
	// waiting import must observe the committed removal, never its old membership.
	tx, e := f.db.Begin(f.ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(context.Background())
	var locked string
	if e = tx.QueryRow(f.ctx, `SELECT id FROM collaboration.teams WHERE id='team' FOR UPDATE`).Scan(&locked); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() { _, e := f.s.Import(f.ctx, "b", "team", entry.ID, "project_d", uuid.NewString()); done <- e }()
	select {
	case e := <-done:
		t.Fatalf("import did not wait for revocation lock: %v", e)
	case <-time.After(100 * time.Millisecond):
	}
	if _, e = tx.Exec(f.ctx, `DELETE FROM collaboration.team_members WHERE team_id='team' AND user_id='b'`); e != nil {
		t.Fatal(e)
	}
	if e = tx.Commit(f.ctx); e != nil {
		t.Fatal(e)
	}
	select {
	case e := <-done:
		teamStatus(t, e, 404)
	case <-time.After(3 * time.Second):
		t.Fatal("revoked import failed to finish")
	}
	// A historical receipt never bypasses current local membership.
	_, e = f.s.ChangeEntry(f.ctx, "b", "team", entry.ID, entry.Revision, TeamAssetPatch{Name: &name}, false, mutationKey)
	teamStatus(t, e, 404)
}

func TestTeamGrantForUseSerializesRevocationRealPostgres(t *testing.T) {
	f := newTeamFixture(t)
	f.asset(t, "image", "a", "IMAGE", "image/png")
	if _, e := f.s.Publish(f.ctx, "a", "team", PublishTeamAsset{SourceAssetID: "image"}, uuid.NewString()); e != nil {
		t.Fatal(e)
	}
	tx, e := f.db.Begin(f.ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(context.Background())
	if e = RequireAssetGrantForUse(f.ctx, tx, "b", "image"); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() {
		other, e := f.db.Begin(f.ctx)
		if e != nil {
			done <- e
			return
		}
		defer other.Rollback(context.Background())
		var id string
		e = other.QueryRow(f.ctx, `SELECT id FROM collaboration.teams WHERE id='team' FOR UPDATE`).Scan(&id)
		if e == nil {
			_, e = other.Exec(f.ctx, `DELETE FROM collaboration.team_members WHERE team_id='team' AND user_id='b'`)
		}
		if e == nil {
			e = other.Commit(f.ctx)
		}
		done <- e
	}()
	select {
	case e := <-done:
		t.Fatalf("source revocation bypassed active use lock: %v", e)
	case <-time.After(100 * time.Millisecond):
	}
	if e = tx.Commit(f.ctx); e != nil {
		t.Fatal(e)
	}
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("revoke blocked after use committed")
	}
	fresh, e := f.db.Begin(f.ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer fresh.Rollback(context.Background())
	teamStatus(t, RequireAssetGrantForUse(f.ctx, fresh, "b", "image"), 404)
}
