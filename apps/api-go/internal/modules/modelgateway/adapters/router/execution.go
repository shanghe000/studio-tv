package router

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

func (c *Client) Submit(ctx context.Context, actor application.Actor, cmd application.Submission) (application.Invocation, error) {
	if _, err := uuid.Parse(cmd.IdempotencyKey); err != nil {
		return application.Invocation{}, &application.Fault{Code: "INVALID_REQUEST"}
	}
	body, err := json.Marshal(cmd.Request)
	if err != nil {
		return application.Invocation{}, &application.Fault{Code: "INVALID_REQUEST"}
	}
	var inv application.Invocation
	err = c.doHeaders(ctx, actor, http.MethodPost, "/v1/invocations", body, &inv, http.Header{"Idempotency-Key": []string{cmd.IdempotencyKey}}, true)
	if err != nil {
		return inv, err
	}
	if !validInvocation(inv) || inv.OperationRef != cmd.Request.OperationRef {
		return inv, &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	return inv, nil
}
func (c *Client) Invocation(ctx context.Context, actor application.Actor, ref string) (application.Invocation, error) {
	var inv application.Invocation
	if !refPattern.MatchString(ref) {
		return inv, &application.Fault{Code: "INVALID_REQUEST"}
	}
	if err := c.do(ctx, actor, http.MethodGet, "/v1/invocations/"+url.PathEscape(ref), nil, &inv); err != nil {
		return inv, err
	}
	if !validInvocation(inv) || inv.Ref != ref {
		return inv, &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	return inv, nil
}
func (c *Client) Cancel(ctx context.Context, actor application.Actor, ref string, cmd application.CancelRequest) (application.Invocation, error) {
	var inv application.Invocation
	if !refPattern.MatchString(ref) {
		return inv, &application.Fault{Code: "INVALID_REQUEST"}
	}
	body, _ := json.Marshal(cmd)
	if err := c.doHeaders(ctx, actor, http.MethodPost, "/v1/invocations/"+url.PathEscape(ref)+"/cancel", body, &inv, nil, true); err != nil {
		return inv, err
	}
	if !validInvocation(inv) || inv.Ref != ref {
		return inv, &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	return inv, nil
}
func (c *Client) Events(ctx context.Context, actor application.Actor, ref, after string) (application.EventPage, error) {
	var page application.EventPage
	if !refPattern.MatchString(ref) {
		return page, &application.Fault{Code: "INVALID_REQUEST"}
	}
	if after == "" {
		after = "0"
	}
	n, err := strconv.ParseInt(after, 10, 64)
	if err != nil || n < 0 || strconv.FormatInt(n, 10) != after {
		return page, &application.Fault{Code: "INVALID_REQUEST"}
	}
	if err = c.do(ctx, actor, http.MethodGet, "/v1/invocations/"+url.PathEscape(ref)+"/events?after="+after+"&limit=100", nil, &page); err != nil {
		return page, err
	}
	if page.ProtocolVersion != "1" || page.Items == nil {
		return page, &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	for _, e := range page.Items {
		if e.InvocationRef != ref || e.Sequence <= n || e.SchemaVersion != "1" || e.ObservedAt.IsZero() || !json.Valid(e.Data) {
			return page, &application.Fault{Code: "PROTOCOL_MISMATCH"}
		}
		n = e.Sequence
	}
	return page, nil
}
func validInvocation(inv application.Invocation) bool {
	if !refPattern.MatchString(inv.Ref) || !refPattern.MatchString(inv.OperationRef) || inv.CreatedAt.IsZero() || inv.UpdatedAt.Before(inv.CreatedAt) || inv.OutputParts == nil || inv.Artifacts == nil {
		return false
	}
	switch inv.State {
	case "QUEUED", "RUNNING", "UNKNOWN", "CANCEL_REQUESTED", "WAITING_TOOL", "SUCCEEDED", "FAILED", "CANCELED":
	default:
		return false
	}
	if inv.Progress != nil && (math.IsNaN(*inv.Progress) || math.IsInf(*inv.Progress, 0) || *inv.Progress < 0 || *inv.Progress > 1) {
		return false
	}
	if detail := inv.ProgressDetail; detail != nil {
		if detail.Phase == "" || len(detail.Phase) > 100 || strings.ContainsAny(detail.Phase, "\x00\r\n") || (detail.Scope != "SAMPLING" && detail.Scope != "TASK") || detail.CurrentStep != nil && *detail.CurrentStep < 0 || detail.TotalSteps != nil && *detail.TotalSteps < 1 || detail.CurrentStep != nil && detail.TotalSteps != nil && *detail.CurrentStep > *detail.TotalSteps {
			return false
		}
	}
	return true
}

// ArtifactContent uses the same actor proof and checks immutable content metadata.
// It never follows redirects or accepts a provider URL returned in model output.
func (c *Client) ArtifactContent(ctx context.Context, actor application.Actor, art application.Artifact) ([]byte, error) {
	bad := func() ([]byte, error) { return nil, &application.Fault{Code: "PROTOCOL_MISMATCH"} }
	if !refPattern.MatchString(actor.SubjectRef) || !refPattern.MatchString(art.Ref) || art.SizeBytes < 1 || art.SizeBytes > 512<<20 || len(art.SHA256) != 64 {
		return bad()
	}
	target := "/v1/artifacts/" + url.PathEscape(art.Ref) + "/content"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+target, nil)
	if err != nil {
		return bad()
	}
	var random [18]byte
	if _, err = rand.Read(random[:]); err != nil {
		return nil, &application.Fault{Code: "GATEWAY_UNAVAILABLE", Retryable: true}
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	nonce := base64.RawURLEncoding.EncodeToString(random[:])
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-Router-Client-App", c.clientApp)
	req.Header.Set("X-Router-Subject-Ref", actor.SubjectRef)
	req.Header.Set("X-Router-Actor-Timestamp", timestamp)
	req.Header.Set("X-Router-Actor-Nonce", nonce)
	req.Header.Set("X-Router-Actor-Signature", proofSignature(c.key, http.MethodGet, req.URL.RequestURI(), c.clientApp, actor.SubjectRef, timestamp, nonce, nil))
	res, err := c.http.Do(req)
	if err != nil {
		return nil, &application.Fault{Code: "GATEWAY_UNAVAILABLE", Retryable: true}
	}
	defer res.Body.Close()
	typ, _, err := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if err != nil || res.StatusCode != 200 || typ != art.MediaType || res.Header.Get("X-Models-Router-Version") != "1" {
		return bad()
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, art.SizeBytes+1))
	if err != nil || int64(len(body)) != art.SizeBytes {
		return bad()
	}
	sum := sha256.Sum256(body)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), art.SHA256) {
		return bad()
	}
	return body, nil
}

var _ application.ExecutionGateway = (*Client)(nil)
