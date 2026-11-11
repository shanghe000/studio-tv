package domain

import "testing"

func TestMediaMessageRequiresKnownCodeAndBoundedSafeNormalizedText(t *testing.T) {
	safe := "参考视频时长为 55.519 秒，当前模型支持 2–30 秒；请裁剪后重试。"
	if got, ok := MediaErrorMessage("COMFY_MEDIA_DURATION", &safe); !ok || got != safe {
		t.Fatal("normalized media message lost")
	}
	private := "download https://private.example/?token=hidden"
	if _, ok := MediaErrorMessage("COMFY_MEDIA_DURATION", &private); ok {
		t.Fatal("private URL admitted")
	}
	if _, ok := MediaErrorMessage("UNKNOWN_PROVIDER_ERROR", &safe); ok {
		t.Fatal("unknown provider message admitted")
	}
}
