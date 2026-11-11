package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func observabilityEnv() map[string]string {
	return map[string]string{"DATABASE_URL": "postgres://localhost/studiotv_test", "AUTH_SIGNING_SECRET": "test-only-secret-at-least-32-bytes"}
}

func TestObservabilityDefaultsAndPrivateSecretFile(t *testing.T) {
	env := observabilityEnv()
	get := func(k string) string { return env[k] }
	cfg, err := From(get)
	if err != nil || cfg.LogLevel != "info" || cfg.MetricsEnabled || cfg.MetricsAddress != "127.0.0.1:9090" || cfg.AlertWebhookURL != "" {
		t.Fatal("invalid observability defaults", err)
	}
	file := filepath.Join(t.TempDir(), "hook")
	const hook = "https://assets.example.invalid/removed"
	if err := os.WriteFile(file, []byte(hook+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	env["STUDIOTV_ALERT_WEBHOOK_URL_FILE"] = file
	env["METRICS_ENABLED"], env["METRICS_ADDR"], env["LOG_LEVEL"], env["STUDIOTV_ENV"] = "true", "0.0.0.0:9090", "warn", "deployment-host"
	cfg, err = From(get)
	if err != nil || cfg.AlertWebhookURL != hook || !cfg.MetricsEnabled || cfg.Environment != "deployment-host" || cfg.LogLevel != "warn" {
		t.Fatal("private observability configuration rejected", err)
	}
}

func TestObservabilityInvalidInputsAreRedacted(t *testing.T) {
	for _, test := range []struct{ key, value string }{
		{"LOG_LEVEL", "test-sensitive-value"}, {"STUDIOTV_ENV", "test-sensitive-value\ninvalid"},
		{"STUDIOTV_ALERT_WEBHOOK_URL", "http://test-sensitive-value/hook"}, {"STUDIOTV_ALERT_WEBHOOK_URL", "https://user:test-sensitive-value@example.org/hook"},
		{"STUDIOTV_ALERT_WEBHOOK_URL", "https://example.org/hook?secret=test-sensitive-value"}, {"STUDIOTV_ALERT_WEBHOOK_URL", "https://example.org/hook#test-sensitive-value"},
		{"STUDIOTV_ALERT_WEBHOOK_URL_FILE", "relative-test-sensitive-value"}, {"STUDIOTV_ALERT_WEBHOOK_URL_FILE", "/missing/test-sensitive-value"},
		{"METRICS_ENABLED", "test-sensitive-value"}, {"METRICS_ADDR", "8.8.8.8:9090"}, {"METRICS_ADDR", ":9090"}, {"METRICS_ADDR", "127.0.0.1:0"},
	} {
		t.Run(test.key+"/"+test.value, func(t *testing.T) {
			env := observabilityEnv()
			env[test.key] = test.value
			_, err := From(func(k string) string { return env[k] })
			if err == nil || strings.Contains(err.Error(), "test-sensitive-value") {
				t.Fatal("expected fixed non-secret configuration error")
			}
		})
	}
	env := observabilityEnv()
	env["STUDIOTV_ALERT_WEBHOOK_URL"] = "https://example.org/test-only"
	env["STUDIOTV_ALERT_WEBHOOK_URL_FILE"] = "/private/test-only"
	if _, err := From(func(k string) string { return env[k] }); err == nil {
		t.Fatal("two competing hook sources accepted")
	}
	for _, content := range []string{"", strings.Repeat("a", 4097)} {
		file := filepath.Join(t.TempDir(), "hook")
		if err := os.WriteFile(file, []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
		env = observabilityEnv()
		env["STUDIOTV_ALERT_WEBHOOK_URL_FILE"] = file
		if _, err := From(func(k string) string { return env[k] }); err == nil {
			t.Fatal("invalid hook file accepted")
		}
	}
}
