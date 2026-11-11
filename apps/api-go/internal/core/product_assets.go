package core

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/httpapi"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	media "studiotv.local/service/api/internal/modules/media/application"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
	resources "studiotv.local/service/api/internal/modules/resources/application"
	"studiotv.local/service/api/internal/principal"
	"studiotv.local/service/api/internal/security"
)

type ProductAssetStore struct {
	cfg  config.Config
	pool *pgxpool.Pool
}

func NewProductAssetStore(cfg config.Config, pool *pgxpool.Pool) (*ProductAssetStore, error) {
	if pool == nil || cfg.MaxUploadBytes < 1 || cfg.StorageRoot == "" || !filepath.IsAbs(cfg.StorageRoot) {
		return nil, errors.New("product asset storage configuration invalid")
	}
	if err := os.MkdirAll(cfg.StorageRoot, 0750); err != nil {
		return nil, err
	}
	return &ProductAssetStore{cfg, pool}, nil
}

// ImportLongform keeps the ordinary upload/invocation ceilings unchanged while
// allowing the explicitly bounded one-GiB longform product artifact contract.
func (s *ProductAssetStore) ImportLongform(ctx context.Context, owner, projectID, logicalID string, art gateway.Artifact, body []byte) (execution.Asset, error) {
	clone := *s
	clone.cfg.MaxUploadBytes = 1 << 30
	return clone.Import(ctx, owner, projectID, logicalID, art, body)
}

