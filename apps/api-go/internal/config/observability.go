package config

import (
	"errors"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

var environmentLabel = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,48}$`)

func loadObservability(c *Config, get func(string) string) error {
	c.LogDirectory = strings.TrimSpace(get("STUDIOTV_LOG_DIR"))
	if c.LogDirectory != "" && !filepath.IsAbs(c.LogDirectory) {
		return errors.New("STUDIOTV_LOG_DIR must be absolute")
	}
	c.LogLevel = strings.ToLower(strings.TrimSpace(get("LOG_LEVEL")))
	if c.LogLevel == "" {
		c.LogLevel = "info"
	}
	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return errors.New("LOG_LEVEL must be debug, info, warn or error")
	}
	c.Environment = strings.TrimSpace(get("STUDIOTV_ENV"))
	if c.Environment == "" {
		c.Environment = "internal"
	}
	if !environmentLabel.MatchString(c.Environment) {
		return errors.New("invalid STUDIOTV_ENV label")
	}
	webhook := strings.TrimSpace(get("STUDIOTV_ALERT_WEBHOOK_URL"))
	file := strings.TrimSpace(get("STUDIOTV_ALERT_WEBHOOK_URL_FILE"))
	if webhook != "" && file != "" {
		return errors.New("configure only one STUDIOTV_ALERT_WEBHOOK_URL source")
	}
	if file != "" {
		if !filepath.IsAbs(file) {
			return errors.New("STUDIOTV_ALERT_WEBHOOK_URL_FILE must be absolute")
		}
		// Fixed error text: neither private filenames nor hook credentials belong in logs.
		info, err := os.Stat(file)
		if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 4096 {
			return errors.New("cannot read STUDIOTV_ALERT_WEBHOOK_URL_FILE")
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return errors.New("cannot read STUDIOTV_ALERT_WEBHOOK_URL_FILE")
		}
		webhook = strings.TrimSpace(string(data))
		if webhook == "" {
			return errors.New("STUDIOTV_ALERT_WEBHOOK_URL_FILE is empty")
		}
	}
	if webhook != "" {
		u, err := url.Parse(webhook)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.ForceQuery || strings.ContainsAny(webhook, "\r\n") {
			return errors.New("invalid STUDIOTV_ALERT_WEBHOOK_URL")
		}
	}
	c.AlertWebhookURL = webhook
	if raw := get("METRICS_ENABLED"); raw != "" {
		if raw != "true" && raw != "false" {
			return errors.New("METRICS_ENABLED must be true or false")
		}
		c.MetricsEnabled = raw == "true"
	}
	c.MetricsAddress = get("METRICS_ADDR")
	if c.MetricsAddress == "" {
		c.MetricsAddress = "127.0.0.1:9090"
	}
	host, port, err := net.SplitHostPort(c.MetricsAddress)
	p, portErr := strconv.Atoi(port)
	addr, addrErr := netip.ParseAddr(host)
	if err != nil || portErr != nil || p < 1 || p > 65535 || addrErr != nil || !(addr.IsLoopback() || addr.IsPrivate() || addr.IsUnspecified()) {
		return errors.New("METRICS_ADDR must bind a private, loopback or container IP and valid port")
	}
	return nil
}
