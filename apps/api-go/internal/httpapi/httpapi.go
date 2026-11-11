package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/google/uuid"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"
)

type Detail struct {
	Field   string `json:"field"`
	Code    string `json:"code"`
	Message string `json:"message"`
}
type Error struct {
	Status    int      `json:"-"`
	Code      string   `json:"code"`
	Message   string   `json:"message"`
	RequestID string   `json:"requestId"`
	Retryable bool     `json:"retryable"`
	Details   []Detail `json:"details"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }
func Fail(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message, Details: []Detail{}}
}
func Retry(status int, code, message string) *Error {
	e := Fail(status, code, message)
	e.Retryable = true
	return e
}

type Handler func(http.ResponseWriter, *http.Request) error

func Wrap(h Handler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			WriteError(w, r, err)
		}
	}
}
func JSON(w http.ResponseWriter, status int, value any) error {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	return json.NewEncoder(w).Encode(value)
}
func OK(w http.ResponseWriter, r *http.Request, status int, data any) error {
	return JSON(w, status, map[string]any{"code": 0, "message": "OK", "requestId": RequestID(r), "data": data})
}
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	var api *Error
	if !errors.As(err, &api) {
		// Arbitrary adapter errors may contain upstream URLs, SQL or credentials.
		// The request logger records the route template and fixed error code.
		slog.Error("request failed", "log_id", RequestID(r), "error_code", "INTERNAL_ERROR")
		api = Fail(500, "INTERNAL_ERROR", "服务器暂时无法完成请求。")
	}
	RecordError(r, api.Code)
	copy := *api
	copy.RequestID = RequestID(r)
	if copy.Details == nil {
		copy.Details = []Detail{}
	}
	if copy.Retryable {
		w.Header().Set("Retry-After", "5")
	}
	_ = JSON(w, copy.Status, &copy)
}

type contextKey int

const requestIDKey contextKey = 0
const identityKey contextKey = 1
const liveAuthorizationKey contextKey = 2
const diagnosticKey contextKey = 3
const roomWriteKey contextKey = 4

// Give each WebSocket operation a server-generated correlation identity and
// an independent failure diagnostic. These values never come from the frame.
func NewRoomWriteRequest(r *http.Request) *http.Request {
	ctx := context.WithValue(r.Context(), requestIDKey, uuid.NewString())
	ctx = context.WithValue(ctx, diagnosticKey, &requestDiagnostic{})
	return r.WithContext(context.WithValue(ctx, roomWriteKey, true))
}
func IsRoomWrite(r *http.Request) bool { return r.Context().Value(roomWriteKey) == true }

func RequestID(r *http.Request) string { v, _ := r.Context().Value(requestIDKey).(string); return v }

type requestDiagnostic struct {
	mu   sync.Mutex
	code string
}

// RequestContext precedes observability and CORS so rejected preflights and
// unknown routes share the same trusted server-generated correlation ID.
func RequestContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r = ensureRequestContext(w, r)
		next.ServeHTTP(w, r)
	})
}

func ensureRequestContext(w http.ResponseWriter, r *http.Request) *http.Request {
	rid := RequestID(r)
	if _, err := uuid.Parse(rid); err != nil {
		rid = uuid.NewString()
		r = r.WithContext(context.WithValue(r.Context(), requestIDKey, rid))
	}
	if _, ok := r.Context().Value(diagnosticKey).(*requestDiagnostic); !ok {
		r = r.WithContext(context.WithValue(r.Context(), diagnosticKey, &requestDiagnostic{}))
	}
	w.Header().Set("X-Request-Id", rid)
	return r
}

// RecordError exposes only bounded machine codes, never a human error message.
func RecordError(r *http.Request, code string) {
	diagnostic, ok := r.Context().Value(diagnosticKey).(*requestDiagnostic)
	if !ok {
		return
	}
	if len(code) < 1 || len(code) > 64 {
		code = "INTERNAL_ERROR"
	}
	for _, c := range code {
		if !(c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_') {
			code = "INTERNAL_ERROR"
			break
		}
	}
	diagnostic.mu.Lock()
	diagnostic.code = code
	diagnostic.mu.Unlock()
}

func ErrorCode(r *http.Request) string {
	diagnostic, ok := r.Context().Value(diagnosticKey).(*requestDiagnostic)
	if !ok {
		return ""
	}
	diagnostic.mu.Lock()
	defer diagnostic.mu.Unlock()
	return diagnostic.code
}

type Identity struct {
	UserID             string
	SessionID          string
	IPACIssuer         string
	IPACSubjectID      string
	IPACSessionID      string
	IPACSessionVersion uint64
	AccessExpiresAt    time.Time `json:"-"`
	AccessIssuedAt     time.Time `json:"-"`
	SessionExpiresAt   time.Time `json:"-"`
}

// LiveAuthorization is supplied only by the composition root after initial
// authentication. A stream reuses the original request proof, not caller IDs.
type LiveAuthorization struct {
	Revalidate func(context.Context) (Identity, error)
}

func WithLiveAuthorization(r *http.Request, value LiveAuthorization) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), liveAuthorizationKey, value))
}
func LiveAuthorizationFrom(r *http.Request) LiveAuthorization {
	value, _ := r.Context().Value(liveAuthorizationKey).(LiveAuthorization)
	return value
}

type Authenticator interface {
	Authenticate(context.Context, *http.Request) (Identity, error)
}
type AuthFunc func(context.Context, *http.Request) (Identity, error)

func (f AuthFunc) Authenticate(c context.Context, r *http.Request) (Identity, error) { return f(c, r) }
func IdentityFrom(r *http.Request) Identity {
	v, _ := r.Context().Value(identityKey).(Identity)
	return v
}

// WithIdentity is used only after a server-side session has been verified.
// Signed media requests carry a local session reference, never caller-supplied IPAC claims.
func WithIdentity(r *http.Request, identity Identity) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), identityKey, identity))
}
func RequireAuth(auth Authenticator, next Handler) http.HandlerFunc {
	return Wrap(func(w http.ResponseWriter, r *http.Request) error {
		if auth == nil {
			return Fail(401, "UNAUTHENTICATED", "请使用统一飞书认证登录。")
		}
		identity, err := auth.Authenticate(r.Context(), r)
		if err != nil {
			return err
		}
		if identity.UserID == "" {
			return Fail(401, "UNAUTHENTICATED", "登录状态无效。")
		}
		if _, ok := r.Header["X-Team-Id"]; ok {
			return Fail(403, "FORBIDDEN", "团队空间尚未启用。")
		}
		return next(w, r.WithContext(context.WithValue(r.Context(), identityKey, identity)))
	})
}
func Base(allowed []string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r = ensureRequestContext(w, r)
			w.Header().Set("X-Content-Type-Options", "nosniff")
			if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/storage/") {
				w.Header().Set("Cache-Control", "no-store")
			}
			origin := r.Header.Get("Origin")
			good := origin == ""
			for _, v := range allowed {
				if v == origin {
					good = true
				}
			}
			if origin != "" {
				w.Header().Add("Vary", "Origin")
				if good {
					w.Header().Set("Access-Control-Allow-Origin", origin)
					w.Header().Set("Access-Control-Allow-Credentials", "true")
					w.Header().Set("Access-Control-Expose-Headers", "ETag,Location,X-Request-Id,X-Log-ID,log_id,Content-Range,Accept-Ranges,X-STUDIO-Canvas-Update,X-STUDIO-Canvas-Room")
				}
			}
			if !good {
				WriteError(w, r, Fail(403, "ORIGIN_FORBIDDEN", "请求来源不受信任。"))
				return
			}
			if r.Method == "OPTIONS" {
				w.Header().Set("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-CSRF-Token,X-Team-Id,X-Workspace-Id,X-STUDIO-Canvas-Session,X-STUDIO-Canvas-Proof,X-STUDIO-Canvas-Lease,Idempotency-Key,If-Match,Last-Event-ID,Range,X-Checksum-Sha256")
				w.WriteHeader(204)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
func Decode(w http.ResponseWriter, r *http.Request, out any) error {
	return DecodeLimit(w, r, out, 1024*1024)
}
func DecodeLimit(w http.ResponseWriter, r *http.Request, out any, limit int64) error {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return Fail(415, "CONTENT_TYPE_UNSUPPORTED", "接口需要 application/json。")
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	dec.DisallowUnknownFields()
	dec.UseNumber()
	if err = dec.Decode(out); err != nil {
		var max *http.MaxBytesError
		if errors.As(err, &max) {
			return Fail(413, "PAYLOAD_TOO_LARGE", "JSON请求超过大小限制。")
		}
		if strings.HasPrefix(err.Error(), "json: unknown field ") {
			return Fail(400, "UNKNOWN_FIELD", "请求包含未知字段。")
		}
		return Fail(400, "MALFORMED_REQUEST", "请求JSON格式无效。")
	}
	var extra any
	if err = dec.Decode(&extra); err != io.EOF {
		var max *http.MaxBytesError
		if errors.As(err, &max) {
			return Fail(413, "PAYLOAD_TOO_LARGE", "JSON请求超过大小限制。")
		}
		return Fail(400, "MALFORMED_REQUEST", "只允许一个JSON值。")
	}
	return nil
}
func RandomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return fmt.Sprintf("%x", b)
}

// Opaque browser grants are credentials; logs retain routing context only.
func logPath(path string) string {
	const prefix = "/api/v2/studio/preview/"
	if strings.HasPrefix(path, prefix) {
		parts := strings.Split(strings.TrimPrefix(path, prefix), "/")
		if len(parts) > 1 {
			parts[1] = "[grant]"
			return prefix + strings.Join(parts, "/")
		}
	}
	return path
}
