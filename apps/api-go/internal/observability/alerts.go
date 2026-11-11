package observability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"

	"github.com/google/uuid"
)

type notification struct {
	title, id, operation, detail, key string
	actorID, actorName                string
	showActor                         bool
	result                            chan error
	controlContext                    context.Context
}

func notificationClient(config Config) (*http.Client, error) {
	if config.WebhookURL != "" {
		u, err := url.Parse(config.WebhookURL)
		if len(config.WebhookURL) > 2048 || err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "https" && !(u.Scheme == "http" && isLoopback(u.Hostname()))) {
			return nil, errors.New("invalid notification endpoint")
		}
	}
	client := &http.Client{}
	if config.HTTPClient != nil {
		*client = *config.HTTPClient
	} else {
		transport := http.DefaultTransport.(*http.Transport).Clone()
		transport.MaxIdleConns = 4
		transport.MaxIdleConnsPerHost = 2
		transport.MaxConnsPerHost = 2
		transport.ResponseHeaderTimeout = config.SendTimeout
		client.Transport = transport
	}
	client.Timeout = config.SendTimeout
	// A redirect must not carry a webhook capability URL or content elsewhere.
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return client, nil
}

func isLoopback(host string) bool { ip := net.ParseIP(host); return ip != nil && ip.IsLoopback() }

func (o *Observer) enqueue(message notification) error {
	if o.config.WebhookURL == "" {
		return ErrDisabled
	}
	if message.controlContext != nil && message.controlContext.Err() != nil {
		return message.controlContext.Err()
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closing {
		return ErrClosed
	}
	now := o.config.Clock()
	if expiry, exists := o.windows[message.key]; exists && now.Before(expiry) {
		o.suppressed.Add(1)
		return ErrRateLimited
	}
	if len(o.windows) >= o.config.MaxDedupKeys {
		for key, expiry := range o.windows {
			if !now.Before(expiry) {
				delete(o.windows, key)
			}
		}
		if len(o.windows) >= o.config.MaxDedupKeys {
			o.dropped.Add(1)
			o.logger.Warn("notification dropped", "reason", "DEDUP_CAPACITY")
			return ErrQueueFull
		}
	}
	select {
	case o.queue <- message:
		o.windows[message.key] = now.Add(o.config.RateWindow)
		o.enqueued.Add(1)
		return nil
	default:
		o.dropped.Add(1)
		o.logger.Warn("notification dropped", "reason", "QUEUE_FULL")
		return ErrQueueFull
	}
}

// KeyEvent accepts a bounded symbolic event code, never free-form text or
// request data. It shares the same bounded delivery queue and deduplication.
func (o *Observer) KeyEvent(ctx context.Context, eventCode string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	code := safeCode(eventCode)
	if code == "" {
		return errors.New("invalid event code")
	}
	id := LogID(ctx)
	if id == "" {
		id = uuid.NewString()
	}
	o.logger.InfoContext(ctx, "key event", "log_id", id, "request_id", id, "event_code", code)
	return o.enqueue(notification{title: "Studio TV 关键事件", id: id, operation: code, detail: "event_code=" + code, key: "KEY_EVENT|" + code})
}

// TestNotification sends one fixed, privacy-safe acceptance message. It is an
// explicit operator action; New and Middleware never send startup test messages.
// Returning nil proves Feishu accepted it, not merely that it entered the queue.
func (o *Observer) Check(ctx context.Context) error { return o.TestNotification(ctx) }

func (o *Observer) TestNotification(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	result := make(chan error, 1)
	message := notification{title: "Studio TV 日志系统验收", id: uuid.NewString(), operation: "LOG_SYSTEM_ACCEPTANCE", detail: "结构化日志与告警通道已接入；此消息为一次验收通知。", key: "KEY_EVENT|LOG_SYSTEM_ACCEPTANCE", result: result, controlContext: ctx}
	if err := o.enqueue(message); err != nil {
		return err
	}
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (o *Observer) run() {
	defer close(o.done)
	if o.config.HTTPClient == nil {
		defer o.client.CloseIdleConnections()
	}
	for message := range o.queue {
		var err error
		if o.workerContext.Err() != nil {
			err = ErrClosed
		} else if message.controlContext != nil && message.controlContext.Err() != nil {
			err = message.controlContext.Err()
		} else {
			err = o.deliver(message)
		}
		if err == nil {
			o.sent.Add(1)
			o.logger.Info("notification delivered", "log_id", message.id, "event", "FEISHU_ACKNOWLEDGED")
		} else {
			o.failed.Add(1)
			// Never emit URL-bearing net/http errors or webhook response bodies.
			o.logger.Warn("notification delivery failed", "log_id", message.id, "reason", "DELIVERY_FAILED")
		}
		if message.result != nil {
			message.result <- err
		}
	}
}

func (o *Observer) deliver(message notification) (err error) {
	defer func() {
		if recover() != nil {
			err = ErrDelivery
		}
	}()
	lines := [][]postElement{
		{{Tag: "text", Text: "来源："}, {Tag: "text", Text: o.config.Environment}},
	}
	if message.showActor {
		name := message.actorName
		if name == "" {
			name = "姓名暂不可用"
		}
		if message.actorID == "" {
			name = "未知操作人"
		}
		lines = append(lines, []postElement{{Tag: "text", Text: "操作人："}, {Tag: "text", Text: name}})
		if message.actorID != "" {
			lines = append(lines, []postElement{{Tag: "text", Text: "用户ID："}, {Tag: "text", Text: message.actorID}})
		}
	}
	lines = append(lines, [][]postElement{
		{{Tag: "text", Text: "日志ID："}, {Tag: "text", Text: message.id}},
		{{Tag: "text", Text: "接口："}, {Tag: "text", Text: message.operation}},
		{{Tag: "text", Text: "信息："}, {Tag: "text", Text: message.detail}},
		{{Tag: "text", Text: "服务器："}, {Tag: "text", Text: o.config.ServerName}},
	}...)
	content := postContent{Post: map[string]postLocale{"zh_cn": {Title: message.title, Content: lines}}}
	body, err := json.Marshal(struct {
		MsgType string      `json:"msg_type"`
		Content postContent `json:"content"`
	}{"post", content})
	if err != nil {
		return ErrDelivery
	}
	ctx, cancel := context.WithTimeout(o.workerContext, o.config.SendTimeout)
	defer cancel()
	if message.controlContext != nil {
		// Explicit operator checks follow their caller's cancellation. Normal
		// request alerts deliberately use only the worker-owned context.
		stop := context.AfterFunc(message.controlContext, cancel)
		defer stop()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, o.config.WebhookURL, bytes.NewReader(body))
	if err != nil {
		return ErrDelivery
	}
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	response, err := o.client.Do(request)
	if response != nil && response.Body != nil {
		defer response.Body.Close()
	}
	if err != nil || response == nil || response.StatusCode != http.StatusOK {
		return ErrDelivery
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 4097))
	if err != nil || len(raw) > 4096 {
		return ErrDelivery
	}
	var reply struct {
		Code   *int `json:"code"`
		Status *int `json:"StatusCode"`
	}
	if json.Unmarshal(raw, &reply) != nil || (reply.Code == nil && reply.Status == nil) || (reply.Code != nil && *reply.Code != 0) || (reply.Status != nil && *reply.Status != 0) {
		return ErrDelivery
	}
	return nil
}

type postContent struct {
	Post map[string]postLocale `json:"post"`
}
type postLocale struct {
	Title   string          `json:"title"`
	Content [][]postElement `json:"content"`
}
type postElement struct {
	Tag  string `json:"tag"`
	Text string `json:"text"`
}
