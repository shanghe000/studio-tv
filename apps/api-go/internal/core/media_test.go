package core

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestM4AAndM4VInspectionWithFFmpeg(t *testing.T) {
	ffmpeg, e := exec.LookPath("ffmpeg")
	if e != nil {
		t.Skip("ffmpeg not installed")
	}
	ffprobe := os.Getenv("FFPROBE_PATH")
	if ffprobe == "" {
		ffprobe = "ffprobe"
	}
	if _, e = exec.LookPath(ffprobe); e != nil {
		t.Skip("ffprobe not installed")
	}
	cfg := testConfig(t)
	cfg.FFprobePath = ffprobe
	server := &Server{cfg: cfg}
	for _, sample := range []struct {
		name, mime, kind string
		args             []string
	}{{"sample.m4a", "audio/mp4", "AUDIO", []string{"-f", "lavfi", "-i", "sine=frequency=500:duration=0.2", "-c:a", "aac", "-f", "ipod"}}, {"sample.m4v", "video/mp4", "VIDEO", []string{"-f", "lavfi", "-i", "color=c=black:s=16x16:r=10:d=0.2", "-an", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-f", "ipod"}}} {
		t.Run(sample.name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), sample.name)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			args := append([]string{"-v", "error", "-y"}, sample.args...)
			args = append(args, file)
			if output, e := exec.CommandContext(ctx, ffmpeg, args...).CombinedOutput(); e != nil {
				t.Fatalf("could not generate real media fixture: %v %s", e, output)
			}
			width, height, duration, e := server.inspectMedia(ctx, file, sample.mime, sample.kind)
			if e != nil {
				t.Fatal(e)
			}
			if duration == nil || *duration <= 0 {
				t.Fatal("actual media duration missing")
			}
			if sample.kind == "VIDEO" && (width == nil || height == nil || *width != 16 || *height != 16) {
				t.Fatal("actual video size missing")
			}
		})
	}
}
