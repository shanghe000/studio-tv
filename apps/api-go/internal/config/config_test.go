package config

import "testing"

func TestConfigInternalDefaultsAndLoopback(t *testing.T) {
	env := map[string]string{"DATABASE_URL": "postgres://localhost/rhtv_test", "AUTH_SIGNING_SECRET": "test-only-signing-secret-32-bytes-long", "PUBLIC_BASE_URL": "http://localhost:18880", "ALLOW_LOCAL_HTTP": "true"}
	get := func(k string) string { return env[k] }
	cfg, e := From(get)
	if e != nil {
		t.Fatal(e)
	}
	if cfg.Edition != "internal" || cfg.SecureCookies || cfg.Features["billing"] {
		t.Fatalf("wrong internal defaults %#v", cfg.Features)
	}
	if cfg.AllowPrivateHTTP {
		t.Fatal("private HTTP override should be disabled by default")
	}
	env["FEATURE_COMMUNITY"] = "true"
	cfg, e = From(get)
	if e != nil || !cfg.Features["community"] || cfg.Features["billing"] {
		t.Fatal("override did not remain isolated")
	}
	env["PUBLIC_BASE_URL"] = "http://deployment-host:18880"
	if _, e = From(get); e == nil {
		t.Fatal("non-loopback HTTP accepted")
	}
	env["PUBLIC_BASE_URL"] = "https://service.example"
	env["FEATURE_BILLING"] = "yes"
	if _, e = From(get); e == nil {
		t.Fatal("invalid feature accepted")
	}
}

func TestConfigPrivateHTTPOrigins(t *testing.T) {
	tests := []struct {
		name    string
		origin  string
		edition string
		flag    string
		allowed bool
	}{
		{"10 lower boundary", "http://10.0.0.0:18880", "internal", "true", true},
		{"10 upper boundary", "http://10.255.255.255:18880", "internal", "true", true},
		{"172 lower boundary", "http://172.16.0.0:18880", "internal", "true", true},
		{"172 upper boundary", "http://172.31.255.255:18880", "internal", "true", true},
		{"192 lower boundary", "http://192.168.0.0:18880", "internal", "true", true},
		{"192 upper boundary", "http://192.168.255.255:18880", "internal", "true", true},
		{"default internal edition", "http://192.168.123.45:18880", "", "true", true},
		{"disabled by default", "http://192.168.123.45:18880", "internal", "", false},
		{"explicitly disabled", "http://192.168.123.45:18880", "internal", "false", false},
		{"literal true required", "http://192.168.123.45:18880", "internal", "TRUE", false},
		{"external edition", "http://192.168.123.45:18880", "external", "true", false},
		{"invalid edition", "http://192.168.123.45:18880", "unknown", "true", false},
		{"below 10 range", "http://9.255.255.255:18880", "internal", "true", false},
		{"above 10 range", "http://11.0.0.0:18880", "internal", "true", false},
		{"below 172 range", "http://172.15.255.255:18880", "internal", "true", false},
		{"above 172 range", "http://172.32.0.0:18880", "internal", "true", false},
		{"below 192 range", "http://192.167.255.255:18880", "internal", "true", false},
		{"above 192 range", "http://192.169.0.0:18880", "internal", "true", false},
		{"public IPv4", "http://8.8.8.8:18880", "internal", "true", false},
		{"link local IPv4", "http://169.254.1.1:18880", "internal", "true", false},
		{"carrier grade NAT", "http://100.64.0.1:18880", "internal", "true", false},
		{"unspecified IPv4", "http://0.0.0.0:18880", "internal", "true", false},
		{"loopback needs own override", "http://127.0.0.1:18880", "internal", "true", false},
		{"localhost needs own override", "http://localhost:18880", "internal", "true", false},
		{"IPv6 loopback needs own override", "http://[::1]:18880", "internal", "true", false},
		{"private IPv6", "http://[fd00::1]:18880", "internal", "true", false},
		{"mapped private IPv4", "http://[::ffff:192.168.123.45]:18880", "internal", "true", false},
		{"public IPv6", "http://[2001:4860:4860::8888]:18880", "internal", "true", false},
		{"DNS name", "http://deployment-host:18880", "internal", "true", false},
		{"IP like DNS name", "http://192.168.123.45.example:18880", "internal", "true", false},
		{"noncanonical IPv4", "http://192.168.050.89:18880", "internal", "true", false},
		{"userinfo", "http://user@192.168.123.45:18880", "internal", "true", false},
		{"query", "http://192.168.123.45:18880?x=1", "internal", "true", false},
		{"empty query", "http://192.168.123.45:18880?", "internal", "true", false},
		{"path", "http://192.168.123.45:18880/projects", "internal", "true", false},
		{"fragment", "http://192.168.123.45:18880#projects", "internal", "true", false},
		{"other scheme", "ftp://192.168.123.45:18880", "internal", "true", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := map[string]string{
				"DATABASE_URL":        "postgres://localhost/rhtv_test",
				"AUTH_SIGNING_SECRET": "test-only-signing-secret-32-bytes-long",
				"PUBLIC_BASE_URL":     tt.origin,
				"RHTV_EDITION":        tt.edition,
				"ALLOW_PRIVATE_HTTP":  tt.flag,
			}
			cfg, err := From(func(k string) string { return env[k] })
			if (err == nil) != tt.allowed {
				t.Fatalf("allowed = %v, error = %v", tt.allowed, err)
			}
			if tt.allowed && (!cfg.AllowPrivateHTTP || cfg.SecureCookies || cfg.Edition != "internal" || len(cfg.AllowedOrigins) != 1 || cfg.AllowedOrigins[0] != tt.origin) {
				t.Fatalf("incorrect private HTTP config: edition=%q override=%v secure=%v origins=%v", cfg.Edition, cfg.AllowPrivateHTTP, cfg.SecureCookies, cfg.AllowedOrigins)
			}
		})
	}
}

