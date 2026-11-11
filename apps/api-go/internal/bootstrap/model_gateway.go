package bootstrap

import (
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"studiotv.local/service/api/internal/modules/modelgateway/adapters/router"
	"studiotv.local/service/api/internal/modules/modelgateway/application"
	"studiotv.local/service/api/internal/telemetry"
)

// ModelGatewayFromEnv constructs the service-authenticated Router client.
// Product execution has a separate explicit deployment policy; configuring
// credentials alone never enables a real model.
func ModelGatewayFromEnv(metrics ...*telemetry.Server) (application.Gateway, error) {
	if len(metrics) > 1 {
		return nil, errors.New("one models router metrics registry is permitted")
	}
	var server *telemetry.Server
	if len(metrics) == 1 {
		server = metrics[0]
	}
	transport := upstreamTransport(server, "models_router", nil)
	return modelGateway(os.Getenv, transport)
}

func modelGateway(get func(string) string, transports ...http.RoundTripper) (application.Gateway, error) {
	if len(transports) > 1 {
		return nil, errors.New("one models router transport is permitted")
	}
	if get == nil {
		return nil, errors.New("models router configuration")
	}
	origin := get("MODELS_ROUTER_BASE_URL")
	configured := origin != ""
	for _, key := range []string{"MODELS_ROUTER_CLIENT_APP", "MODELS_ROUTER_SERVICE_TOKEN", "MODELS_ROUTER_SERVICE_TOKEN_FILE", "MODELS_ROUTER_ACTOR_SIGNING_KEY_B64", "MODELS_ROUTER_ACTOR_SIGNING_KEY_B64_FILE", "MODELS_ROUTER_TIMEOUT_SECONDS"} {
		configured = configured || get(key) != ""
	}
	if !configured {
		return application.Unconfigured{}, nil
	}
	if origin == "" {
		return nil, errors.New("models router origin is required when configured")
	}
	read := func(key string) (string, error) {
		value, path := get(key), get(key+"_FILE")
		if value != "" && path != "" {
			return "", errors.New("models router secret configured twice")
		}
		if path != "" {
			file, err := os.Open(path)
			if err != nil {
				return "", errors.New("models router secret file cannot be read")
			}
			defer file.Close()
			info, err := file.Stat()
			if err != nil || !info.Mode().IsRegular() || info.Size() > 8192 {
				return "", errors.New("models router secret file is invalid")
			}
			data, err := io.ReadAll(io.LimitReader(file, 8193))
			if err != nil || len(data) > 8192 {
				return "", errors.New("models router secret file cannot be read")
			}
			value = strings.TrimRight(string(data), "\r\n")
		}
		if value == "" {
			return "", errors.New("models router credentials are incomplete")
		}
		return value, nil
	}
	token, err := read("MODELS_ROUTER_SERVICE_TOKEN")
	if err != nil {
		return nil, err
	}
	encoded, err := read("MODELS_ROUTER_ACTOR_SIGNING_KEY_B64")
	if err != nil {
		return nil, err
	}
	key, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(key) < 32 {
		return nil, errors.New("models router signing key is invalid")
	}
	clientApp := get("MODELS_ROUTER_CLIENT_APP")
	if clientApp == "" {
		clientApp = "studio-tv"
	}
	timeout := 10
	if raw := get("MODELS_ROUTER_TIMEOUT_SECONDS"); raw != "" {
		timeout, err = strconv.Atoi(raw)
		if err != nil || timeout < 1 || timeout > 60 || strconv.Itoa(timeout) != raw {
			return nil, errors.New("models router timeout must be 1 to 60 seconds")
		}
	}
	var transport http.RoundTripper
	if len(transports) == 1 {
		transport = transports[0]
	}
	client, err := router.New(router.Config{BaseURL: origin, ClientApp: clientApp, ServiceToken: token, SigningKey: key, Timeout: time.Duration(timeout) * time.Second, Transport: transport})
	if err != nil {
		return nil, errors.New("models router configuration is invalid")
	}
	return client, nil
}
