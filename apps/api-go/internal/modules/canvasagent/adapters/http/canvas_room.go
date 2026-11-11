package http

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"studiotv.local/service/api/internal/canvaswake"
	"studiotv.local/service/api/internal/collaboration"
	"studiotv.local/service/api/internal/httpapi"
	"studiotv.local/service/api/internal/modules/canvasagent/application"
	"studiotv.local/service/api/internal/modules/canvasagent/domain"
)

const roomProtocol = "studiotv.canvas.v1"
const roomFrameLimit = 2*1024*1024 + 4096

type verifyBearer func(context.Context, string) (httpapi.Identity, error)
type canvasRoom struct {
	stream  *projectStream
	verify  verifyBearer
	write   http.Handler
	origins []string
	joining chan struct{}
}

// The handshake is intentionally outside the Bearer-header middleware: the
// browser can attach its credential only in the first private socket frame.
// The same authentication + capability check is repeated before every write
// and after every authorized event read, before delivery.
func RegisterLiveRoom(public, protected chi.Router, service *application.LiveService, protect Protect, hub *canvaswake.Hub, origins []string, verify verifyBearer, write httpapi.Handler, middleware ...func(http.Handler) http.Handler) error {
	if public == nil || verify == nil || write == nil || hub == nil {
		return errors.New("missing canvas room dependencies")
	}
	stream := newProjectStream(service)
	stream.wake = hub
	// Mixed deployments share one delivery budget across SSE and WebSocket.
	if err := registerLiveRoutes(protected, stream, protect, true); err != nil {
		return err
	}
	// Apply the same diagnostic middleware to each logical write as to an HTTP
	// operation. The room stays open across multiple independent request IDs.
	var writer http.Handler = httpapi.Wrap(func(w http.ResponseWriter, r *http.Request) error {
		proof := httpapi.LiveAuthorizationFrom(r)
		if proof.Revalidate == nil {
			return httpapi.Fail(401, "UNAUTHENTICATED", "画布连接身份无效。")
		}
		id, err := proof.Revalidate(r.Context())
		if err != nil {
			return err
		}
		return write(w, httpapi.WithIdentity(r, id))
	})
	for i := len(middleware) - 1; i >= 0; i-- {
		writer = middleware[i](writer)
	}
	room := &canvasRoom{stream: stream, verify: verify, write: writer, origins: origins, joining: make(chan struct{}, 32)}
	public.MethodFunc("GET", "/api/v2/projects/{projectId}/canvas-room", httpapi.Wrap(room.serve))
	return nil
}

type joinMessage struct {
	Type    string   `json:"type"`
	Token   string   `json:"token"`
	Formats []string `json:"formats,omitempty"`
	After   string   `json:"after"`
}

type roomWrite struct {
	compact      []byte
	binding      roomBinding
	Type         string          `json:"type"`
	RequestID    string          `json:"requestId"`
	Body         json.RawMessage `json:"body"`
	Proof        string          `json:"proof"`
	Lease        string          `json:"lease"`
	BaseRevision int64           `json:"baseRevision,omitempty"`
}

type roomResponse struct {
	Bound     bool            `json:"bound,omitempty"`
	Type      string          `json:"type"`
	RequestID string          `json:"requestId,omitempty"`
	Status    int             `json:"status"`
	ETag      string          `json:"etag,omitempty"`
	Body      json.RawMessage `json:"body"`
}

func roomDecode(data []byte, value any) error {
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(value); err != nil {
		return err
	}
	if d.Decode(new(any)) != io.EOF {
		return errors.New("trailing room data")
	}
	return nil
}

func writeMessage(ctx context.Context, c *websocket.Conn, msg any) error {
	part, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return c.Write(part, websocket.MessageText, raw)
}