func TestBillingEditionCannotBeOverriddenInternally(t *testing.T) {
	for _, tt := range []struct {
		edition, flag string
		want          bool
	}{
		{"", "true", false}, {"internal", "true", false}, {"internal", "false", false},
		{"external", "", true}, {"external", "true", true}, {"external", "false", false},
	} {
		t.Run(tt.edition+"/"+tt.flag, func(t *testing.T) {
			env := map[string]string{
				"DATABASE_URL": "postgres://localhost/rhtv_test", "AUTH_SIGNING_SECRET": "test-only-signing-secret-32-bytes-long",
				"PUBLIC_BASE_URL": "https://service.example", "RHTV_EDITION": tt.edition, "FEATURE_BILLING": tt.flag,
			}
			cfg, err := From(func(k string) string { return env[k] })
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Features["billing"] != tt.want {
				t.Fatalf("billing = %v, want %v", cfg.Features["billing"], tt.want)
			}
		})
	}
}

func TestConfigExistingHTTPSAndLoopback(t *testing.T) {
	for _, tt := range []struct {
		name    string
		origin  string
		edition string
		local   string
		private string
		secure  bool
	}{
		{"HTTPS default", "https://service.example", "internal", "", "", true},
		{"external HTTPS with override", "https://192.168.123.45:18880", "external", "", "true", true},
		{"localhost", "http://localhost:18880", "internal", "true", "", false},
		{"IPv4 loopback", "http://127.0.0.1:18880", "internal", "true", "", false},
		{"IPv6 loopback", "http://[::1]:18880", "internal", "true", "", false},
		{"external loopback unchanged", "http://localhost:18880", "external", "true", "true", false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			env := map[string]string{
				"DATABASE_URL":        "postgres://localhost/rhtv_test",
				"AUTH_SIGNING_SECRET": "test-only-signing-secret-32-bytes-long",
				"PUBLIC_BASE_URL":     tt.origin,
				"RHTV_EDITION":        tt.edition,
				"ALLOW_LOCAL_HTTP":    tt.local,
				"ALLOW_PRIVATE_HTTP":  tt.private,
			}
			cfg, err := From(func(k string) string { return env[k] })
			if err != nil {
				t.Fatal(err)
			}
			if cfg.SecureCookies != tt.secure {
				t.Fatalf("SecureCookies = %v, want %v", cfg.SecureCookies, tt.secure)
			}
		})
	}
}

func TestRealExecutionNeedsExplicitBoolean(t *testing.T) {
	env := map[string]string{"DATABASE_URL": "postgres://localhost/test", "AUTH_SIGNING_SECRET": "test-only-signing-secret-32-bytes-long", "PUBLIC_BASE_URL": "http://localhost:18880", "ALLOW_LOCAL_HTTP": "true"}
	get := func(k string) string { return env[k] }
	cfg, err := From(get)
	if err != nil || cfg.ModelRealExecutionEnabled {
		t.Fatal("unsafe default")
	}
	env["MODEL_REAL_EXECUTION_ENABLED"] = "yes"
	if _, err = From(get); err == nil {
		t.Fatal("invalid policy accepted")
	}
	env["MODEL_REAL_EXECUTION_ENABLED"] = "true"
	cfg, err = From(get)
	if err != nil || !cfg.ModelRealExecutionEnabled {
		t.Fatal("explicit policy ignored")
	}
}

func TestAgentConfigRequiresExplicitValidatedIsolation(t *testing.T) {
	env := map[string]string{"DATABASE_URL": "postgres://localhost/rhtv_test", "AUTH_SIGNING_SECRET": "test-only-signing-secret-32-bytes-long", "PUBLIC_BASE_URL": "https://studio.test"}
	get := func(k string) string { return env[k] }
	cfg, err := From(get)
	if err != nil || cfg.AgentEnabled {
		t.Fatal("agent enabled by default", err)
	}
	env["STUDIO_CODEX_AGENT_ENABLED"] = "true"
	if _, err = From(get); err == nil {
		t.Fatal("missing runtime isolation accepted")
	}
	env["STUDIO_CODEX_AGENT_PROFILE_VALIDATED"] = "true"
	env["MODEL_REAL_EXECUTION_ENABLED"] = "true"
	env["STUDIO_CODEX_AGENT_SOCKET"] = "/run/studio-agent/launcher.sock"
	cfg, err = From(get)
	if err != nil || !cfg.AgentEnabled {
		t.Fatal(err)
	}
	env["STUDIO_CODEX_AGENT_PROFILE_VALIDATED"] = "yes"
	if _, err = From(get); err == nil {
		t.Fatal("invalid gate accepted")
	}
}
