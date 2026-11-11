package router

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"studiotv.local/service/api/internal/modules/modelgateway/application"
)

func (c *Client) LongformCapabilities(ctx context.Context, a application.Actor) (json.RawMessage, error) {
	var out json.RawMessage
	e := c.doHeadersLimit(ctx, a, "GET", "/v1/longform/capabilities", nil, &out, nil, false, 16<<20)
	return out, e
}
func (c *Client) LongformCreate(ctx context.Context, a application.Actor, body json.RawMessage) (json.RawMessage, error) {
	var out json.RawMessage
	e := c.doHeadersLimit(ctx, a, "POST", "/v1/longform/projects", body, &out, nil, true, 16<<20)
	return out, e
}
func (c *Client) LongformProject(ctx context.Context, a application.Actor, id string) (json.RawMessage, error) {
	if _, e := uuid.Parse(id); e != nil {
		return nil, &application.Fault{Code: "INVALID_REQUEST"}
	}
	var out json.RawMessage
	e := c.doHeadersLimit(ctx, a, "GET", "/v1/longform/projects/"+url.PathEscape(id), nil, &out, nil, false, 16<<20)
	return out, e
}
func (c *Client) LongformAction(ctx context.Context, a application.Actor, id string, body json.RawMessage) (json.RawMessage, error) {
	if _, e := uuid.Parse(id); e != nil {
		return nil, &application.Fault{Code: "INVALID_REQUEST"}
	}
	var out json.RawMessage
	e := c.doHeadersLimit(ctx, a, "POST", "/v1/longform/projects/"+url.PathEscape(id)+"/actions", body, &out, nil, true, 16<<20)
	return out, e
}
func (c *Client) LongformArtifact(ctx context.Context, a application.Actor, project, id string) (application.Artifact, []byte, error) {
	bad := func() (application.Artifact, []byte, error) {
		return application.Artifact{}, nil, &application.Fault{Code: "PROTOCOL_MISMATCH"}
	}
	if !refPattern.MatchString(a.SubjectRef) {
		return bad()
	}
	for _, v := range []string{project, id} {
		if _, e := uuid.Parse(v); e != nil {
			return bad()
		}
	}
	target := "/v1/longform/projects/" + url.PathEscape(project) + "/artifacts/" + url.PathEscape(id)
	req, e := http.NewRequestWithContext(ctx, "GET", c.baseURL+target, nil)
	if e != nil {
		return bad()
	}
	var random [18]byte
	if _, e = rand.Read(random[:]); e != nil {
		return bad()
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	nonce := base64.RawURLEncoding.EncodeToString(random[:])
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("X-Router-Client-App", c.clientApp)
	req.Header.Set("X-Router-Subject-Ref", a.SubjectRef)
	req.Header.Set("X-Router-Actor-Timestamp", ts)
	req.Header.Set("X-Router-Actor-Nonce", nonce)
	req.Header.Set("X-Router-Actor-Signature", proofSignature(c.key, "GET", target, c.clientApp, a.SubjectRef, ts, nonce, nil))
	res, e := c.http.Do(req)
	if e != nil {
		return application.Artifact{}, nil, &application.Fault{Code: "GATEWAY_UNAVAILABLE", Retryable: true}
	}
	defer res.Body.Close()
	typ, params, e := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if e != nil || len(params) > 0 || typ != "video/mp4" || res.StatusCode != 200 || res.Header.Get("X-Models-Router-Version") != "1" {
		return bad()
	}
	const limit = 1 << 30
	if res.ContentLength > limit {
		return bad()
	}
	body, e := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if e != nil || len(body) < 100 || len(body) > limit || res.ContentLength >= 0 && res.ContentLength != int64(len(body)) {
		return bad()
	}
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	if !strings.EqualFold(res.Header.Get("X-Checksum-SHA256"), digest) {
		return bad()
	}
	if !bytes.Contains(body[:min(len(body), 64)], []byte("ftyp")) {
		return bad()
	}
	kind := "VIDEO"
	return application.Artifact{Ref: id, MediaType: typ, SizeBytes: int64(len(body)), SHA256: digest, Kind: &kind}, body, nil
}

var _ application.LongformGateway = (*Client)(nil)
