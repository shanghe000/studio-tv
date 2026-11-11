package ffmpeg

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"studiotv.local/service/api/internal/modules/media/application"
	"studiotv.local/service/api/internal/modules/media/domain"
)

type Engine struct {
	FFmpegPath, FFprobePath string
	MaxBytes                int64
}

// Reverse filters retain decoded frames until the entire clip has arrived.
// Normalize video and audio before those filters and bound their retained data.
const maxReverseBytes = 256 << 20

func reverseWithinBound(clip domain.Clip, duration float64, isAudio, hasAudio bool, out domain.Output, width, height int) bool {
	if !clip.Reverse {
		return true
	}
	if duration <= 0 || math.IsNaN(duration) || math.IsInf(duration, 0) {
		return false
	}
	var retained float64
	if !isAudio {
		fps := out.FPS
		if fps == 0 {
			fps = 24
		}
		if width < 2 || height < 2 || fps < 1 {
			return false
		}
		// Four bytes per pixel exceed the normalized yuv420p payload and leave
		// room for frame/plane allocation; two extra frames cover rounding.
		retained += (math.Ceil(duration*float64(fps)) + 2) * float64(width) * float64(height) * 4
	}
	if hasAudio {
		// Audio entering areverse is normalized to 48 kHz stereo float PCM.
		retained += (math.Ceil(duration*48000) + 48000) * 2 * 4
	}
	return retained <= maxReverseBytes
}

func encoderPreset(out domain.Output) string {
	if out.Preset == "" {
		return "fast"
	}
	return out.Preset
}

func vp9Speed(preset string) string {
	switch preset {
	case "veryfast":
		return "8"
	case "medium":
		return "2"
	default:
		return "4"
	}
}

func New(ffmpegPath, ffprobePath string, maxBytes int64) (*Engine, error) {
	if ffmpegPath == "" || ffprobePath == "" || maxBytes < 1 || maxBytes > 536870912 {
		return nil, errors.New("media engine configuration invalid")
	}
	return &Engine{ffmpegPath, ffprobePath, maxBytes}, nil
}