func productAssetID(logical string) string {
	digest := sha256.Sum256([]byte(logical))
	return "ast_" + hex.EncodeToString(digest[:])[:48]
}
func (s *ProductAssetStore) Import(ctx context.Context, owner, projectID, logicalID string, art gateway.Artifact, body []byte) (execution.Asset, error) {
	if requireID(owner) != nil || requireID(projectID) != nil || logicalID == "" || len(logicalID) > 1000 || len(body) < 1 || int64(len(body)) > s.cfg.MaxUploadBytes || int64(len(body)) != art.SizeBytes {
		return execution.Asset{}, httpapi.Fail(422, "ASSET_IMPORT_INVALID", "素材数据或归属无效。")
	}
	digest := sha256.Sum256(body)
	checksum := hex.EncodeToString(digest[:])
	if checksum != art.SHA256 {
		return execution.Asset{}, httpapi.Fail(422, "ASSET_IMPORT_CHECKSUM_MISMATCH", "素材文件校验失败。")
	}
	typ, params, err := mime.ParseMediaType(art.MediaType)
	if err != nil || len(params) != 0 {
		return execution.Asset{}, httpapi.Fail(422, "MIME_UNSUPPORTED", "文件类型无效。")
	}
	kind := mimeKinds[typ]
	if kind == "" {
		kind = "FILE"
	}
	if art.Kind != nil && *art.Kind != kind {
		return execution.Asset{}, httpapi.Fail(422, "MEDIA_KIND_MISMATCH", "产物类型不匹配。")
	}
	if kind == "FILE" {
		if err = validateProductFile(typ, body); err != nil {
			return execution.Asset{}, err
		}
	}
	id := productAssetID(logicalID)
	temp, err := os.CreateTemp(s.cfg.StorageRoot, ".product-import-")
	if err != nil {
		return execution.Asset{}, err
	}
	name := temp.Name()
	defer os.Remove(name)
	defer temp.Close()
	if _, err = temp.Write(body); err != nil {
		return execution.Asset{}, err
	}
	if err = temp.Sync(); err != nil {
		return execution.Asset{}, err
	}
	if err = temp.Close(); err != nil {
		return execution.Asset{}, err
	}
	var width, height *int
	var duration *float64
	if kind != "FILE" {
		server := &Server{cfg: s.cfg}
		width, height, duration, err = server.inspectMedia(ctx, name, typ, kind)
		if err != nil {
			return execution.Asset{}, err
		}
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return execution.Asset{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, id); err != nil {
		return execution.Asset{}, err
	}
	actor := principal.Actor(ctx, owner)
	var private bool
	if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM public.projects WHERE id=$1 AND owner_id=$2 AND internal_kind IS NOT NULL AND deleted_at IS NULL)`, projectID, actor).Scan(&private); err != nil {
		return execution.Asset{}, err
	}
	if private {
		if err = tx.QueryRow(ctx, `SELECT owner_id FROM public.projects WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL FOR UPDATE`, projectID, actor).Scan(&owner); err != nil {
			return execution.Asset{}, err
		}
	} else {
		scope, e := collaboration.RequireProject(ctx, tx, actor, projectID, "EDITOR", true)
		if e != nil {
			return execution.Asset{}, e
		}
		owner = scope.StorageOwnerID
	}
	var a Asset
	a, err = scanAsset(tx.QueryRow(ctx, "SELECT "+assetColumns+" FROM public.assets WHERE id=$1 FOR UPDATE", id))
	if err == nil {
		if a.OwnerID != owner || a.ProjectID != projectID || a.State != "READY" || a.Checksum != checksum || a.ByteSize != art.SizeBytes || a.MimeType != typ || a.Kind != kind {
			return execution.Asset{}, httpapi.Fail(409, "ASSET_IMPORT_CONFLICT", "素材导入记录冲突。")
		}
		if err = verifyStoredAsset(s.cfg.StorageRoot, a); err != nil {
			return execution.Asset{}, err
		}
		var previous []byte
		if err = tx.QueryRow(ctx, `SELECT provenance FROM public.assets WHERE id=$1`, id).Scan(&previous); err != nil {
			return execution.Asset{}, err
		}
		var recorded struct {
			Ref      string `json:"artifactRef"`
			TestMode bool   `json:"testMode"`
		}
		if json.Unmarshal(previous, &recorded) != nil || recorded.Ref != art.Ref || recorded.TestMode != art.TestMode {
			return execution.Asset{}, httpapi.Fail(409, "ASSET_IMPORT_CONFLICT", "素材导入来源冲突。")
		}
		if err = tx.Commit(ctx); err != nil {
			return execution.Asset{}, err
		}
		return executionAsset(a), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return execution.Asset{}, err
	}
	provenance, _ := json.Marshal(map[string]any{"testMode": art.TestMode, "fixtureLabel": art.FixtureLabel, "logicalId": logicalID, "artifactRef": art.Ref, "createdBy": actor})
	filename := "output" + productExtension(typ)
	a, err = scanAsset(tx.QueryRow(ctx, "INSERT INTO public.assets(id,owner_id,project_id,file_name,kind,mime_type,byte_size,checksum_sha256,state,width,height,duration_seconds,storage_key,provenance,created_by)VALUES($1,$2,$3,$4,$5,$6,$7,$8,'READY',$9,$10,$11,$1,$12,$13) RETURNING "+assetColumns, id, owner, projectID, filename, kind, typ, art.SizeBytes, checksum, width, height, duration, provenance, actor))
	if err != nil {
		return execution.Asset{}, err
	}
	if err = os.Chmod(name, 0440); err != nil {
		return execution.Asset{}, err
	}
	destination := filepath.Join(s.cfg.StorageRoot, id)
	// Link creates a new exact-owned immutable object without replacing an
	// unrelated existing path. On transaction failure remove only our own link.
	if err = os.Link(name, destination); err != nil {
		return execution.Asset{}, httpapi.Retry(503, "ASSET_STORAGE_CONFLICT", "素材存储暂不可用。")
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(destination)
		}
	}()
	if err = tx.Commit(ctx); err != nil {
		return execution.Asset{}, err
	}
	committed = true
	return executionAsset(a), nil
}
func executionAsset(a Asset) execution.Asset {
	var durationMs *int64
	if a.Duration != nil {
		value := int64(math.Round(*a.Duration * 1000))
		durationMs = &value
	}
	return execution.Asset{ID: a.ID, Kind: a.Kind, MimeType: a.MimeType, Version: "sha256:" + a.Checksum, SHA256: a.Checksum, Width: a.Width, Height: a.Height, DurationMs: durationMs}
}
func verifyStoredAsset(root string, a Asset) error {
	path := filepath.Join(root, a.ID)
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != a.ByteSize {
		return httpapi.Retry(503, "ASSET_STORAGE_UNAVAILABLE", "素材文件暂不可用。")
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != a.Checksum {
		return httpapi.Retry(503, "ASSET_STORAGE_INTEGRITY_FAILED", "素材文件校验失败。")
	}
	return nil
}
func (s *ProductAssetStore) Read(ctx context.Context, uid string, ids []string) ([]media.InputAsset, error) {
	uid = principal.Actor(ctx, uid)
	items := []media.InputAsset{}
	if len(ids) < 1 || len(ids) > 32 {
		return nil, httpapi.Fail(400, "VALIDATION_FAILED", "输入素材数量无效。")
	}
	for _, id := range ids {
		if requireID(id) != nil {
			return nil, httpapi.Fail(400, "VALIDATION_FAILED", "素材标识无效。")
		}
		a, err := accessibleAsset(ctx, s.pool, uid, id, false)
		if err != nil {
			return nil, err
		}
		// accessibleAsset already checks the actual caller project/team grant.
		if a.State != "READY" {
			return nil, httpapi.Fail(409, "ASSET_NOT_READY", "素材尚未就绪。")
		}
		if err = verifyStoredAsset(s.cfg.StorageRoot, a); err != nil {
			return nil, err
		}
		var raw []byte
		if err = s.pool.QueryRow(ctx, `SELECT provenance FROM assets WHERE id=$1`, id).Scan(&raw); err != nil {
			return nil, err
		}
		var marker struct {
			TestMode     bool   `json:"testMode"`
			FixtureLabel string `json:"fixtureLabel"`
		}
		if json.Unmarshal(raw, &marker) != nil {
			return nil, httpapi.Fail(503, "ASSET_PROVENANCE_INVALID", "素材来源记录无效。")
		}
		items = append(items, media.InputAsset{Asset: executionAsset(a), Path: filepath.Join(s.cfg.StorageRoot, a.ID), ByteSize: a.ByteSize, TestMode: marker.TestMode, FixtureLabel: marker.FixtureLabel})
	}
	return items, nil
}

func (s *ProductAssetStore) URL(ctx context.Context, uid, session, id string) (string, error) {
	uid = principal.Actor(ctx, uid)
	if session == "" {
		return "", httpapi.Fail(401, "UNAUTHENTICATED", "登录已失效。")
	}
	if _, err := s.Read(ctx, uid, []string{id}); err != nil {
		return "", err
	}
	token, err := security.New(s.cfg).Sign(map[string]any{"sub": uid, "aid": id, "sid": session}, "asset-read", 15*time.Minute)
	if err != nil {
		return "", err
	}
	return s.cfg.PublicBaseURL + "/storage/assets/" + id + "?token=" + url.QueryEscape(token), nil
}
func productExtension(typ string) string {
	switch typ {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "video/mp4":
		return ".mp4"
	case "video/webm":
		return ".webm"
	case "video/quicktime":
		return ".mov"
	case "audio/wav":
		return ".wav"
	case "audio/mpeg":
		return ".mp3"
	case "audio/ogg":
		return ".ogg"
	case "audio/mp4":
		return ".m4a"
	case "model/gltf-binary":
		return ".glb"
	case "model/gltf+json":
		return ".gltf"
	case "model/obj":
		return ".obj"
	case "application/x-fbx":
		return ".fbx"
	case "application/x-ply":
		return ".ply"
	case "application/x-spz":
		return ".spz"
	case "application/x-splat":
		return ".splat"
	case "text/markdown":
		return ".md"
	}
	return ".bin"
}
func validateProductFile(typ string, body []byte) error {
	bad := func() error { return httpapi.Fail(422, "FILE_INVALID", "文件内容与声明格式不一致。") }
	switch typ {
	case "model/gltf-binary":
		if len(body) < 20 || string(body[:4]) != "glTF" || binary.LittleEndian.Uint32(body[4:8]) != 2 || int(binary.LittleEndian.Uint32(body[8:12])) != len(body) {
			return bad()
		}
		offset := 12
		jsonFound := false
		for offset < len(body) {
			if offset+8 > len(body) {
				return bad()
			}
			size := int(binary.LittleEndian.Uint32(body[offset : offset+4]))
			kind := binary.LittleEndian.Uint32(body[offset+4 : offset+8])
			offset += 8
			if size < 0 || size%4 != 0 || offset+size > len(body) {
				return bad()
			}
			if !jsonFound {
				if kind != 0x4e4f534a || validateGLTF(body[offset:offset+size]) != nil {
					return bad()
				}
				jsonFound = true
			}
			offset += size
		}
		if !jsonFound {
			return bad()
		}
	case "model/gltf+json":
		if validateGLTF(body) != nil {
			return bad()
		}
	case "model/obj":
		return validateOBJ(body)
	case "application/x-fbx":
		return validateFBX(body)
	case "text/markdown":
		if !utf8.Valid(body) || bytes.IndexByte(body, 0) >= 0 {
			return bad()
		}
	case "application/x-ply":
		return validatePLY(body)

	case "application/x-spz":
		return validateSPZ(body)

	case "application/x-splat":
		if len(body)%32 != 0 || len(body) == 0 {
			return bad()
		}
		for i := 0; i < len(body); i += 32 {
			for j := 0; j < 24; j += 4 {
				v := math.Float32frombits(binary.LittleEndian.Uint32(body[i+j : i+j+4]))
				if math.IsNaN(float64(v)) || math.IsInf(float64(v), 0) || (j >= 12 && v < 0) {
					return bad()
				}
			}
		}
	default:
		return httpapi.Fail(422, "MIME_UNSUPPORTED", "文件格式未启用。")
	}
	return nil
}
func validateGLTF(body []byte) error {
	var doc map[string]json.RawMessage
	if json.Unmarshal(body, &doc) != nil || doc == nil {
		return errors.New("invalid glTF")
	}
	var asset struct {
		Version string `json:"version"`
	}
	if json.Unmarshal(doc["asset"], &asset) != nil || asset.Version != "2.0" {
		return errors.New("unsupported glTF")
	}
	for _, name := range []string{"buffers", "images"} {
		if raw := doc[name]; raw != nil {
			var entries []struct {
				URI string `json:"uri"`
			}
			if json.Unmarshal(raw, &entries) != nil {
				return errors.New("invalid glTF refs")
			}
			for _, entry := range entries {
				if entry.URI != "" && !strings.HasPrefix(entry.URI, "data:") {
					return errors.New("external glTF dependency unsupported")
				}
			}
		}
	}
	return nil
}

func modelFileInvalid() error {
	return httpapi.Fail(422, "FILE_INVALID", "3D 文件结构或数据无效。")
}
func finiteModelNumber(value string) bool {
	n, e := strconv.ParseFloat(value, 64)
	return e == nil && !math.IsNaN(n) && !math.IsInf(n, 0)
}
func validateOBJ(body []byte) error {
	if len(body) < 1 || len(body) > 32<<20 || !utf8.Valid(body) || bytes.IndexByte(body, 0) >= 0 {
		return modelFileInvalid()
	}
	counts := [3]int{}
	faces, lines := 0, 0
	index := func(raw string, count int) bool {
		n, e := strconv.Atoi(raw)
		return e == nil && n != 0 && n <= count && n >= -count
	}
	scanner := bufio.NewScanner(bytes.NewReader(body))
	scanner.Buffer(make([]byte, 4096), 65537)
	for scanner.Scan() {
		raw := scanner.Text()
		lines++
		if lines > 2_000_000 || len(raw) > 65536 {
			return modelFileInvalid()
		}
		raw, _, _ = strings.Cut(raw, "#")
		parts := strings.Fields(raw)
		if len(parts) == 0 {
			continue
		}
		switch parts[0] {
		case "v", "vt", "vn":
			kind := 0
			minN, maxN := 3, 7
			if parts[0] == "vt" {
				kind, minN, maxN = 1, 1, 3
			}
			if parts[0] == "vn" {
				kind, minN, maxN = 2, 3, 3
			}
			n := len(parts) - 1
			if n < minN || n > maxN || parts[0] == "v" && n == 5 {
				return modelFileInvalid()
			}
			for _, v := range parts[1:] {
				if !finiteModelNumber(v) {
					return modelFileInvalid()
				}
			}
			counts[kind]++
			if counts[kind] > 1_000_000 {
				return modelFileInvalid()
			}
		case "f", "l", "p":
			minimum := 3
			if parts[0] == "l" {
				minimum = 2
			}
			if parts[0] == "p" {
				minimum = 1
			}
			if len(parts)-1 < minimum || len(parts) > 1001 {
				return modelFileInvalid()
			}
			for _, v := range parts[1:] {
				refs := strings.Split(v, "/")
				if len(refs) > 3 || !index(refs[0], counts[0]) {
					return modelFileInvalid()
				}
				for i := 1; i < len(refs); i++ {
					if refs[i] != "" && !index(refs[i], counts[i]) {
						return modelFileInvalid()
					}
				}
			}
			if parts[0] == "f" {
				faces++
			}
		case "o", "g", "s", "usemtl":
			if len(parts) < 2 {
				return modelFileInvalid()
			}
		case "mtllib":
			return httpapi.Fail(422, "FILE_EXTERNAL_DEPENDENCY", "OBJ 材质依赖需要先打包为自包含模型。")
		default:
			return modelFileInvalid()
		}
	}
	if scanner.Err() != nil || counts[0] < 3 || faces < 1 {
		return modelFileInvalid()
	}
	return nil
}

type fbxValue struct {
	kind  byte
	data  []byte
	count int
}
type fbxNode struct {
	name     string
	values   []fbxValue
	children []*fbxNode
}
type fbxParser struct {
	body           []byte
	wide           bool
	nodes, decoded int
}

func (p *fbxParser) property(at, end int) (fbxValue, int, error) {
	var v fbxValue
	if at >= end {
		return v, at, modelFileInvalid()
	}
	v.kind = p.body[at]
	at++
	sizes := map[byte]int{'Y': 2, 'Z': 1, 'B': 1, 'C': 1, 'I': 4, 'F': 4, 'D': 8, 'L': 8}
	if size := sizes[v.kind]; size > 0 {
		if size > end-at {
			return v, at, modelFileInvalid()
		}
		v.data = p.body[at : at+size]
		if v.kind == 'F' && (math.IsNaN(float64(math.Float32frombits(binary.LittleEndian.Uint32(v.data)))) || math.IsInf(float64(math.Float32frombits(binary.LittleEndian.Uint32(v.data))), 0)) || v.kind == 'D' && (math.IsNaN(math.Float64frombits(binary.LittleEndian.Uint64(v.data))) || math.IsInf(math.Float64frombits(binary.LittleEndian.Uint64(v.data)), 0)) {
			return v, at, modelFileInvalid()
		}
		return v, at + size, nil
	}
	if v.kind == 'S' || v.kind == 'R' {
		if end-at < 4 {
			return v, at, modelFileInvalid()
		}
		size := uint64(binary.LittleEndian.Uint32(p.body[at : at+4]))
		at += 4
		if size > uint64(end-at) {
			return v, at, modelFileInvalid()
		}
		v.data = p.body[at : at+int(size)]
		return v, at + int(size), nil
	}
	stride := map[byte]int{'f': 4, 'd': 8, 'i': 4, 'l': 8, 'b': 1, 'c': 1}[v.kind]
	if stride == 0 || end-at < 12 {
		return v, at, modelFileInvalid()
	}
	count := uint64(binary.LittleEndian.Uint32(p.body[at : at+4]))
	encoding := binary.LittleEndian.Uint32(p.body[at+4 : at+8])
	stored := uint64(binary.LittleEndian.Uint32(p.body[at+8 : at+12]))
	at += 12
	expected := count * uint64(stride)
	if count > 16_000_000 || expected > 128<<20 || p.decoded+int(expected) > 128<<20 || stored > uint64(end-at) || encoding > 1 {
		return v, at, modelFileInvalid()
	}
	p.decoded += int(expected)
	v.count = int(count)
	v.data = p.body[at : at+int(stored)]
	if encoding == 1 {
		input := bytes.NewReader(v.data)
		reader, e := zlib.NewReader(input)
		if e != nil {
			return v, at, modelFileInvalid()
		}
		decoded, e := io.ReadAll(io.LimitReader(reader, int64(expected)+1))
		closeErr := reader.Close()
		if e != nil || closeErr != nil || len(decoded) != int(expected) || input.Len() != 0 {
			return v, at, modelFileInvalid()
		}
		v.data = decoded
	} else if len(v.data) != int(expected) {
		return v, at, modelFileInvalid()
	}
	if v.kind == 'f' || v.kind == 'd' {
		for i := 0; i < len(v.data); i += stride {
			var n float64
			if stride == 4 {
				n = float64(math.Float32frombits(binary.LittleEndian.Uint32(v.data[i : i+4])))
			} else {
				n = math.Float64frombits(binary.LittleEndian.Uint64(v.data[i : i+8]))
			}
			if math.IsNaN(n) || math.IsInf(n, 0) {
				return v, at, modelFileInvalid()
			}
		}
	}
	return v, at + int(stored), nil
}
func (p *fbxParser) node(at, limit, depth int) (*fbxNode, int, error) {
	header := 13
	if p.wide {
		header = 25
	}
	if depth > 32 || p.nodes >= 100000 || limit-at < header {
		return nil, at, modelFileInvalid()
	}
	if bytes.Equal(p.body[at:at+header], make([]byte, header)) {
		return nil, at + header, nil
	}
	var end, count, size uint64
	if p.wide {
		end = binary.LittleEndian.Uint64(p.body[at:])
		count = binary.LittleEndian.Uint64(p.body[at+8:])
		size = binary.LittleEndian.Uint64(p.body[at+16:])
	} else {
		end = uint64(binary.LittleEndian.Uint32(p.body[at:]))
		count = uint64(binary.LittleEndian.Uint32(p.body[at+4:]))
		size = uint64(binary.LittleEndian.Uint32(p.body[at+8:]))
	}
	nameSize := int(p.body[at+header-1])
	at += header
	if end > uint64(limit) || end <= uint64(at) || nameSize == 0 || nameSize > int(end)-at || count > 100000 || size > uint64(int(end)-at-nameSize) {
		return nil, at, modelFileInvalid()
	}
	n := &fbxNode{name: string(p.body[at : at+nameSize])}
	at += nameSize
	p.nodes++
	propsEnd := at + int(size)
	for i := uint64(0); i < count; i++ {
		value, next, e := p.property(at, propsEnd)
		if e != nil {
			return nil, at, e
		}
		n.values = append(n.values, value)
		at = next
	}
	if at != propsEnd {
		return nil, at, modelFileInvalid()
	}
	if at < int(end) {
		for at < int(end)-header {
			child, next, e := p.node(at, int(end)-header, depth+1)
			if e != nil || child == nil || next <= at {
				return nil, at, modelFileInvalid()
			}
			n.children = append(n.children, child)
			at = next
		}
		if at+header != int(end) || !bytes.Equal(p.body[at:int(end)], make([]byte, header)) {
			return nil, at, modelFileInvalid()
		}
		at = int(end)
	}
	return n, at, nil
}
func fbxMeshValid(n *fbxNode) bool {
	if n.name != "Geometry" || len(n.values) < 3 || n.values[0].kind != 'L' && n.values[0].kind != 'I' || n.values[1].kind != 'S' || len(n.values[1].data) == 0 || n.values[2].kind != 'S' || string(n.values[2].data) != "Mesh" {
		return false
	}
	var vertices, indices *fbxValue
	for _, child := range n.children {
		if len(child.values) == 1 {
			if child.name == "Vertices" {
				vertices = &child.values[0]
			}
			if child.name == "PolygonVertexIndex" {
				indices = &child.values[0]
			}
		}
	}
	if vertices == nil || indices == nil || (vertices.kind != 'd' && vertices.kind != 'f') || vertices.count < 9 || vertices.count%3 != 0 || indices.kind != 'i' || indices.count < 3 {
		return false
	}
	count, face, faces := vertices.count/3, 0, 0
	for i := 0; i < len(indices.data); i += 4 {
		index := int64(int32(binary.LittleEndian.Uint32(indices.data[i : i+4])))
		finish := index < 0
		if finish {
			index = -index - 1
		}
		if index < 0 || index >= int64(count) {
			return false
		}
		face++
		if face > 1000 {
			return false
		}
		if finish {
			if face < 3 {
				return false
			}
			faces++
			face = 0
		}
	}
	return face == 0 && faces > 0
}
func validateFBX(body []byte) error {
	if len(body) < 27 || len(body) > 128<<20 {
		return modelFileInvalid()
	}
	if !bytes.HasPrefix(body, []byte("Kaydara FBX Binary  \x00\x1a\x00")) {
		return validateASCIIFBX(body)
	}
	version := binary.LittleEndian.Uint32(body[23:27])
	if version < 7000 || version > 7700 {
		return modelFileInvalid()
	}
	p := &fbxParser{body: body, wide: version >= 7500}
	at, meshes := 27, 0
	var inspect func(*fbxNode) error
	inspect = func(n *fbxNode) error {
		if n.name == "Geometry" {
			isMesh := len(n.values) > 2 && n.values[2].kind == 'S' && string(n.values[2].data) == "Mesh"
			if isMesh {
				if !fbxMeshValid(n) {
					return modelFileInvalid()
				}
				meshes++
			}
		}
		embedded := false
		for _, c := range n.children {
			if c.name == "Content" && len(c.values) == 1 && len(c.values[0].data) > 0 {
				embedded = true
			}
		}
		for _, c := range n.children {
			if (c.name == "FileName" || c.name == "Filename" || c.name == "RelativeFilename") && len(c.values) > 0 && len(c.values[0].data) > 0 && !embedded {
				return httpapi.Fail(422, "FILE_EXTERNAL_DEPENDENCY", "FBX 纹理需要先嵌入模型。")
			}
			if e := inspect(c); e != nil {
				return e
			}
		}
		return nil
	}
	for {
		n, next, e := p.node(at, len(body), 0)
		if e != nil {
			return e
		}
		at = next
		if n == nil {
			break
		}
		if e = inspect(n); e != nil {
			return e
		}
	}
	// Standard binary FBX footer is opaque but has fixed alignment/version and
	// trailing magic. Refuse arbitrary bytes after the validated node stream.
	foot := body[at:]
	magic := []byte{0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b}
	if meshes < 1 || len(foot) < 161 || len(foot) > 176 || !bytes.Equal(foot[len(foot)-16:], magic) || binary.LittleEndian.Uint32(foot[len(foot)-140:len(foot)-136]) != version || !bytes.Equal(foot[len(foot)-136:len(foot)-16], make([]byte, 120)) || !bytes.Equal(foot[16:len(foot)-140], make([]byte, len(foot)-156)) {
		return modelFileInvalid()
	}
	return nil
}

var fbxASCIIArray = regexp.MustCompile(`(?s)(Vertices|PolygonVertexIndex)\s*:\s*\*([0-9]+)\s*\{\s*a\s*:\s*([^{}]*)\}`)
var fbxASCIIField = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*\s*:`)
var fbxASCIINumeric = regexp.MustCompile(`^[0-9eE+., \t-]+$`)

