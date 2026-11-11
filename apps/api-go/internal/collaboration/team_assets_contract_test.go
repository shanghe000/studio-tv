package collaboration

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"studiotv.local/service/api/internal/httpapi"
)

const collaborationContractURL = "https://studio.local/contracts/collaboration-extension.json"

func teamAssetContract(t *testing.T) (map[string]any, *jsonschema.Compiler) {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("contract source location unavailable")
	}
	root := filepath.Join(filepath.Dir(file), "../../../../contracts")
	raw, e := os.ReadFile(filepath.Join(root, "collaboration-extension.json"))
	if e != nil {
		t.Fatal(e)
	}
	yaml, e := os.ReadFile(filepath.Join(root, "collaboration-extension.yaml"))
	if e != nil || !bytes.Equal(raw, yaml) {
		t.Fatal("JSON and YAML 1.2 source contracts differ")
	}
	var doc map[string]any
	if e = json.Unmarshal(raw, &doc); e != nil {
		t.Fatal(e)
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	if e = compiler.AddResource(collaborationContractURL, doc); e != nil {
		t.Fatal(e)
	}
	for name := range doc["components"].(map[string]any)["schemas"].(map[string]any) {
		if _, e = compiler.Compile(collaborationContractURL + "#/components/schemas/" + name); e != nil {
			t.Fatalf("schema %s: %v", name, e)
		}
	}
	return doc, compiler
}
func TestCollaborationContractMatchesAllRegisteredRoutes(t *testing.T) {
	doc, _ := teamAssetContract(t)
	router := chi.NewRouter()
	protected := 0
	protect := func(capability string, _ httpapi.Handler) http.HandlerFunc {
		if capability != "tv.access" {
			t.Fatal("route bypasses application capability")
		}
		protected++
		return func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) }
	}
	// Registering routes never connects this inert pool. Request dispatch is
	// blocked by protection, so this inventory check needs no DB or network.
	pool := &pgxpool.Pool{}
	if e := RegisterRoutes(router, pool, protect); e != nil {
		t.Fatal(e)
	}
	if e := RegisterAssetRoutes(router, pool, t.TempDir(), protect); e != nil {
		t.Fatal(e)
	}
	actual := map[string]bool{}
	if e := chi.Walk(router, func(method, path string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		actual[method+" "+path] = true
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	if len(actual) != 28 || protected != 28 {
		t.Fatalf("registered operations %d, protected %d; wanted original17+assets11", len(actual), protected)
	}
	documented := map[string]bool{}
	ids := map[string]bool{}
	for path, methods := range doc["paths"].(map[string]any) {
		for method, value := range methods.(map[string]any) {
			op := value.(map[string]any)
			key := strings.ToUpper(method) + " /api/v2/collaboration" + path
			documented[key] = true
			if !actual[key] {
				t.Fatalf("documented route not registered: %s", key)
			}
			if op["x-implementation-stage"] != "IMPLEMENTED" {
				t.Fatalf("implementation marker missing: %s", key)
			}
			id, ok := op["operationId"].(string)
			if !ok || id == "" || ids[id] {
				t.Fatalf("duplicate/missing operation ID: %s", key)
			}
			ids[id] = true
			if len(op["security"].([]any)) == 0 {
				t.Fatalf("authentication missing: %s", key)
			}
		}
	}
	for key := range actual {
		if !documented[key] {
			t.Fatalf("registered route missing from contract: %s", key)
		}
	}
	if len(documented) != len(actual) {
		t.Fatal("contract inventory differs from router")
	}
	assetOperations := map[string]bool{"listTeamAssetFolders": true, "createTeamAssetFolder": true, "renameTeamAssetFolder": true, "deleteTeamAssetFolder": true, "listTeamAssets": true, "publishTeamAsset": true, "getTeamAsset": true, "updateTeamAsset": true, "unpublishTeamAsset": true, "importTeamAsset": true, "importProjectAssets": true}
	for path, methods := range doc["paths"].(map[string]any) {
		for method, value := range methods.(map[string]any) {
			op := value.(map[string]any)
			if !assetOperations[op["operationId"].(string)] {
				continue
			}
			if op["x-response-envelope"] != "NONE" || op["x-capability"] != "tv.access" {
				t.Fatal("team asset DTO/capability drift", path)
			}
			parameters := op["parameters"].([]any)
			headers := map[string]bool{}
			for _, p := range parameters {
				parameter := p.(map[string]any)
				if reference, ok := parameter["$ref"].(string); ok {
					key := strings.TrimPrefix(reference, "#/components/parameters/")
					parameter = doc["components"].(map[string]any)["parameters"].(map[string]any)[key].(map[string]any)
				}
				if parameter["in"] == "header" && parameter["required"] == true {
					headers[parameter["name"].(string)] = true
				}
			}
			if method != "get" && !headers["Idempotency-Key"] {
				t.Fatal("write lacks required UUID idempotency", path, method)
			}
			if (method == "patch" || method == "delete") && !headers["If-Match"] {
				t.Fatal("mutation lacks required strong ETag", path, method)
			}
		}
	}
}

func TestTeamAssetContractRequestBoundaries(t *testing.T) {
	_, compiler := teamAssetContract(t)
	cases := []struct {
		schema, body string
		valid        bool
	}{
		{"TeamAssetPublish", `{"sourceAssetId":"asset"}`, true},
		{"TeamAssetPublish", `{"sourceNodeId":"library-node","sourceRevision":2,"folderId":null}`, true},
		{"TeamAssetPublish", `{"sourceAssetId":"asset","sourceNodeId":"node"}`, false},
		{"TeamAssetPublish", `{}`, false},
		{"TeamAssetPublish", `{"sourceAssetId":"asset","ownerId":"spoof"}`, false},
		{"TeamFolderPatch", `{"name":"rename"}`, true},
		{"TeamFolderPatch", `{"name":"rename","parentId":"other"}`, false},
		{"TeamEntryPatch", `{"folderId":null}`, true},
		{"TeamEntryPatch", `{"name":"rename"}`, true},
		{"TeamEntryPatch", `{"name":null}`, false},
		{"TeamEntryPatch", `{"content":{"nodeType":"spoof"}}`, false},
		{"ProjectAssetImport", `{"assetIds":["a","b"]}`, true},
		{"ProjectAssetImport", `{"assetIds":[]}`, false},
		{"ProjectAssetImport", `{"assetIds":["a","a"]}`, false},
		{"TeamAssetImport", `{"projectId":"project"}`, true},
		{"TeamAssetImport", `{"projectId":"project","ownerId":"spoof"}`, false},
	}
	for _, c := range cases {
		schema, e := compiler.Compile(collaborationContractURL + "#/components/schemas/" + c.schema)
		if e != nil {
			t.Fatal(e)
		}
		var value any
		if e = json.Unmarshal([]byte(c.body), &value); e != nil {
			t.Fatal(e)
		}
		valid := schema.Validate(value) == nil
		if valid != c.valid {
			t.Fatalf("%s request valid=%t wanted=%t: %s", c.schema, valid, c.valid, c.body)
		}
	}
}

func TestTeamAssetHTTPResponsesMatchContractRealPostgres(t *testing.T) {
	f := newTeamFixture(t)
	f.asset(t, "image", "a", "IMAGE", "image/png")
	doc, compiler := teamAssetContract(t)
	router := chi.NewRouter()
	router.Use(httpapi.RequestContext)
	protect := func(capability string, h httpapi.Handler) http.HandlerFunc {
		if capability != "tv.access" {
			t.Fatal("missing app capability")
		}
		return httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
			return h(w, httpapi.WithIdentity(r, httpapi.Identity{UserID: "a"}))
		})
	}
	if e := RegisterAssetRoutes(router, f.db, f.root, protect); e != nil {
		t.Fatal(e)
	}
	call := func(method, template, path, body, etag string, status int) (map[string]any, string) {
		t.Helper()
		request := httptest.NewRequest(method, "/api/v2/collaboration"+path, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", uuid.NewString())
		if etag != "" {
			request.Header.Set("If-Match", etag)
		}
		response := httptest.NewRecorder()
		router.ServeHTTP(response, request)
		if response.Code != status {
			t.Fatalf("%s %s status wanted%d got%d: %s", method, template, status, response.Code, response.Body.String())
		}
		op := doc["paths"].(map[string]any)[template].(map[string]any)[strings.ToLower(method)].(map[string]any)
		contract := op["responses"].(map[string]any)[strconv.Itoa(status)].(map[string]any)
		if status == 204 {
			if response.Body.Len() != 0 {
				t.Fatal("DELETE response was not empty")
			}
			if _, ok := contract["content"]; ok {
				t.Fatal("contract invented DELETE body")
			}
			return nil, ""
		}
		ref := contract["content"].(map[string]any)["application/json"].(map[string]any)["schema"].(map[string]any)["$ref"].(string)
		schema, e := compiler.Compile(collaborationContractURL + ref)
		if e != nil {
			t.Fatal(e)
		}
		var result map[string]any
		if e = json.Unmarshal(response.Body.Bytes(), &result); e != nil {
			t.Fatal(e)
		}
		if e = schema.Validate(result); e != nil {
			t.Fatalf("%s %s actual DTO: %v", method, template, e)
		}
		if _, ok := contract["headers"]; ok {
			if response.Header().Get("ETag") == "" {
				t.Fatal("promised strong ETag missing")
			}
		}
		return result, response.Header().Get("ETag")
	}
	foldersTemplate := "/teams/{teamId}/folders"
	folderTemplate := foldersTemplate + "/{folderId}"
	entriesTemplate := "/teams/{teamId}/assets"
	entryTemplate := entriesTemplate + "/{entryId}"
	call("GET", foldersTemplate, "/teams/team/folders", "", "", 200)
	folder, folderETag := call("POST", foldersTemplate, "/teams/team/folders", `{"name":"contract folder"}`, "", 201)
	folderPath := "/teams/team/folders/" + folder["id"].(string)
	_, folderETag = call("PATCH", folderTemplate, folderPath, `{"name":"renamed"}`, folderETag, 200)
	call("GET", entriesTemplate, "/teams/team/assets", "", "", 200)
	entry, entryETag := call("POST", entriesTemplate, "/teams/team/assets", `{"sourceAssetId":"image"}`, "", 201)
	entryPath := "/teams/team/assets/" + entry["id"].(string)
	call("GET", entryTemplate, entryPath, "", "", 200)
	_, entryETag = call("PATCH", entryTemplate, entryPath, `{"folderId":"`+folder["id"].(string)+`"}`, entryETag, 200)
	call("POST", entryTemplate+"/import", entryPath+"/import", `{"projectId":"project_a"}`, "", 201)
	call("POST", "/projects/{projectId}/assets/import", "/projects/project_a/assets/import", `{"assetIds":["image"]}`, "", 201)
	call("DELETE", entryTemplate, entryPath, "", entryETag, 204)
	call("DELETE", folderTemplate, folderPath, "", folderETag, 204)
}