type limitedBuffer struct {
	bytes.Buffer
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Len()+len(p) > b.limit {
		return 0, errors.New("media process diagnostics exceeded bound")
	}
	return b.Buffer.Write(p)
}
func (e *Engine) run(ctx context.Context, args ...string) error {
	cmd := exec.CommandContext(ctx, e.FFmpegPath, args...)
	cmd.Stdout = io.Discard
	cmd.Stderr = &limitedBuffer{limit: 32768}
	cmd.WaitDelay = time.Second
	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("local media processing failed")
	}
	return nil
}
func (e *Engine) hasAudio(ctx context.Context, path string) (bool, error) {
	cmd := exec.CommandContext(ctx, e.FFprobePath, "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "json", path)
	out := &limitedBuffer{limit: 32768}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return false, errors.New("local input media inspection failed")
	}
	var p struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
		} `json:"streams"`
	}
	if json.Unmarshal(out.Bytes(), &p) != nil {
		return false, errors.New("local input media metadata invalid")
	}
	return len(p.Streams) > 0, nil
}
func (e *Engine) duration(ctx context.Context, path string) (float64, error) {
	cmd := exec.CommandContext(ctx, e.FFprobePath, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration", "-of", "json", path)
	out := &limitedBuffer{limit: 32768}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	if err := cmd.Run(); err != nil {
		return 0, errors.New("media output inspection failed")
	}
	var info struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if json.Unmarshal(out.Bytes(), &info) != nil {
		return 0, errors.New("media output metadata invalid")
	}
	value, err := strconv.ParseFloat(info.Format.Duration, 64)
	if err != nil || value <= 0 || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, errors.New("media output duration invalid")
	}
	return value, nil
}
func clipDuration(clip domain.Clip, a application.InputAsset) (float64, error) {
	duration := 3.0
	if a.Kind != "IMAGE" {
		if a.DurationMs == nil || *a.DurationMs <= 0 {
			return 0, domain.ErrInvalid
		}
		duration = float64(*a.DurationMs) / 1000
	}
	if clip.Trim != nil {
		if clip.Trim.EndMs != nil {
			duration = float64(*clip.Trim.EndMs) / 1000
		}
		duration -= float64(clip.Trim.StartMs) / 1000
	}
	if clip.Speed != nil {
		duration /= *clip.Speed
	}
	if duration <= 0 || duration > 2400 {
		return 0, domain.ErrInvalid
	}
	return duration, nil
}
func (e *Engine) verifyDuration(ctx context.Context, path string, expected float64) error {
	info, err := os.Stat(path)
	if err != nil || info.Size() < 1 || info.Size() > e.MaxBytes {
		return errors.New("media output exceeds configured bound")
	}
	actual, err := e.duration(ctx, path)
	if err != nil {
		return err
	}
	if math.Abs(actual-expected) > 0.2 {
		return errors.New("media output duration differs from complete requested output")
	}
	return nil
}
func seconds(ms int64) string { return strconv.FormatFloat(float64(ms)/1000, 'f', 3, 64) }
func audioFilters(clip domain.Clip) []string {
	filters := []string{}
	if clip.Trim != nil {
		value := "atrim=start=" + seconds(clip.Trim.StartMs)
		if clip.Trim.EndMs != nil {
			value += ":end=" + seconds(*clip.Trim.EndMs)
		}
		filters = append(filters, value)
	}
	filters = append(filters, "asetpts=PTS-STARTPTS")
	if clip.Speed != nil {
		speed := *clip.Speed
		for speed > 2 {
			filters = append(filters, "atempo=2")
			speed /= 2
		}
		for speed < 0.5 {
			filters = append(filters, "atempo=0.5")
			speed /= 0.5
		}
		filters = append(filters, "atempo="+strconv.FormatFloat(speed, 'f', 6, 64))
	}
	filters = append(filters, "aresample=48000", "aformat=sample_fmts=fltp:channel_layouts=stereo")
	if clip.Reverse {
		filters = append(filters, "areverse")
	}
	return filters
}
func videoFilters(clip domain.Clip, out domain.Output, width, height int) []string {
	filters := []string{}
	if clip.Trim != nil {
		value := "trim=start=" + seconds(clip.Trim.StartMs)
		if clip.Trim.EndMs != nil {
			value += ":end=" + seconds(*clip.Trim.EndMs)
		}
		filters = append(filters, value)
	}
	filters = append(filters, "setpts=PTS-STARTPTS")
	if clip.Crop != nil {
		c := clip.Crop
		filters = append(filters, fmt.Sprintf("crop=%d:%d:%d:%d", c.Width, c.Height, c.X, c.Y))
	}
	if clip.Speed != nil {
		filters = append(filters, "setpts=PTS/"+strconv.FormatFloat(*clip.Speed, 'f', 6, 64))
	}
	switch clip.Rotate {
	case "90":
		filters = append(filters, "transpose=1")
	case "180":
		filters = append(filters, "hflip", "vflip")
	case "270":
		filters = append(filters, "transpose=2")
	}
	switch clip.Mirror {
	case "horizontal":
		filters = append(filters, "hflip")
	case "vertical":
		filters = append(filters, "vflip")
	}
	filters = append(filters, fmt.Sprintf("scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2", width, height, width, height), "setsar=1")
	fps := out.FPS
	if fps == 0 {
		fps = 24
	}
	filters = append(filters, "fps="+strconv.Itoa(fps), "format=yuv420p")
	if clip.Reverse {
		filters = append(filters, "reverse")
	}
	return filters
}
func (e *Engine) Execute(ctx context.Context, spec domain.Spec, inputs []application.InputAsset) (application.Result, error) {
	if spec.Validate() != nil {
		return application.Result{}, domain.ErrInvalid
	}
	preset := encoderPreset(*spec.Output)
	if spec.Output.MaxBytes > 0 && spec.Output.MaxBytes < e.MaxBytes {
		copy := *e
		copy.MaxBytes = spec.Output.MaxBytes
		e = &copy
	}
	byAsset := map[string]application.InputAsset{}
	for _, a := range inputs {
		if a.Path == "" || !filepath.IsAbs(a.Path) {
			return application.Result{}, domain.ErrInvalid
		}
		byAsset[a.ID] = a
	}
	byID := map[string]application.InputAsset{}
	for _, in := range spec.Inputs {
		a, ok := byAsset[in.AssetID]
		if !ok {
			return application.Result{}, domain.ErrInvalid
		}
		byID[in.ID] = a
	}
	directory, err := os.MkdirTemp("", "studio-media-job-")
	if err != nil {
		return application.Result{}, err
	}
	defer os.RemoveAll(directory)
	audioOnly := spec.Output.Container == "wav"
	var videoTrack, audioTrack *domain.Track
	for i := range spec.Tracks {
		track := &spec.Tracks[i]
		if track.Type == "video" {
			videoTrack = track
		} else {
			audioTrack = track
		}
	}
	if !audioOnly && videoTrack == nil {
		return application.Result{}, domain.ErrInvalid
	}
	tracks := spec.Tracks
	if audioOnly && videoTrack != nil {
		tracks = []domain.Track{*videoTrack}
	}
	width, height := spec.Output.Width, spec.Output.Height
	if width == 0 && videoTrack != nil {
		first := byID[videoTrack.Clips[0].Input]
		if first.Width == nil || first.Height == nil {
			return application.Result{}, domain.ErrInvalid
		}
		width, height = *first.Width, *first.Height
		if crop := videoTrack.Clips[0].Crop; crop != nil {
			width, height = crop.Width, crop.Height
		}
		if videoTrack.Clips[0].Rotate == "90" || videoTrack.Clips[0].Rotate == "270" {
			width, height = height, width
		}
	}
	width -= width % 2
	height -= height % 2
	if !audioOnly && (width < 2 || height < 2 || width > 3840 || height > 2160) {
		return application.Result{}, domain.ErrInvalid
	}
	trackFiles := map[string]string{}
	trackDuration := map[string]float64{}
	for _, track := range tracks {
		segments := []string{}
		for i, clip := range track.Clips {
			a := byID[clip.Input]
			hasAudio, err := e.hasAudio(ctx, a.Path)
			if err != nil {
				return application.Result{}, err
			}
			isAudio := audioOnly || track.Type == "audio"
			expected, err := clipDuration(clip, a)
			if err != nil {
				return application.Result{}, err
			}
			if !reverseWithinBound(clip, expected, isAudio, hasAudio, *spec.Output, width, height) {
				return application.Result{}, errors.New("reverse clip exceeds decoded media memory bound")
			}
			trackDuration[track.Type] += expected
			if isAudio && !hasAudio {
				return application.Result{}, errors.New("input has no audio stream")
			}
			if !isAudio && a.Kind != "VIDEO" && a.Kind != "IMAGE" {
				return application.Result{}, domain.ErrInvalid
			}
			if clip.Crop != nil && (a.Width == nil || a.Height == nil || clip.Crop.X > *a.Width-clip.Crop.Width || clip.Crop.Y > *a.Height-clip.Crop.Height) {
				return application.Result{}, domain.ErrInvalid
			}
			if clip.Trim != nil && a.DurationMs != nil && (clip.Trim.StartMs >= *a.DurationMs || clip.Trim.EndMs != nil && *clip.Trim.EndMs > *a.DurationMs+100) {
				return application.Result{}, domain.ErrInvalid
			}
			ext := "mp4"
			if isAudio {
				ext = "wav"
			}
			output := filepath.Join(directory, fmt.Sprintf("%s-%d.%s", track.Type, i, ext))
			args := []string{"-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe", "-threads", "2"}
			if a.Kind == "IMAGE" {
				imageDuration := expected
				if clip.Speed != nil {
					imageDuration *= *clip.Speed
				}
				if clip.Trim != nil {
					imageDuration += float64(clip.Trim.StartMs) / 1000
				}
				args = append(args, "-loop", "1", "-t", strconv.FormatFloat(imageDuration, 'f', 6, 64))
			}
			args = append(args, "-i", a.Path)
			if !isAudio && !hasAudio {
				args = append(args, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo")
			}
			if isAudio {
				args = append(args, "-vn", "-map", "0:a:0", "-af", strings.Join(audioFilters(clip), ","), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le")
			} else {
				audioMap := "0:a:0"
				if !hasAudio {
					audioMap = "1:a:0"
				}
				args = append(args, "-map", "0:v:0", "-map", audioMap, "-vf", strings.Join(videoFilters(clip, *spec.Output, width, height), ","))
				if hasAudio {
					args = append(args, "-af", strings.Join(audioFilters(clip), ","))
				}
				args = append(args, "-ar", "48000", "-ac", "2", "-c:a", "aac", "-t", strconv.FormatFloat(expected, 'f', 6, 64))
				args = append(args, "-c:v", "libx264", "-preset", preset, "-crf", "23", "-pix_fmt", "yuv420p")
			}
			args = append(args, "-fs", strconv.FormatInt(e.MaxBytes, 10), output)
			if err = e.run(ctx, args...); err != nil {
				return application.Result{}, err
			}
			if err = e.verifyDuration(ctx, output, expected); err != nil {
				return application.Result{}, err
			}
			segments = append(segments, output)
		}
		list := filepath.Join(directory, track.Type+"-concat.txt")
		var text strings.Builder
		for _, segment := range segments {
			text.WriteString("file '")
			text.WriteString(filepath.Base(segment))
			text.WriteString("'\n")
		}
		if err = os.WriteFile(list, []byte(text.String()), 0600); err != nil {
			return application.Result{}, err
		}
		trackExt := "mp4"
		if audioOnly || track.Type == "audio" {
			trackExt = "wav"
		}
		combined := filepath.Join(directory, track.Type+"-combined."+trackExt)
		args := []string{"-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe", "-f", "concat", "-safe", "1", "-i", list, "-c", "copy", "-fs", strconv.FormatInt(e.MaxBytes, 10), combined}
		if err = e.run(ctx, args...); err != nil {
			return application.Result{}, err
		}
		if err = e.verifyDuration(ctx, combined, trackDuration[track.Type]); err != nil {
			return application.Result{}, err
		}
		trackFiles[track.Type] = combined
	}
	ext := spec.Output.Container
	final := filepath.Join(directory, "output."+ext)
	source := trackFiles["video"]
	if source == "" {
		source = trackFiles["audio"]
	}
	args := []string{"-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe", "-threads", "2", "-i", source}
	if audioOnly {
		args = append(args, "-vn", "-c:a", "pcm_s16le")
	} else {
		if audioTrack != nil {
			args = append(args, "-i", trackFiles["audio"], "-map", "0:v:0", "-map", "1:a:0", "-shortest")
		}
		crf := 23
		if spec.Output.CRF != nil {
			crf = *spec.Output.CRF
		}
		if ext == "webm" {
			if spec.Output.VideoCodec != "" && spec.Output.VideoCodec != "vp9" && spec.Output.VideoCodec != "libvpx-vp9" {
				return application.Result{}, domain.ErrInvalid
			}
			if spec.Output.AudioCodec != "" && spec.Output.AudioCodec != "opus" {
				return application.Result{}, domain.ErrInvalid
			}
			args = append(args, "-c:v", "libvpx-vp9", "-deadline", "good", "-cpu-used", vp9Speed(preset), "-crf", strconv.Itoa(crf), "-b:v", "0", "-c:a", "libopus")
		} else {
			if spec.Output.VideoCodec != "" && spec.Output.VideoCodec != "h264" && spec.Output.VideoCodec != "libx264" {
				return application.Result{}, domain.ErrInvalid
			}
			if spec.Output.AudioCodec != "" && spec.Output.AudioCodec != "aac" {
				return application.Result{}, domain.ErrInvalid
			}
			args = append(args, "-c:v", "libx264", "-preset", preset, "-crf", strconv.Itoa(crf), "-c:a", "aac", "-movflags", "+faststart")
		}
		args = append(args, "-pix_fmt", "yuv420p")
	}
	args = append(args, "-fs", strconv.FormatInt(e.MaxBytes, 10), final)
	if err = e.run(ctx, args...); err != nil {
		return application.Result{}, err
	}
	expected := trackDuration["video"]
	if expected == 0 {
		expected = trackDuration["audio"]
	}
	if !audioOnly && audioTrack != nil {
		expected = math.Min(expected, trackDuration["audio"])
	}
	if err = e.verifyDuration(ctx, final, expected); err != nil {
		return application.Result{}, err
	}
	file, err := os.Open(final)
	if err != nil {
		return application.Result{}, err
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, e.MaxBytes+1))
	if err != nil || len(body) == 0 || int64(len(body)) > e.MaxBytes {
		return application.Result{}, errors.New("media output exceeds configured bound")
	}
	kind, typ := "VIDEO", "video/mp4"
	switch ext {
	case "webm":
		typ = "video/webm"
	case "mov":
		typ = "video/quicktime"
	case "wav":
		kind, typ = "AUDIO", "audio/wav"
	}
	return application.Result{Content: body, MimeType: typ, Kind: kind}, nil
}

var _ application.Engine = (*Engine)(nil)