func validateASCIIFBX(body []byte) error {
	if len(body) > 32<<20 || !utf8.Valid(body) || bytes.IndexByte(body, 0) >= 0 {
		return modelFileInvalid()
	}
	source := string(body)
	if !strings.HasPrefix(strings.TrimSpace(source), "; FBX") || !regexp.MustCompile(`FBXVersion\s*:\s*7[0-7]00`).MatchString(source) {
		return modelFileInvalid()
	}
	// Check every structural brace outside comments/strings, with bounded depth.
	depth := 0
	quote, escape, comment := false, false, false
	for _, r := range source {
		if comment {
			if r == '\n' {
				comment = false
			}
			continue
		}
		if escape {
			escape = false
			continue
		}
		if quote {
			if r == '\\' {
				escape = true
			} else if r == '"' {
				quote = false
			}
			continue
		}
		if r == ';' {
			comment = true
		} else if r == '"' {
			quote = true
		} else if r == '{' {
			depth++
			if depth > 32 {
				return modelFileInvalid()
			}
		} else if r == '}' {
			depth--
			if depth < 0 {
				return modelFileInvalid()
			}
		}
	}
	if quote || depth != 0 || !strings.Contains(source, "Geometry:") && !strings.Contains(source, "Geometry :") {
		return modelFileInvalid()
	}
	scanner := bufio.NewScanner(strings.NewReader(source))
	scanner.Buffer(make([]byte, 4096), 65537)
	lines := 0
	for scanner.Scan() {
		line := scanner.Text()
		lines++
		if lines > 2_000_000 {
			return modelFileInvalid()
		}
		// Canonical ASCII FBX consists solely of named fields, braces and
		// numeric array continuations. No executable or unrelated payload.
		var clean strings.Builder
		inString, escaped := false, false
		for _, r := range line {
			if escaped {
				escaped = false
				continue
			}
			if inString {
				if r == '\\' {
					escaped = true
				} else if r == '"' {
					inString = false
					clean.WriteString("\"\"")
				}
				continue
			}
			if r == ';' {
				break
			}
			if r == '"' {
				inString = true
				continue
			}
			clean.WriteRune(r)
		}
		x := strings.TrimSpace(clean.String())
		if x == "" || strings.Trim(x, "} \t") == "" {
			continue
		}
		if !fbxASCIIField.MatchString(x) && !fbxASCIINumeric.MatchString(x) {
			return modelFileInvalid()
		}
	}
	if scanner.Err() != nil {
		return modelFileInvalid()
	}
	arrays := fbxASCIIArray.FindAllStringSubmatch(source, -1)
	vertexCount := 0
	indexArrays := 0
	for _, a := range arrays {
		count, e := strconv.Atoi(a[2])
		if e != nil || count < 1 || count > 3_000_000 {
			return modelFileInvalid()
		}
		if strings.Count(a[3], ",")+1 != count {
			return modelFileInvalid()
		}
		values := strings.Split(strings.TrimSpace(a[3]), ",")
		if len(values) != count {
			return modelFileInvalid()
		}
		if a[1] == "Vertices" {
			if count < 9 || count%3 != 0 {
				return modelFileInvalid()
			}
			for _, v := range values {
				if !finiteModelNumber(strings.TrimSpace(v)) {
					return modelFileInvalid()
				}
			}
			vertexCount = count / 3
		} else {
			if vertexCount < 3 {
				return modelFileInvalid()
			}
			face, faces := 0, 0
			for _, v := range values {
				n, e := strconv.ParseInt(strings.TrimSpace(v), 10, 32)
				if e != nil {
					return modelFileInvalid()
				}
				end := n < 0
				if end {
					n = -n - 1
				}
				if n < 0 || n >= int64(vertexCount) {
					return modelFileInvalid()
				}
				face++
				if face > 1000 {
					return modelFileInvalid()
				}
				if end {
					if face < 3 {
						return modelFileInvalid()
					}
					face = 0
					faces++
				}
			}
			if face != 0 || faces == 0 {
				return modelFileInvalid()
			}
			indexArrays++
		}
	}
	if vertexCount < 3 || indexArrays < 1 {
		return modelFileInvalid()
	}
	if regexp.MustCompile(`(?:FileName|Filename|RelativeFilename)\s*:\s*"[^"]+"`).MatchString(source) {
		return httpapi.Fail(422, "FILE_EXTERNAL_DEPENDENCY", "FBX 纹理需要先嵌入模型。")
	}
	return nil
}
func (s *ProductAssetStore) RegisterProductAssetRoutes(r chi.Router, protect func(string, httpapi.Handler) http.HandlerFunc) {
	r.MethodFunc("POST", "/api/v2/catalog/media/materialize", protect("tv.access", s.materializeCatalog))
	r.MethodFunc("POST", "/api/v2/file-assets", protect("tv.access", s.uploadProductFile))
	r.MethodFunc("GET", "/api/v2/file-assets/{assetId}", protect("tv.access", s.getProductFile))
}
func (s *ProductAssetStore) getProductFile(w http.ResponseWriter, r *http.Request) error {
	a, err := accessibleAsset(r.Context(), s.pool, owner(r), chi.URLParam(r, "assetId"), false)
	if err != nil {
		return err
	}
	if a.Kind != "FILE" {
		return httpapi.Fail(404, "ASSET_NOT_FOUND", "文件素材不存在。")
	}
	return s.productAssetResponse(w, r, 200, a)
}
func (s *ProductAssetStore) productAssetResponse(w http.ResponseWriter, r *http.Request, status int, a Asset) error {
	server := &Server{cfg: s.cfg, tokens: security.New(s.cfg)}
	data, err := server.publicAsset(r, a)
	if err != nil {
		return err
	}
	var provenance map[string]any
	var raw []byte
	if err = s.pool.QueryRow(r.Context(), `SELECT provenance FROM public.assets WHERE id=$1`, a.ID).Scan(&raw); err != nil {
		return err
	}
	_ = json.Unmarshal(raw, &provenance)
	data["provenance"] = provenance
	data["testMode"] = provenance["testMode"] == true
	return httpapi.OK(w, r, status, data)
}
func (s *ProductAssetStore) uploadProductFile(w http.ResponseWriter, r *http.Request) error {
	if len(r.Header.Values("Idempotency-Key")) != 1 {
		return httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要一个有效的幂等键。")
	}
	key, err := uuid.Parse(r.Header.Get("Idempotency-Key"))
	if err != nil {
		return httpapi.Fail(400, "IDEMPOTENCY_KEY_REQUIRED", "需要有效的幂等键。")
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.cfg.MaxUploadBytes+(1<<20))
	if err = r.ParseMultipartForm(1 << 20); err != nil {
		return httpapi.Fail(400, "UPLOAD_INVALID", "上传格式无效或文件超出限制。")
	}
	defer r.MultipartForm.RemoveAll()
	if len(r.MultipartForm.File) != 1 || len(r.MultipartForm.File["file"]) != 1 || len(r.MultipartForm.Value) != 1 || len(r.MultipartForm.Value["projectId"]) != 1 {
		return httpapi.Fail(400, "UPLOAD_INVALID", "需要一个文件和作品标识。")
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		return httpapi.Fail(400, "UPLOAD_INVALID", "文件缺失。")
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, s.cfg.MaxUploadBytes+1))
	if err != nil || len(body) == 0 || int64(len(body)) > s.cfg.MaxUploadBytes {
		return httpapi.Fail(413, "PAYLOAD_TOO_LARGE", "文件超出限制。")
	}
	filename := filepath.Base(header.Filename)
	if len([]rune(filename)) > 255 || strings.ContainsAny(filename, "\r\n\x00") {
		return httpapi.Fail(400, "UPLOAD_INVALID", "文件名无效。")
	}
	typ := map[string]string{".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".obj": "model/obj", ".fbx": "application/x-fbx", ".ply": "application/x-ply", ".spz": "application/x-spz", ".splat": "application/x-splat", ".md": "text/markdown", ".markdown": "text/markdown"}[strings.ToLower(filepath.Ext(filename))]
	if typ == "" {
		return httpapi.Fail(422, "MIME_UNSUPPORTED", "文件格式未启用。")
	}
	hash := sha256.Sum256(body)
	kind := "FILE"
	uid := owner(r)
	projectID := r.FormValue("projectId")
	requestDigest := sha256.Sum256([]byte(projectID + "\x00" + filename + "\x00" + typ + "\x00" + hex.EncodeToString(hash[:])))
	requestHash := hex.EncodeToString(requestDigest[:])
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "file-upload/"+uid+"/"+key.String()); err != nil {
		return err
	}
	scope, err := collaboration.RequireProject(r.Context(), tx, uid, projectID, "EDITOR", true)
	if err != nil {
		return err
	}
	var existingID, oldHash string
	err = tx.QueryRow(r.Context(), `SELECT asset_id,request_hash FROM media.file_receipts WHERE owner_id=$1 AND idempotency_key=$2`, uid, key.String()).Scan(&existingID, &oldHash)
	if err == nil {
		if oldHash != requestHash {
			return httpapi.Fail(409, "IDEMPOTENCY_CONFLICT", "同一上传键对应不同文件请求。")
		}
		a, e := accessibleAsset(r.Context(), tx, uid, existingID, false)
		if e != nil {
			return e
		}
		if e = verifyStoredAsset(s.cfg.StorageRoot, a); e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e != nil {
			return e
		}
		return s.productAssetResponse(w, r, 200, a)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if err = tx.Rollback(r.Context()); err != nil {
		return err
	}
	logical := "upload/" + uid + "/" + key.String()
	asset, err := s.Import(r.Context(), uid, projectID, logical, gateway.Artifact{Kind: &kind, MediaType: typ, SizeBytes: int64(len(body)), SHA256: hex.EncodeToString(hash[:])}, body)
	if err != nil {
		return err
	}
	tx, err = s.pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "file-upload/"+uid+"/"+key.String()); err != nil {
		return err
	}
	scope, err = collaboration.RequireProject(r.Context(), tx, uid, projectID, "EDITOR", true)
	if err != nil {
		return err
	}
	err = tx.QueryRow(r.Context(), `SELECT asset_id,request_hash FROM media.file_receipts WHERE owner_id=$1 AND idempotency_key=$2`, uid, key.String()).Scan(&existingID, &oldHash)
	if err == nil {
		if oldHash != requestHash {
			return httpapi.Fail(409, "IDEMPOTENCY_CONFLICT", "同一上传键对应不同文件请求。")
		}
		a, e := accessibleAsset(r.Context(), tx, uid, existingID, false)
		if e != nil {
			return e
		}
		if e = tx.Commit(r.Context()); e != nil {
			return e
		}
		return s.productAssetResponse(w, r, 200, a)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	if _, err = tx.Exec(r.Context(), `UPDATE public.assets SET file_name=$3 WHERE id=$1 AND owner_id=$2`, asset.ID, scope.StorageOwnerID, filename); err != nil {
		return err
	}
	if _, err = tx.Exec(r.Context(), `INSERT INTO media.file_receipts(owner_id,idempotency_key,request_hash,asset_id) VALUES($1,$2,$3,$4)`, uid, key.String(), requestHash, asset.ID); err != nil {
		return err
	}
	a, err := accessibleAsset(r.Context(), tx, uid, asset.ID, false)
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	w.Header().Set("Location", "/api/v2/file-assets/"+a.ID)
	return s.productAssetResponse(w, r, 201, a)
}

