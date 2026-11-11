package httpclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"studio.example.invalid/maintainer/ipac-client-kit/clienterr"
)

const maxResponseBytes = 2 << 20

type Config struct {
	BaseURL           string
	ClientID          string
	ClientSecret      string
	HTTPClient        *http.Client
	RequestTimeout    time.Duration
	AllowInsecureHTTP bool
}

type Client struct {
	baseURL      *url.URL
	clientID     string
	clientSecret string
	httpClient   *http.Client
	timeout      time.Duration
}

func New(config Config) (*Client, error) {
	baseURL, err := parseBaseURL(config.BaseURL, config.AllowInsecureHTTP)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(config.ClientID) == "" {
		return nil, errors.New("ipac client ID is required")
	}
	if config.ClientSecret == "" {
		return nil, errors.New("ipac client secret is required")
	}
	timeout := config.RequestTimeout
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	client := config.HTTPClient
	if client == nil {
		client = &http.Client{}
	} else {
		clone := *client
		client = &clone
	}
	if client.CheckRedirect == nil {
		client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		}
	}
	return &Client{
		baseURL:      baseURL,
		clientID:     strings.TrimSpace(config.ClientID),
		clientSecret: config.ClientSecret,
		httpClient:   client,
		timeout:      timeout,
	}, nil
}

func (c *Client) DoJSON(ctx context.Context, operation, method, path string, input, output any) error {
	body, err := json.Marshal(input)
	if err != nil {
		return fmt.Errorf("%s: encode request: %w", operation, err)
	}
	requestCtx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	endpoint := *c.baseURL
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/" + strings.TrimLeft(path, "/")
	request, err := http.NewRequestWithContext(requestCtx, method, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("%s: create request: %w", operation, err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/json")
	request.SetBasicAuth(c.clientID, c.clientSecret)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return &clienterr.UpstreamError{Operation: operation, Message: "IPAC is unavailable", Cause: err}
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return &clienterr.UpstreamError{Operation: operation, StatusCode: response.StatusCode, Message: "read IPAC response", Cause: err}
	}
	if len(responseBody) > maxResponseBytes {
		return &clienterr.UpstreamError{Operation: operation, StatusCode: response.StatusCode, Message: "IPAC response exceeds size limit"}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return decodeError(operation, response, responseBody)
	}
	if output == nil || len(bytes.TrimSpace(responseBody)) == 0 {
		return nil
	}
	if err := json.Unmarshal(responseBody, output); err != nil {
		return &clienterr.UpstreamError{
			Operation: operation, StatusCode: response.StatusCode,
			Message: "decode IPAC response", LogID: logID(response), Cause: err,
		}
	}
	return nil
}

func parseBaseURL(raw string, allowInsecure bool) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, fmt.Errorf("parse IPAC base URL: %w", err)
	}
	if parsed.Scheme == "" || parsed.Host == "" {
		return nil, errors.New("IPAC base URL must be absolute")
	}
	if parsed.Scheme != "https" && !(allowInsecure && parsed.Scheme == "http") {
		return nil, errors.New("IPAC base URL must use HTTPS; enable insecure HTTP only for local development")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("IPAC base URL cannot contain credentials, query, or fragment")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed, nil
}

func decodeError(operation string, response *http.Response, body []byte) error {
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			LogID   string `json:"log_id"`
		} `json:"error"`
		Code    string `json:"code"`
		Message string `json:"message"`
		Detail  string `json:"detail"`
		LogID   string `json:"log_id"`
	}
	_ = json.Unmarshal(body, &envelope)
	code := firstNonEmpty(envelope.Error.Code, envelope.Code)
	message := firstNonEmpty(envelope.Error.Message, envelope.Message, envelope.Detail, http.StatusText(response.StatusCode))
	return &clienterr.UpstreamError{
		Operation: operation, StatusCode: response.StatusCode, Code: code,
		Message: message, LogID: firstNonEmpty(envelope.Error.LogID, envelope.LogID, logID(response)),
	}
}

func logID(response *http.Response) string {
	return firstNonEmpty(response.Header.Get("X-Log-Id"), response.Header.Get("X-Request-Id"))
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
