package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strings"
)

var ErrInvalid = errors.New("invalid media operation")

type Input struct {
	ID      string `json:"id"`
	AssetID string `json:"assetId"`
}
type Trim struct {
	StartMs int64  `json:"startMs"`
	EndMs   *int64 `json:"endMs,omitempty"`
}
type Crop struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}
type Clip struct {
	Input   string   `json:"input"`
	Trim    *Trim    `json:"trim,omitempty"`
	Crop    *Crop    `json:"crop,omitempty"`
	Speed   *float64 `json:"speed,omitempty"`
	Reverse bool     `json:"reverse,omitempty"`
	Rotate  string   `json:"rotate,omitempty"`
	Mirror  string   `json:"mirror,omitempty"`
}
type Track struct {
	Type  string `json:"type"`
	Clips []Clip `json:"clips"`
}
type Output struct {
	Container  string `json:"container"`
	FPS        int    `json:"fps,omitempty"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
	VideoCodec string `json:"videoCodec,omitempty"`
	AudioCodec string `json:"audioCodec,omitempty"`
	Bucket     string `json:"bucket,omitempty"`
	CRF        *int   `json:"crf,omitempty"`
	MaxBytes   int64  `json:"maxBytes,omitempty"`
	Preset     string `json:"preset,omitempty"`
}
type Spec struct {
	Version int     `json:"version"`
	Inputs  []Input `json:"inputs"`
	Tracks  []Track `json:"tracks"`
	Output  *Output `json:"output,omitempty"`
}

func Parse(raw json.RawMessage) (Spec, error) {
	var spec Spec
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&spec) != nil {
		return spec, ErrInvalid
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return spec, ErrInvalid
	}
	if spec.Version == 0 {
		spec.Version = 1
	}
	if spec.Output == nil {
		spec.Output = &Output{Container: "mp4"}
	}
	for i := range spec.Tracks {
		if spec.Tracks[i].Type == "split" || spec.Tracks[i].Type == "compress" {
			spec.Tracks[i].Type = "video"
		}
	}
	return spec, spec.Validate()
}
func id(v string) bool {
	if len(v) < 1 || len(v) > 200 || strings.ContainsAny(v, " \t\r\n\\") || strings.Contains(v, "://") {
		return false
	}
	return true
}
func (s Spec) Validate() error {
	if s.Version != 1 || len(s.Inputs) < 1 || len(s.Inputs) > 16 || len(s.Tracks) < 1 || len(s.Tracks) > 2 || s.Output == nil {
		return ErrInvalid
	}
	input := map[string]bool{}
	for _, in := range s.Inputs {
		if !id(in.ID) || !id(in.AssetID) || input[in.ID] {
			return ErrInvalid
		}
		input[in.ID] = true
	}
	used := map[string]bool{}
	trackKinds := map[string]bool{}
	clipCount := 0
	for _, track := range s.Tracks {
		if (track.Type != "video" && track.Type != "audio") || trackKinds[track.Type] || len(track.Clips) < 1 {
			return ErrInvalid
		}
		trackKinds[track.Type] = true
		for _, clip := range track.Clips {
			clipCount++
			if !input[clip.Input] {
				return ErrInvalid
			}
			used[clip.Input] = true
			if clip.Trim != nil && (clip.Trim.StartMs < 0 || clip.Trim.StartMs > 600000 || clip.Trim.EndMs != nil && (*clip.Trim.EndMs <= clip.Trim.StartMs || *clip.Trim.EndMs > 600000)) {
				return ErrInvalid
			}
			if clip.Crop != nil && (clip.Crop.X < 0 || clip.Crop.X > 16384 || clip.Crop.Y < 0 || clip.Crop.Y > 16384 || clip.Crop.Width < 2 || clip.Crop.Height < 2 || clip.Crop.Width > 3840 || clip.Crop.Height > 2160) {
				return ErrInvalid
			}
			if clip.Speed != nil && (math.IsNaN(*clip.Speed) || math.IsInf(*clip.Speed, 0) || *clip.Speed < 0.25 || *clip.Speed > 4) {
				return ErrInvalid
			}
			if clip.Rotate != "" && clip.Rotate != "0" && clip.Rotate != "90" && clip.Rotate != "180" && clip.Rotate != "270" {
				return ErrInvalid
			}
			if clip.Mirror != "" && clip.Mirror != "horizontal" && clip.Mirror != "vertical" {
				return ErrInvalid
			}
			if track.Type == "audio" && (clip.Crop != nil || clip.Rotate != "" && clip.Rotate != "0" || clip.Mirror != "") {
				return ErrInvalid
			}
		}
	}
	if clipCount > 24 || len(used) != len(input) {
		return ErrInvalid
	}
	o := s.Output
	if o.Container != "mp4" && o.Container != "webm" && o.Container != "mov" && o.Container != "wav" {
		return ErrInvalid
	}
	if o.FPS < 0 || o.FPS > 60 || o.Width < 0 || o.Width > 3840 || o.Height < 0 || o.Height > 2160 || (o.Width == 0) != (o.Height == 0) || o.Width > 0 && (o.Width < 2 || o.Height < 2 || o.Width%2 != 0 || o.Height%2 != 0) {
		return ErrInvalid
	}
	if o.VideoCodec != "" && o.VideoCodec != "h264" && o.VideoCodec != "libx264" && o.VideoCodec != "vp9" && o.VideoCodec != "libvpx-vp9" {
		return ErrInvalid
	}
	if o.AudioCodec != "" && o.AudioCodec != "aac" && o.AudioCodec != "opus" && o.AudioCodec != "pcm_s16le" {
		return ErrInvalid
	}
	if o.Bucket != "" && o.Bucket != "canvas" {
		return ErrInvalid
	}
	if o.MaxBytes < 0 || o.MaxBytes > 536870912 || o.Preset != "" && o.Preset != "veryfast" && o.Preset != "fast" && o.Preset != "medium" {
		return ErrInvalid
	}
	if o.CRF != nil && (*o.CRF < 18 || *o.CRF > 40) {
		return ErrInvalid
	}
	if o.Container == "wav" && trackKinds["video"] && trackKinds["audio"] {
		return ErrInvalid
	}
	if o.Container == "wav" && (o.Preset != "" || o.CRF != nil || o.VideoCodec != "" || o.FPS != 0 || o.Width != 0 || o.Height != 0 || o.AudioCodec != "" && o.AudioCodec != "pcm_s16le") {
		return ErrInvalid
	}
	return nil
}
func Operation(value string) (string, error) {
	switch value {
	case "CROP", "SPEED", "REVERSE", "ROTATE", "MIRROR", "ROTATE_MIRROR", "TRIM", "CONCAT", "TRANSCODE", "COMPRESS", "EXTRACT_AUDIO", "AUDIO_EXTRACT":
		return value, nil
	case "CROP_DURATION":
		return "TRIM", nil
	case "COMPOSE":
		return "CONCAT", nil
	default:
		return "", ErrInvalid
	}
}