var _ execution.AssetImporter = (*ProductAssetStore)(nil)
var _ media.InputPort = (*ProductAssetStore)(nil)

func (s *ProductAssetStore) EnsureVault(ctx context.Context, uid, purpose string) (string, error) {
	if requireID(uid) != nil || (purpose != "ASSET_VAULT" && purpose != "STUDIO_ASSETS") {
		return "", httpapi.Fail(400, "VALIDATION_FAILED", "素材空间无效。")
	}
	digest := sha256.Sum256([]byte(uid + "/" + purpose))
	id := "prj_" + hex.EncodeToString(digest[:])[:48]
	_, err := s.pool.Exec(ctx, `INSERT INTO public.projects(id,owner_id,name,internal_kind) VALUES($1,$2,'Private asset storage',$3) ON CONFLICT(id) DO NOTHING`, id, uid, purpose)
	if err != nil {
		return "", err
	}
	var ownerID, kind string
	var deleted *time.Time
	if err = s.pool.QueryRow(ctx, `SELECT owner_id,internal_kind,deleted_at FROM public.projects WHERE id=$1`, id).Scan(&ownerID, &kind, &deleted); err != nil {
		return "", err
	}
	if ownerID != uid || kind != purpose || deleted != nil {
		return "", httpapi.Fail(409, "ASSET_VAULT_CONFLICT", "素材空间不可用。")
	}
	return id, nil
}
func jsonPointer(raw []byte, pointer string) (string, error) {
	if pointer == "" || !strings.HasPrefix(pointer, "/") || len(pointer) > 1000 {
		return "", errors.New("invalid pointer")
	}
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return "", errors.New("invalid catalog content")
	}
	for _, part := range strings.Split(pointer[1:], "/") {
		var decoded strings.Builder
		for i := 0; i < len(part); i++ {
			if part[i] == '~' {
				if i+1 >= len(part) || part[i+1] != '0' && part[i+1] != '1' {
					return "", errors.New("invalid pointer escape")
				}
				i++
				if part[i] == '0' {
					decoded.WriteByte('~')
				} else {
					decoded.WriteByte('/')
				}
			} else {
				decoded.WriteByte(part[i])
			}
		}
		key := decoded.String()
		switch item := value.(type) {
		case map[string]any:
			var ok bool
			value, ok = item[key]
			if !ok {
				return "", errors.New("pointer missing")
			}
		case []any:
			if key == "" || len(key) > 1 && key[0] == '0' {
				return "", errors.New("invalid index")
			}
			index, err := strconv.Atoi(key)
			if err != nil || index < 0 || index >= len(item) {
				return "", errors.New("pointer missing")
			}
			value = item[index]
		default:
			return "", errors.New("pointer is not a container")
		}
	}
	result, ok := value.(string)
	if !ok {
		return "", errors.New("pointer does not reference media")
	}
	return result, nil
}

