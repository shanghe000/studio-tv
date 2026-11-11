package ffmpeg

import (
	"context"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	execution "studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/media/application"
	"studiotv.local/service/api/internal/modules/media/domain"
	"strings"
	"testing"
	"time"
)

func tools(t *testing.T) (string, string) {
	t.Helper()
	ff := os.Getenv("TEST_FFMPEG_PATH")
	if ff == "" {
		ff = "ffmpeg"
	}
	probe := os.Getenv("TEST_FFPROBE_PATH")
	if probe == "" {
		probe = "ffprobe"
	}
	for _, p := range []string{ff, probe} {
		if _, e := exec.LookPath(p); e != nil {
			t.Skip("actual FFmpeg/FFprobe not supplied")
		}
	}
	return ff, probe
}
func TestFFmpegTransformsCompletePlayableOutput(t *testing.T) {
	ff, probe := tools(t)
	directory := t.TempDir()
	input := filepath.Join(directory, "input.mp4")
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, ff, "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x96:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", input)
	if raw, e := cmd.CombinedOutput(); e != nil {
		t.Fatal("test fixture encode failed", e, string(raw))
	}
	width, height := 160, 96
	duration := int64(1000)
	inputs := []application.InputAsset{{Asset: execution.Asset{ID: "ast_input", Kind: "VIDEO", Width: &width, Height: &height, DurationMs: &duration}, Path: input}}
	engine, _ := New(ff, probe, 8<<20)
	speed := 2.0
	end := int64(800)
	spec := domain.Spec{Version: 1, Inputs: []domain.Input{{ID: "v", AssetID: "ast_input"}}, Tracks: []domain.Track{{Type: "video", Clips: []domain.Clip{{Input: "v", Trim: &domain.Trim{StartMs: 0, EndMs: &end}, Crop: &domain.Crop{X: 4, Y: 2, Width: 80, Height: 48}, Speed: &speed, Reverse: true, Rotate: "90", Mirror: "horizontal"}}}}, Output: &domain.Output{Container: "mp4", FPS: 24, Preset: "medium"}}
	result, e := engine.Execute(ctx, spec, inputs)
	if e != nil {
		t.Fatal("actual media transform failed", e)
	}
	// x264 writes its applied encoder settings into the output SEI. The medium
	// preset uses 40-frame lookahead; fast uses 30, so this verifies the actual
	// movie honors the accepted preset rather than only testing argument code.
	if !strings.Contains(string(result.Content), "rc_lookahead=40") {
		t.Fatal("actual H264 output did not apply the requested medium preset")
	}
	output := filepath.Join(directory, "output.mp4")
	os.WriteFile(output, result.Content, 0600)
	actual, e := engine.duration(ctx, output)
	if e != nil || math.Abs(actual-.4) > .2 || result.Kind != "VIDEO" {
		t.Fatal("transformed output metadata invalid", actual, e)
	}
	if e = exec.CommandContext(ctx, ff, "-v", "error", "-i", output, "-f", "null", "-").Run(); e != nil {
		t.Fatal("result cannot fully decode", e)
	}
	largeSpec := domain.Spec{Version: 1, Inputs: spec.Inputs, Tracks: []domain.Track{{Type: "video", Clips: []domain.Clip{{Input: "v", Reverse: true}}}}, Output: &domain.Output{Container: "mp4", Width: 3840, Height: 2160}}
	if _, err := engine.Execute(ctx, largeSpec, inputs); err == nil || !strings.Contains(err.Error(), "decoded media memory bound") {
		t.Fatal("oversized reverse did not fail before buffering decoded frames", err)
	}
	image := filepath.Join(directory, "image.png")
	if raw, err := exec.CommandContext(ctx, ff, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=160x96", "-frames:v", "1", "-threads", "1", image).CombinedOutput(); err != nil {
		t.Fatal("image fixture encode", err, string(raw))
	}
	imageSpec := domain.Spec{Version: 1, Inputs: []domain.Input{{ID: "still", AssetID: "ast_image"}}, Tracks: []domain.Track{{Type: "video", Clips: []domain.Clip{{Input: "still", Reverse: true}}}}, Output: &domain.Output{Container: "mp4"}}
	imageInputs := []application.InputAsset{{Asset: execution.Asset{ID: "ast_image", Kind: "IMAGE", Width: &width, Height: &height}, Path: image}}
	imageCtx, imageStop := context.WithTimeout(ctx, 8*time.Second)
	imageResult, imageErr := engine.Execute(imageCtx, imageSpec, imageInputs)
	imageStop()
	if imageErr != nil || len(imageResult.Content) == 0 {
		t.Fatal("finite image reverse failed", imageErr)
	}
	spec.Tracks[0].Clips = []domain.Clip{{Input: "v"}, {Input: "v"}}
	spec.Output = &domain.Output{Container: "mp4"}
	result, e = engine.Execute(ctx, spec, inputs)
	if e != nil {
		t.Fatal("concat failed", e)
	}
	os.WriteFile(output, result.Content, 0600)
	actual, e = engine.duration(ctx, output)
	if e != nil || math.Abs(actual-2) > .2 {
		t.Fatal("concat output duration", actual, e)
	}
	spec.Tracks[0].Clips = []domain.Clip{{Input: "v"}}
	spec.Output = &domain.Output{Container: "wav"}
	result, e = engine.Execute(ctx, spec, inputs)
	if e != nil || result.Kind != "AUDIO" || !strings.HasPrefix(string(result.Content), "RIFF") {
		t.Fatal("real audio extraction failed", e)
	}
	limited, _ := New(ff, probe, 1024)
	spec.Output = &domain.Output{Container: "mp4"}
	if _, e = limited.Execute(ctx, spec, inputs); e == nil {
		t.Fatal("truncated media admitted")
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, e = engine.Execute(canceled, spec, inputs); e == nil {
		t.Fatal("canceled encode succeeded")
	}
}

func TestReverseDecodedMemoryBoundAndAudioOnlyOptions(t *testing.T) {
	reverse := domain.Clip{Reverse: true}
	for _, check := range []struct {
		name             string
		duration         float64
		audioOnly, audio bool
		width, height    int
		allowed          bool
	}{
		{"short1080p", 1.25, false, true, 1920, 1080, true},
		{"large1080p", 1.3, false, true, 1920, 1080, false},
		{"short4k", .2, false, false, 3840, 2160, true},
		{"large4k", .3, false, false, 3840, 2160, false},
		{"audioBelowBound", 698, true, true, 0, 0, true},
		{"audioAboveBound", 699, true, true, 0, 0, false},
		{"invalidDuration", math.Inf(1), true, true, 0, 0, false},
	} {
		t.Run(check.name, func(t *testing.T) {
			if got := reverseWithinBound(reverse, check.duration, check.audioOnly, check.audio, domain.Output{}, check.width, check.height); got != check.allowed {
				t.Fatalf("reverse memory admission = %v, want %v", got, check.allowed)
			}
		})
	}
	if !reverseWithinBound(domain.Clip{}, 2400, false, true, domain.Output{}, 3840, 2160) {
		t.Fatal("streaming clips incorrectly require reverse buffer")
	}
	for _, preset := range []string{"veryfast", "fast", "medium"} {
		spec := domain.Spec{Version: 1, Inputs: []domain.Input{{ID: "a", AssetID: "ast_a"}}, Tracks: []domain.Track{{Type: "audio", Clips: []domain.Clip{{Input: "a"}}}}, Output: &domain.Output{Container: "wav", Preset: preset}}
		if spec.Validate() == nil {
			t.Fatal("audio-only output accepted a video encoder preset")
		}
	}
}