func (room *canvasRoom) serve(w http.ResponseWriter, r *http.Request) error {
	project := chi.URLParam(r, "projectId")
	if !domain.ValidCommandID(project) || r.URL.RawQuery != "" {
		return httpapi.Fail(400, "VALIDATION_FAILED", "画布房间地址无效。")
	}
	if len(r.Header.Values("Origin")) != 1 || !slices.Contains(room.origins, r.Header.Get("Origin")) {
		return httpapi.Fail(403, "ORIGIN_FORBIDDEN", "画布连接来源不受信任。")
	}
	if len(r.Header.Values("Sec-WebSocket-Protocol")) != 1 || r.Header.Get("Sec-WebSocket-Protocol") != roomProtocol {
		return httpapi.Fail(400, "CANVAS_ROOM_PROTOCOL", "画布连接协议不匹配。")
	}
	select {
	case room.joining <- struct{}{}:
	default:
		return httpapi.Retry(429, "CANVAS_ROOM_LIMIT", "画布连接较多，请稍后重试。")
	}
	joining := true
	defer func() {
		if joining {
			<-room.joining
		}
	}()
	// Origin was matched exactly against the deployment allowlist above.
	socket, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{roomProtocol}, InsecureSkipVerify: true,
		CompressionMode: websocket.CompressionNoContextTakeover, CompressionThreshold: 256})
	if err != nil {
		return nil
	} // handshake error already written
	defer socket.CloseNow()
	socket.SetReadLimit(16 * 1024)
	joinCtx, finish := context.WithTimeout(r.Context(), 5*time.Second)
	defer finish()
	kind, data, err := socket.Read(joinCtx)
	if err != nil {
		return nil
	}
	var join joinMessage
	if kind != websocket.MessageText || roomDecode(data, &join) != nil || join.Type != "join" || len(join.Token) < 1 || len(join.Token) > 12288 || strings.ContainsAny(join.Token, " \t\r\n") {
		roomError(r, socket, httpapi.Fail(400, "CANVAS_ROOM_JOIN_INVALID", "画布连接请求无效。"))
		return nil
	}
	after, err := domain.ParseEventCursor(join.After)
	if err != nil {
		roomError(r, socket, liveHTTPError(err))
		return nil
	}
	identity, err := room.verify(joinCtx, join.Token)
	if err != nil {
		roomError(r, socket, err)
		return nil
	}
	deadline, err := verifiedDeadline(identity)
	if err != nil {
		roomError(r, socket, err)
		return nil
	}
	if !room.stream.acquire(identity.UserID) {
		roomError(r, socket, httpapi.Retry(429, "CANVAS_ROOM_LIMIT", "当前账号打开的画布连接已达上限。"))
		return nil
	}
	defer room.stream.release(identity.UserID)
	<-room.joining
	joining = false
	finish()
	ctx, cancel := context.WithDeadline(r.Context(), earlier(deadline, time.Now().Add(15*time.Minute)))
	defer cancel()
	revalidate := func(op context.Context) error {
		fresh, err := room.verify(op, join.Token)
		if err != nil {
			return err
		}
		if !sameStreamIdentity(identity, fresh) {
			return httpapi.Fail(401, "STREAM_IDENTITY_CHANGED", "画布连接身份已变化。")
		}
		_, err = verifiedDeadline(fresh)
		return err
	}

	return room.run(ctx, r, socket, project, after, identity, revalidate, slices.Contains(join.Formats, moveFormat))
}
func readRoomWrites(ctx context.Context, socket *websocket.Conn, moves bool) <-chan roomWrite {
	socket.SetReadLimit(roomFrameLimit) // counted after permessage-deflate decoding
	writes := make(chan roomWrite)
	go func() {
		defer close(writes)
		for {
			kind, raw, err := socket.Read(ctx)
			if err != nil {
				return
			}
			var msg roomWrite
			if moves && kind == websocket.MessageBinary {
				msg.compact = raw
			} else if kind != websocket.MessageText || roomDecode(raw, &msg) != nil || msg.Type != "write" || !domain.ValidCommandID(msg.RequestID) {
				return
			}
			select {
			case writes <- msg:
			case <-ctx.Done():
				return
			}
		}
	}()
	return writes
}
func (room *canvasRoom) authorizedEvents(ctx context.Context, actor, project string, after int64, revalidate func(context.Context) error) ([]roomEvent, int64, bool, error) {
	op, end := context.WithTimeout(ctx, 5*time.Second)
	defer end()
	page, err := room.stream.service.Events(op, actor, project, after, domain.MaxEventPageSize)
	if err != nil {
		return nil, after, false, err
	}
	frames, last, err := streamPage(page, project, after, domain.MaxEventPageSize)
	if err != nil {
		return nil, after, false, err
	}
	if err = room.stream.promoteDelta(op, actor, project, page, frames); err != nil {
		return nil, after, false, err
	}
	if err = revalidate(op); err != nil {
		return nil, after, false, err
	}
	return frames, last, page.HasMore, nil
}