var studioCharacterMediaPath = regexp.MustCompile(`^/studio-character-media/([a-f0-9]{64})\.webp$`)

func validCatalogLocalPath(path string) bool {
	return (strings.HasPrefix(path, "/project/assets/") || studioCharacterMediaPath.MatchString(path)) && filepath.ToSlash(filepath.Clean(path)) == path && !strings.ContainsAny(path, "\\\x00")
}

func verifyCatalogLocalBytes(path string, body []byte) error {
	if match := studioCharacterMediaPath.FindStringSubmatch(path); match != nil {
		digest := sha256.Sum256(body)
		if hex.EncodeToString(digest[:]) != match[1] {
			return httpapi.Retry(503, "CATALOG_MEDIA_INTEGRITY_FAILED", "目录素材校验失败。")
		}
	}
	return nil
}

func (s *ProductAssetStore) materializeCatalog(w http.ResponseWriter, r *http.Request) error {
	var command struct {
		ProjectID  string `json:"projectId,omitempty"`
		Family     string `json:"family"`
		ResourceID string `json:"resourceId"`
		Revision   int64  `json:"revision"`
		Path       string `json:"path"`
	}
	if err := httpapi.DecodeLimit(w, r, &command, 8192); err != nil {
		return err
	}
	key, err := uuid.Parse(r.Header.Get("Idempotency-Key"))
	if err != nil || len(r.Header.Values("Idempotency-Key")) != 1 || command.Revision < 1 || requireID(command.ResourceID) != nil {
		return httpapi.Fail(400, "VALIDATION_FAILED", "目录引用无效。")
	}
	var raw []byte
	var sourceVersion string
	err = s.pool.QueryRow(r.Context(), `SELECT content,source_version FROM resources.items WHERE id=$1 AND family=$2 AND revision=$3 AND scope='SYSTEM' AND owner_id IS NULL AND deleted_at IS NULL`, command.ResourceID, command.Family, command.Revision).Scan(&raw, &sourceVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return httpapi.Fail(404, "CATALOG_RESOURCE_NOT_FOUND", "目录版本不存在。")
	}
	if err != nil {
		return err
	}
	reference, err := jsonPointer(raw, command.Path)
	if err != nil {
		return httpapi.Fail(400, "CATALOG_MEDIA_REFERENCE_INVALID", "目录媒体引用无效。")
	}
	body, embedded, err := embeddedStyleMedia(command.ResourceID, sourceVersion, reference)
	if err != nil {
		return httpapi.Retry(503, "CATALOG_MEDIA_INTEGRITY_FAILED", "目录素材校验失败。")
	}
	typ := "image/webp"
	if !embedded {
		var path string
		err = s.pool.QueryRow(r.Context(), `SELECT path FROM resources.catalog_media WHERE source_version=$1 AND (path=$2 OR id=$2)`, sourceVersion, reference).Scan(&path)
		if errors.Is(err, pgx.ErrNoRows) {
			return httpapi.Fail(404, "CATALOG_MEDIA_NOT_AVAILABLE", "目录媒体未在本地登记。")
		}
		if err != nil {
			return err
		}
		if !validCatalogLocalPath(path) {
			return httpapi.Fail(422, "CATALOG_MEDIA_REFERENCE_INVALID", "目录媒体路径无效。")
		}
		root := filepath.Clean(s.cfg.CatalogRoot)
		resolved, err := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(path, "/"))))
		if err != nil {
			return httpapi.Fail(404, "CATALOG_MEDIA_NOT_AVAILABLE", "目录文件不在本地。")
		}
		relative, err := filepath.Rel(root, resolved)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return httpapi.Fail(422, "CATALOG_MEDIA_REFERENCE_INVALID", "目录媒体路径无效。")
		}
		info, err := os.Stat(resolved)
		if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > s.cfg.MaxUploadBytes {
			return httpapi.Fail(404, "CATALOG_MEDIA_NOT_AVAILABLE", "目录媒体不可用。")
		}
		file, err := os.Open(resolved)
		if err != nil {
			return err
		}
		defer file.Close()
		body, err = io.ReadAll(io.LimitReader(file, s.cfg.MaxUploadBytes+1))
		if err != nil || int64(len(body)) > s.cfg.MaxUploadBytes {
			return httpapi.Fail(413, "PAYLOAD_TOO_LARGE", "目录媒体超出限制。")
		}
		if err := verifyCatalogLocalBytes(path, body); err != nil {
			return err
		}

		typ = mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
		if t, _, e := mime.ParseMediaType(typ); e == nil {
			typ = t
		}
		if mimeKinds[typ] == "" {
			return httpapi.Fail(422, "MIME_UNSUPPORTED", "目录媒体格式未启用。")
		}
	}
	uid := owner(r)
	if command.ProjectID == "" {
		command.ProjectID, err = s.EnsureVault(r.Context(), uid, "ASSET_VAULT")
		if err != nil {
			return err
		}
	}
	digest := sha256.Sum256(body)
	request, _ := json.Marshal(command)
	rh := sha256.Sum256(request)
	logical := "catalog/" + uid + "/" + key.String()
	art := gateway.Artifact{Ref: "catalog:" + sourceVersion + ":" + hex.EncodeToString(rh[:]), MediaType: typ, SizeBytes: int64(len(body)), SHA256: hex.EncodeToString(digest[:])}
	asset, err := s.Import(r.Context(), uid, command.ProjectID, logical, art, body)
	if err != nil {
		return err
	}
	a, err := ownAsset(r.Context(), s.pool, uid, asset.ID, false)
	if err != nil {
		return err
	}
	server := &Server{cfg: s.cfg, tokens: security.New(s.cfg)}
	data, err := server.publicAsset(r, a)
	if err != nil {
		return err
	}
	return httpapi.OK(w, r, 201, map[string]any{"asset": data})
}

