package application

import "testing"

func TestProviderCredentialValidationIsOpaqueButHeaderSafe(t *testing.T) {
	for _, key := range []string{"", " ", "inside space", "inside\rreturn", "inside\nnewline", "inside\ttab", "null\x00byte", "bad\xffutf8"} {
		if _, ok := NormalizeProviderAPIKey(key); ok {
			t.Fatal("unsafe personal key accepted")
		}
	}
	if got, ok := NormalizeProviderAPIKey("  TEST_ONLY_x.y+/=:_-  "); !ok || got != "TEST_ONLY_x.y+/=:_-" {
		t.Fatal("opaque personal token altered")
	}
}