func (room *canvasRoom) run(ctx context.Context, r *http.Request, socket *websocket.Conn, project string, after int64, identity httpapi.Identity, revalidate func(context.Context) error, moves bool) error {
	writes := readRoomWrites(ctx, socket, moves)
	var bound *roomBinding
	wake, leave := room.stream.wake.Subscribe(project)
	defer leave()
	poll := time.NewTicker(5 * time.Second)
	defer poll.Stop()
	ready := false
	checkHead := true
	for ctx.Err() == nil {
		if checkHead {
			frames, last, more, readErr := room.authorizedEvents(ctx, identity.UserID, project, after, revalidate)
			if readErr != nil {
				roomError(r, socket, liveHTTPError(readErr))
				return nil
			}
			if !ready {
				hello := map[string]any{"type": "ready"}
				if moves {
					hello["formats"] = []string{moveFormat}
				}
				if writeMessage(ctx, socket, hello) != nil {
					return nil
				}
				ready = true
			}
			for _, frame := range frames {
				if writeRoomEvent(ctx, socket, project, frame, moves) != nil {
					return nil
				}
			}
			after = last
			if more {
				continue
			}
			checkHead = false
		}
		select {
		case <-ctx.Done():
			return nil
		case <-wake:
			checkHead = true
		case <-poll.C:
			// A keepalive reaches proxies even when the project has no changes.
			if writeMessage(ctx, socket, map[string]string{"type": "heartbeat"}) != nil {
				return nil
			}
			checkHead = true
		case msg, ok := <-writes:
			if !ok {
				return nil
			}
			compact := msg.compact != nil
			if compact {
				var err error
				msg, err = decodeMove(msg.compact, bound)
				if err != nil {
					roomError(r, socket, httpapi.Fail(400, "CANVAS_MOVE_INVALID", "画布移动请求格式无效。"))
					return nil
				}
			}
			op, end := context.WithTimeout(ctx, 12*time.Second)
			response := room.submit(op, r, identity, msg, revalidate)
			end()
			// Only a successful write can pin this socket's immutable binding.
			// An expired lease or another caller can never replace or extend it.
			if compact && response.Status == 200 {
				if bound == nil {
					b := msg.binding
					bound = &b
				}
				response.Bound = *bound == msg.binding
			}
			if response.Status == 401 {
				response.Type = "error"
			}
			if writeMessage(ctx, socket, response) != nil || response.Type == "error" {
				return nil
			}
		}
	}
	return nil
}

// The canonical handler sees the same authenticated identity, original batch,
// page credentials and delta negotiation as HTTP. Never treat a socket as a
// write lease, or broadcast unverified client operations to subscribers.
func (room *canvasRoom) submit(ctx context.Context, handshake *http.Request, id httpapi.Identity, msg roomWrite, revalidate func(context.Context) error) roomResponse {
	var body struct {
		ClientID string `json:"clientId"`
	}
	_ = json.Unmarshal(msg.Body, &body)
	req, _ := http.NewRequestWithContext(ctx, "POST", "/api/v2/projects/"+chi.URLParam(handshake, "projectId")+"/canvas-operations", bytes.NewReader(msg.Body))
	route := chi.NewRouteContext()
	route.URLParams.Add("projectId", chi.URLParam(handshake, "projectId"))
	route.RoutePatterns = []string{"/api/v2/projects/{projectId}/canvas-operations"}
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, route))
	req = httpapi.NewRoomWriteRequest(req)
	req = httpapi.WithLiveAuthorization(req, httpapi.LiveAuthorization{Revalidate: func(ctx context.Context) (httpapi.Identity, error) { return id, revalidate(ctx) }})
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(collaboration.CanvasSessionHeader, body.ClientID)
	req.Header.Set(collaboration.CanvasProofHeader, msg.Proof)
	req.Header.Set(collaboration.CanvasLeaseHeader, msg.Lease)
	if msg.BaseRevision > 0 {
		req.Header.Set("X-STUDIO-Canvas-Receipt", "delta-v1")
		req.Header.Set("X-STUDIO-Canvas-Base", strconv.FormatInt(msg.BaseRevision, 10))
	}
	req = req.WithContext(collaboration.ContextWithCanvasProof(req))
	req = req.WithContext(collaboration.WithCanvasLeaseRequest(req.Context(), id, body.ClientID))
	reply := newRoomReply()
	room.write.ServeHTTP(reply, req)
	return roomResponse{Type: "receipt", RequestID: msg.RequestID, Status: reply.status, ETag: reply.Header().Get("ETag"), Body: reply.Bytes()}
}

type roomReply struct {
	bytes.Buffer
	header http.Header
	status int
}

func newRoomReply() *roomReply           { return &roomReply{header: make(http.Header), status: 200} }
func (w *roomReply) Header() http.Header { return w.header }
func (w *roomReply) WriteHeader(s int)   { w.status = s }

func roomError(r *http.Request, c *websocket.Conn, err error) {
	reply := newRoomReply()
	httpapi.WriteError(reply, r, err)
	_ = writeMessage(r.Context(), c, roomResponse{Type: "error", Status: reply.status, Body: reply.Bytes()})
}

func writeRoomEvent(ctx context.Context, c *websocket.Conn, project string, f roomEvent, moves bool) error {
	if moves {
		if binary := compactMoveEvent(project, f); binary != nil {
			part, end := context.WithTimeout(ctx, 5*time.Second)
			defer end()
			return c.Write(part, websocket.MessageBinary, binary)
		}
	}
	return writeMessage(ctx, c, f)
}