func (s *ProductAssetStore) ImportCatalogMedia(ctx context.Context, command resources.MediaImport) (resources.MaterializedAsset, error) {
	bad := func() error {
		return httpapi.Fail(422, "CATALOG_MEDIA_REFERENCE_INVALID", "目录素材引用无效。")
	}
	key, e := uuid.Parse(command.IdempotencyKey)
	if e != nil || requireID(command.OwnerID) != nil || len(command.RequestHash) != 64 {
		return resources.MaterializedAsset{}, bad()
	}
	if _, e = hex.DecodeString(command.RequestHash); e != nil {
		return resources.MaterializedAsset{}, bad()
	}
	var registered bool
	if e = s.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM resources.catalog_media WHERE path=$1)`, command.SourcePath).Scan(&registered); e != nil {
		return resources.MaterializedAsset{}, e
	}
	if !registered {
		return resources.MaterializedAsset{}, httpapi.Fail(404, "CATALOG_MEDIA_NOT_AVAILABLE", "目录素材未登记。")
	}
	path := command.SourcePath
	if !validCatalogLocalPath(path) {
		return resources.MaterializedAsset{}, bad()
	}
	root := filepath.Clean(s.cfg.CatalogRoot)
	resolved, e := filepath.EvalSymlinks(filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(path, "/"))))
	if e != nil {
		return resources.MaterializedAsset{}, httpapi.Fail(404, "CATALOG_MEDIA_NOT_AVAILABLE", "目录素材未在本地。")
	}
	relative, e := filepath.Rel(root, resolved)
	if e != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return resources.MaterializedAsset{}, bad()
	}
	info, e := os.Stat(resolved)
	if e != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > s.cfg.MaxUploadBytes {
		return resources.MaterializedAsset{}, bad()
	}
	file, e := os.Open(resolved)
	if e != nil {
		return resources.MaterializedAsset{}, e
	}
	defer file.Close()
	body, e := io.ReadAll(io.LimitReader(file, s.cfg.MaxUploadBytes+1))
	if e != nil || int64(len(body)) > s.cfg.MaxUploadBytes {
		return resources.MaterializedAsset{}, bad()
	}
	if err := verifyCatalogLocalBytes(path, body); err != nil {
		return resources.MaterializedAsset{}, err
	}

	typ := mime.TypeByExtension(strings.ToLower(filepath.Ext(path)))
	typ, _, e = mime.ParseMediaType(typ)
	if e != nil || mimeKinds[typ] == "" {
		return resources.MaterializedAsset{}, httpapi.Fail(422, "MIME_UNSUPPORTED", "目录媒体类型未启用。")
	}
	if command.ProjectID == "" {
		command.ProjectID, e = s.EnsureVault(ctx, command.OwnerID, "ASSET_VAULT")
		if e != nil {
			return resources.MaterializedAsset{}, e
		}
	}
	digest := sha256.Sum256(body)
	asset, e := s.Import(ctx, command.OwnerID, command.ProjectID, "catalog-import/"+command.OwnerID+"/"+key.String(), gateway.Artifact{Ref: "catalog-import:" + command.RequestHash, MediaType: typ, SizeBytes: int64(len(body)), SHA256: hex.EncodeToString(digest[:])}, body)
	return resources.MaterializedAsset{AssetID: asset.ID}, e
}

type boundedProductBuffer struct {
	bytes.Buffer
	limit int
}

func (b *boundedProductBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, errors.New("decoded file exceeds bound")
	}
	return b.Buffer.Write(p)
}
func validateSPZ(body []byte) error {
	bad := func() error { return httpapi.Fail(422, "FILE_INVALID", "SPZ容器或压缩数据无效。") }
	if len(body) < 16 {
		return bad()
	}
	if string(body[:4]) != "NGSP" {
		r, e := gzip.NewReader(bytes.NewReader(body))
		if e != nil {
			return bad()
		}
		defer r.Close()
		decoded, e := io.ReadAll(io.LimitReader(r, (128<<20)+1))
		if e != nil || len(decoded) < 16 || len(decoded) > 128<<20 || string(decoded[:4]) != "NGSP" {
			return bad()
		}
		version := binary.LittleEndian.Uint32(decoded[4:8])
		count := uint64(binary.LittleEndian.Uint32(decoded[8:12]))
		degree := decoded[12]
		if version < 1 || version > 3 || count < 1 || count > 10000000 || degree > 4 || decoded[13] > 24 {
			return bad()
		}
		coefficients := []uint64{0, 9, 24, 45, 72}
		position, rotation := uint64(9), uint64(3)
		if version == 1 {
			position = 6
		}
		if version == 3 {
			rotation = 4
		}
		expected := uint64(16) + count*(position+rotation+7+coefficients[degree])
		if uint64(len(decoded)) != expected {
			return bad()
		}
		return nil
	}
	if len(body) < 32 || binary.LittleEndian.Uint32(body[4:8]) != 4 {
		return bad()
	}
	count := uint64(binary.LittleEndian.Uint32(body[8:12]))
	streams := int(body[15])
	toc := int(binary.LittleEndian.Uint32(body[16:20]))
	if count < 1 || count > 10000000 || body[12] > 4 || body[13] > 24 || streams < 5 || streams > 6 || toc < 32 || toc > len(body)-streams*16 {
		return bad()
	}
	for _, v := range body[20:32] {
		if v != 0 {
			return bad()
		}
	}
	coefficients := []uint64{0, 9, 24, 45, 72}
	expectedSizes := []uint64{count * 9, count, count * 3, count * 3, count * 4}
	if body[12] > 0 {
		expectedSizes = append(expectedSizes, count*coefficients[body[12]])
	}
	if streams != len(expectedSizes) {
		return bad()
	}
	offset := toc + streams*16
	total := uint64(0)
	for i := 0; i < streams; i++ {
		row := toc + i*16
		compressed := binary.LittleEndian.Uint64(body[row : row+8])
		decodedSize := binary.LittleEndian.Uint64(body[row+8 : row+16])
		if decodedSize != expectedSizes[i] {
			return bad()
		}
		total += decodedSize
		if compressed < 4 || compressed > uint64(len(body)-offset) || decodedSize > 128<<20 || total > 128<<20 {
			return bad()
		}
		frame := body[offset : offset+int(compressed)]
		if binary.LittleEndian.Uint32(frame[:4]) != 0xfd2fb528 {
			return bad()
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		command := exec.CommandContext(ctx, "zstd", "--decompress", "--stdout", "--quiet", "--memory=128MB")
		command.Stdin = bytes.NewReader(frame)
		out := &boundedProductBuffer{limit: int(decodedSize) + 1}
		command.Stdout = out
		command.Stderr = io.Discard
		command.WaitDelay = time.Second
		e := command.Run()
		cancel()
		if errors.Is(e, exec.ErrNotFound) {
			return httpapi.Fail(501, "FILE_VALIDATION_UNAVAILABLE", "SPZ v4 解码器未配置。")
		}
		if e != nil || uint64(out.Len()) != decodedSize {
			return bad()
		}
		offset += int(compressed)
	}
	if offset != len(body) {
		return bad()
	}
	return nil
}

var _ resources.MediaMaterializer = (*ProductAssetStore)(nil)

type plyProperty struct{ name, scalar, countType string }
type plyElement struct {
	name       string
	count      int
	properties []plyProperty
}

func validatePLY(body []byte) error {
	bad := func() error { return httpapi.Fail(422, "FILE_INVALID", "PLY 点与属性数据无效。") }
	end := bytes.Index(body, []byte("end_header\n"))
	skip := 11
	if end < 0 {
		end = bytes.Index(body, []byte("end_header\r\n"))
		skip = 12
	}
	if end < 0 || end > 65536 {
		return bad()
	}
	lines := strings.Split(strings.ReplaceAll(string(body[:end]), "\r\n", "\n"), "\n")
	if len(lines) < 3 || lines[0] != "ply" {
		return bad()
	}
	sizes := map[string]int{"char": 1, "int8": 1, "uchar": 1, "uint8": 1, "short": 2, "int16": 2, "ushort": 2, "uint16": 2, "int": 4, "int32": 4, "uint": 4, "uint32": 4, "float": 4, "float32": 4, "double": 8, "float64": 8}
	format := ""
	elements := []plyElement{}
	vertices := 0
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "comment", "obj_info":
			continue
		case "format":
			if len(fields) != 3 || fields[2] != "1.0" || format != "" {
				return bad()
			}
			format = fields[1]
		case "element":
			if len(fields) != 3 || len(elements) >= 8 {
				return bad()
			}
			count, e := strconv.Atoi(fields[2])
			if e != nil || count < 0 || count > 10000000 {
				return bad()
			}
			elements = append(elements, plyElement{name: fields[1], count: count})
			if fields[1] == "vertex" {
				if vertices != 0 || count < 1 {
					return bad()
				}
				vertices = count
			}
		case "property":
			if len(elements) == 0 || len(elements[len(elements)-1].properties) >= 64 {
				return bad()
			}
			p := plyProperty{}
			if len(fields) == 3 {
				p.scalar, p.name = fields[1], fields[2]
			} else if len(fields) == 5 && fields[1] == "list" {
				p.countType, p.scalar, p.name = fields[2], fields[3], fields[4]
				if strings.Contains(p.countType, "float") || p.countType == "double" {
					return bad()
				}
			} else {
				return bad()
			}
			if sizes[p.scalar] == 0 || p.countType != "" && sizes[p.countType] == 0 {
				return bad()
			}
			element := &elements[len(elements)-1]
			for _, old := range element.properties {
				if old.name == p.name {
					return bad()
				}
			}
			element.properties = append(element.properties, p)
		default:
			return bad()
		}
	}
	if vertices == 0 || format != "ascii" && format != "binary_little_endian" && format != "binary_big_endian" {
		return bad()
	}
	for _, element := range elements {
		if len(element.properties) == 0 {
			return bad()
		}
		if element.name == "vertex" {
			xyz := map[string]bool{}
			for _, p := range element.properties {
				if p.countType == "" {
					xyz[p.name] = true
				}
			}
			if !xyz["x"] || !xyz["y"] || !xyz["z"] {
				return bad()
			}
		}
	}
	data := body[end+skip:]
	offset := 0
	var order binary.ByteOrder = binary.LittleEndian
	if format == "binary_big_endian" {
		order = binary.BigEndian
	}
	var tokens []string
	if format == "ascii" {
		if len(data) > 32<<20 {
			return httpapi.Fail(413, "PAYLOAD_TOO_LARGE", "ASCII PLY 超出解析限制。")
		}
		tokens = strings.Fields(string(data))
	}
	read := func(typ string) (float64, error) {
		if format == "ascii" {
			if offset >= len(tokens) {
				return 0, errors.New("truncated PLY")
			}
			text := tokens[offset]
			offset++
			var value float64
			var err error
			if typ == "float" || typ == "float32" || typ == "double" || typ == "float64" {
				value, err = strconv.ParseFloat(text, 64)
			} else if strings.HasPrefix(typ, "u") {
				v, e := strconv.ParseUint(text, 10, sizes[typ]*8)
				value, err = float64(v), e
			} else {
				v, e := strconv.ParseInt(text, 10, sizes[typ]*8)
				value, err = float64(v), e
			}
			if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
				return 0, errors.New("invalid PLY scalar")
			}
			return value, nil
		}
		size := sizes[typ]
		if offset+size > len(data) {
			return 0, errors.New("truncated PLY")
		}
		raw := data[offset : offset+size]
		offset += size
		var value float64
		switch typ {
		case "float", "float32":
			value = float64(math.Float32frombits(order.Uint32(raw)))
		case "double", "float64":
			value = math.Float64frombits(order.Uint64(raw))
		case "char", "int8":
			value = float64(int8(raw[0]))
		case "uchar", "uint8":
			value = float64(raw[0])
		case "short", "int16":
			value = float64(int16(order.Uint16(raw)))
		case "ushort", "uint16":
			value = float64(order.Uint16(raw))
		case "int", "int32":
			value = float64(int32(order.Uint32(raw)))
		case "uint", "uint32":
			value = float64(order.Uint32(raw))
		}
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return 0, errors.New("invalid PLY scalar")
		}
		return value, nil
	}
	for _, element := range elements {
		for i := 0; i < element.count; i++ {
			for _, p := range element.properties {
				count := 1
				if p.countType != "" {
					n, e := read(p.countType)
					if e != nil || n < 0 || n > 1000000 {
						return bad()
					}
					count = int(n)
				}
				for j := 0; j < count; j++ {
					if _, e := read(p.scalar); e != nil {
						return bad()
					}
				}
			}
		}
	}
	if format == "ascii" {
		if offset != len(tokens) {
			return bad()
		}
	} else if offset != len(data) {
		return bad()
	}
	return nil
}
