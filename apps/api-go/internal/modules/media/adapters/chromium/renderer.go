package chromium

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"studiotv.local/service/api/internal/modules/media/application"
	"studiotv.local/service/api/internal/modules/media/domain"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Renderer struct {
	ContainerSandbox                      bool
	ChromiumPath, FFmpegPath, FFprobePath string
	MaxBytes                              int64
}

func New(chrome, ffmpeg, ffprobe string, max int64, modes ...string) (*Renderer, error) {
	if chrome == "" || ffmpeg == "" || ffprobe == "" || max < 1 || max > 536870912 {
		return nil, errors.New("studio renderer configuration invalid")
	}
	mode := "sandbox"
	if len(modes) > 1 {
		return nil, errors.New("studio sandbox configuration invalid")
	}
	if len(modes) == 1 && modes[0] != "" {
		mode = modes[0]
	}
	if mode != "sandbox" && mode != "container" {
		return nil, errors.New("studio sandbox configuration invalid")
	}
	if mode == "container" {
		if _, err := os.Stat("/.dockerenv"); err != nil {
			return nil, errors.New("container browser mode requires an explicit Docker isolation boundary")
		}
	}
	return &Renderer{ChromiumPath: chrome, FFmpegPath: ffmpeg, FFprobePath: ffprobe, MaxBytes: max, ContainerSandbox: mode == "container"}, nil
}

type response struct {
	ID        int64           `json:"id"`
	Result    json.RawMessage `json:"result"`
	Error     json.RawMessage `json:"error"`
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params"`
	SessionID string          `json:"sessionId"`
}
type pipeClient struct {
	input   *os.File
	output  *os.File
	mutex   sync.Mutex
	pending sync.Map
	counter atomic.Int64
	done    chan struct{}
	event   func(response)
}

func (c *pipeClient) read() {
	defer close(c.done)
	buf := make([]byte, 65536)
	message := []byte{}
	for {
		n, err := c.output.Read(buf)
		if n > 0 {
			message = append(message, buf[:n]...)
			for {
				index := bytes.IndexByte(message, 0)
				if index < 0 {
					break
				}
				var r response
				if json.Unmarshal(message[:index], &r) == nil {
					if r.ID > 0 {
						if ch, ok := c.pending.LoadAndDelete(r.ID); ok {
							ch.(chan response) <- r
						}
					} else if c.event != nil {
						c.event(r)
					}
				}
				message = message[index+1:]
			}
			if len(message) > 16<<20 {
				return
			}
		}
		if err != nil {
			return
		}
	}
}
func (c *pipeClient) call(ctx context.Context, session, method string, params any, out any) error {
	id := c.counter.Add(1)
	ch := make(chan response, 1)
	c.pending.Store(id, ch)
	defer c.pending.Delete(id)
	payload := map[string]any{"id": id, "method": method, "params": params}
	if session != "" {
		payload["sessionId"] = session
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	c.mutex.Lock()
	_, err = c.input.Write(append(body, 0))
	c.mutex.Unlock()
	if err != nil {
		return errors.New("studio browser unavailable")
	}
	select {
	case r := <-ch:
		if len(r.Error) > 0 && string(r.Error) != "null" {
			return errors.New("studio browser command failed")
		}
		if out != nil {
			return json.Unmarshal(r.Result, out)
		}
		return nil
	case <-ctx.Done():
		return fmt.Errorf("studio browser %s: %w", method, ctx.Err())
	case <-c.done:
		return errors.New("studio browser closed")
	}
}
func (c *pipeClient) evaluate(ctx context.Context, session, expression string, out any) error {
	var r struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		Exception json.RawMessage `json:"exceptionDetails"`
	}
	if err := c.call(ctx, session, "Runtime.evaluate", map[string]any{"expression": expression, "awaitPromise": true, "returnByValue": true}, &r); err != nil {
		return err
	}
	if len(r.Exception) > 0 {
		return errors.New("studio composition script failed")
	}
	if out != nil {
		return json.Unmarshal(r.Result.Value, out)
	}
	return nil
}

const policy = "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'none'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none';"

func (r *Renderer) Render(ctx context.Context, bundle domain.StudioBundle) (application.RenderResult, error) {
	if bundle.Validate() != nil {
		return application.RenderResult{}, domain.ErrInvalid
	}
	directory, err := os.MkdirTemp("", "studio-studio-render-")
	if err != nil {
		return application.RenderResult{}, err
	}
	defer os.RemoveAll(directory)
	files := map[string]domain.StudioFile{}
	for _, f := range bundle.Files {
		files[f.Path] = f
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return application.RenderResult{}, err
	}
	origin := "http://" + listener.Addr().String()
	server := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		name := strings.TrimPrefix(req.URL.Path, "/")
		if req.Method != "GET" || !domain.ValidPath(name) {
			http.NotFound(w, req)
			return
		}
		f, ok := files[name]
		if !ok {
			http.NotFound(w, req)
			return
		}
		w.Header().Set("Content-Security-Policy", policy)
		w.Header().Set("Content-Type", f.MimeType)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(f.Content)
	})}
	go server.Serve(listener)
	defer server.Close()
	chromeRead, parentWrite, err := os.Pipe()
	if err != nil {
		return application.RenderResult{}, err
	}
	defer chromeRead.Close()
	defer parentWrite.Close()
	parentRead, chromeWrite, err := os.Pipe()
	if err != nil {
		return application.RenderResult{}, err
	}
	defer parentRead.Close()
	defer chromeWrite.Close()
	browser := exec.CommandContext(ctx, r.ChromiumPath, "--headless", "--remote-debugging-pipe", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-extensions", "--disable-sync", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--user-data-dir="+filepath.Join(directory, "profile"), "about:blank")
	if r.ContainerSandbox {
		browser.Args = append(browser.Args, "--no-sandbox")
	}
	browser.ExtraFiles = []*os.File{chromeRead, chromeWrite}
	browser.Stdout = io.Discard
	browser.Stderr = io.Discard
	browser.WaitDelay = time.Second
	if err = browser.Start(); err != nil {
		return application.RenderResult{}, errors.New("studio browser unavailable")
	}
	defer func() { browser.Process.Kill(); browser.Wait() }()
	chromeRead.Close()
	chromeWrite.Close()
	blocked := atomic.Bool{}
	client := &pipeClient{input: parentWrite, output: parentRead, done: make(chan struct{})}
	client.event = func(event response) {
		if event.Method == "Runtime.exceptionThrown" || event.Method == "Network.loadingFailed" {
			blocked.Store(true)
		}
		if event.Method != "Fetch.requestPaused" {
			return
		}
		var p struct {
			RequestID string `json:"requestId"`
			Request   struct {
				URL string `json:"url"`
			} `json:"request"`
		}
		if json.Unmarshal(event.Params, &p) != nil {
			return
		}
		go func() {
			method := "Fetch.failRequest"
			params := map[string]any{"requestId": p.RequestID, "errorReason": "BlockedByClient"}
			if strings.HasPrefix(p.Request.URL, origin+"/") {
				method = "Fetch.continueRequest"
				params = map[string]any{"requestId": p.RequestID}
			} else {
				blocked.Store(true)
			}
			_ = client.call(ctx, event.SessionID, method, params, nil)
		}()
	}
	go client.read()
	command, stop := context.WithTimeout(ctx, 30*time.Second)
	defer stop()
	var created struct {
		TargetID string `json:"targetId"`
	}
	if err = client.call(command, "", "Target.createTarget", map[string]any{"url": "about:blank"}, &created); err != nil {
		return application.RenderResult{}, err
	}
	var attached struct {
		SessionID string `json:"sessionId"`
	}
	if err = client.call(command, "", "Target.attachToTarget", map[string]any{"targetId": created.TargetID, "flatten": true}, &attached); err != nil {
		return application.RenderResult{}, err
	}
	session := attached.SessionID
	for _, m := range []string{"Page.enable", "Runtime.enable", "Network.enable"} {
		if err = client.call(command, session, m, map[string]any{}, nil); err != nil {
			return application.RenderResult{}, err
		}
	}
	if err = client.call(command, session, "Fetch.enable", map[string]any{"patterns": []map[string]any{{"urlPattern": "*"}}}, nil); err != nil {
		return application.RenderResult{}, err
	}
	var navigation struct {
		ErrorText string `json:"errorText"`
	}
	entry := bundle.Command.Composition
	if entry == "" {
		entry = "index.html"
	}
	parts := strings.Split(entry, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	entryURL := origin + "/" + strings.Join(parts, "/")
	if err = client.call(command, session, "Page.navigate", map[string]any{"url": entryURL}, &navigation); err != nil {
		return application.RenderResult{}, err
	}
	if navigation.ErrorText != "" {
		return application.RenderResult{}, errors.New("studio workspace navigation failed: " + navigation.ErrorText)
	}
	ready := false
	for !ready {
		if err = client.evaluate(command, session, `document.readyState==='complete'&&location.href===`+strconv.Quote(entryURL), &ready); err != nil {
			return application.RenderResult{}, err
		}
		if !ready {
			select {
			case <-command.Done():
				return application.RenderResult{}, errors.New("studio workspace page did not become ready")
			case <-time.After(25 * time.Millisecond):
			}
		}
	}
	var metadata struct {
		Duration float64 `json:"duration"`
		Width    int     `json:"width"`
		Height   int     `json:"height"`
	}
	expression := `(()=>{const c=document.querySelector('[data-composition-id]');if(!c)throw Error('composition absent');window.__studioComposition=c;window.__studioTimeline=(window.__timelines||{})[c.getAttribute('data-composition-id')];const t=window.__studioTimeline;const duration=Number(c.getAttribute('data-duration')||c.getAttribute('data-hf-authored-duration')||(t&&typeof t.duration==='function'?t.duration():0));return{duration,width:Number(c.getAttribute('data-width'))||Math.round(c.getBoundingClientRect().width),height:Number(c.getAttribute('data-height'))||Math.round(c.getBoundingClientRect().height)}})()`
	if err = client.evaluate(command, session, expression, &metadata); err != nil || domain.RenderMetadata(metadata.Duration, metadata.Width, metadata.Height) != nil {
		return application.RenderResult{}, errors.New("studio composition dimensions or duration invalid")
	}
	width, height := metadata.Width, metadata.Height
	if bundle.Command.Resolution == "1080p" {
		height = 1080
		width = int(math.Round(float64(metadata.Width) * 1080 / float64(metadata.Height)))
	} else if bundle.Command.Resolution == "4k" {
		height = 2160
		width = int(math.Round(float64(metadata.Width) * 2160 / float64(metadata.Height)))
	}
	width -= width % 2
	height -= height % 2
	if width < 2 || height < 2 || width > 3840 || height > 2160 {
		return application.RenderResult{}, domain.ErrInvalid
	}
	if err = client.call(command, session, "Emulation.setDeviceMetricsOverride", map[string]any{"width": width, "height": height, "deviceScaleFactor": 1, "mobile": false}, nil); err != nil {
		return application.RenderResult{}, err
	}
	if blocked.Load() {
		return application.RenderResult{}, errors.New("studio project needs unavailable external resources or has script errors")
	}
	frames := int(math.Ceil(metadata.Duration * float64(bundle.Command.FPS)))
	if frames > 7200 {
		return application.RenderResult{}, domain.ErrInvalid
	}
	initialize := `(()=>{const c=window.__studioComposition;document.documentElement.style.margin='0';document.body.style.margin='0';c.style.transformOrigin='top left';c.style.transform='scale(` + strconv.FormatFloat(float64(width)/float64(metadata.Width), 'f', 8, 64) + `)';if(window.__studioTimeline&&typeof window.__studioTimeline.pause==='function')window.__studioTimeline.pause();for(const a of document.getAnimations()){a.pause()}return true})()`
	if err = client.evaluate(command, session, initialize, nil); err != nil {
		return application.RenderResult{}, err
	}
	fileBytes := int64(0)
	for i := 0; i < frames; i++ {
		if blocked.Load() {
			return application.RenderResult{}, errors.New("studio project resource or script failed during rendering")
		}
		frameCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		value := float64(i) / float64(bundle.Command.FPS)
		seek := `(async()=>{const time=` + strconv.FormatFloat(value, 'f', 8, 64) + `;const tl=window.__studioTimeline;if(tl&&typeof tl.seek==='function')tl.seek(time,false);for(const a of document.getAnimations()){a.pause();a.currentTime=time*1000}for(const media of document.querySelectorAll('video,audio')){media.pause();const start=Number(media.getAttribute('data-start')||0);const local=Math.max(0,time-start);if(Number.isFinite(media.duration)&&local<=media.duration&&Math.abs(media.currentTime-local)>.001){media.currentTime=local;await Promise.race([new Promise(resolve=>media.addEventListener('seeked',resolve,{once:true})),new Promise(resolve=>setTimeout(resolve,250))])}}await document.fonts.ready;return true})()`
		if err = client.evaluate(frameCtx, session, seek, nil); err != nil {
			cancel()
			return application.RenderResult{}, err
		}
		var screenshot struct {
			Data string `json:"data"`
		}
		err = client.call(frameCtx, session, "Page.captureScreenshot", map[string]any{"format": "png", "captureBeyondViewport": false, "fromSurface": true}, &screenshot)
		cancel()
		if err != nil {
			return application.RenderResult{}, err
		}
		png, err := base64.StdEncoding.DecodeString(screenshot.Data)
		if err != nil || len(png) < 8 || len(png) > 32<<20 {
			return application.RenderResult{}, errors.New("studio frame capture invalid")
		}
		fileBytes += int64(len(png))
		if fileBytes > 2<<30 {
			return application.RenderResult{}, errors.New("studio frame workspace exceeds bound")
		}
		if err = os.WriteFile(filepath.Join(directory, fmt.Sprintf("frame-%06d.png", i)), png, 0600); err != nil {
			return application.RenderResult{}, err
		}
	}
	if blocked.Load() {
		return application.RenderResult{}, errors.New("studio project resource or script failed during rendering")
	}
	type audioClip struct {
		Source   string  `json:"source"`
		Start    float64 `json:"start"`
		Trim     float64 `json:"trim"`
		Duration float64 `json:"duration"`
		Volume   float64 `json:"volume"`
		Rate     float64 `json:"rate"`
	}
	audioClips := []audioClip{}
	if err = client.evaluate(ctx, session, `(()=>[...document.querySelectorAll('audio,video')].filter(m=>!m.muted&&m.volume>0).map(m=>{const parent=m.closest('[data-start]');return{source:m.currentSrc||m.src,start:Number(m.getAttribute('data-start')||(parent&&parent.getAttribute('data-start'))||0),trim:Number(m.getAttribute('data-media-start')||0),duration:Number(m.getAttribute('data-duration')||0),volume:m.volume,rate:m.playbackRate}}))()`, &audioClips); err != nil {
		return application.RenderResult{}, err
	}
	audioFiles := []string{}
	audioFilters := []string{}
	for _, clip := range audioClips {
		u, e := url.Parse(clip.Source)
		if e != nil || u.Scheme != "http" || u.Host != listener.Addr().String() {
			return application.RenderResult{}, errors.New("studio audio must be a saved workspace file")
		}
		name, e := url.PathUnescape(strings.TrimPrefix(u.Path, "/"))
		f, ok := files[name]
		if e != nil || !domain.ValidPath(name) || !ok || clip.Start < 0 || clip.Start > metadata.Duration || clip.Trim < 0 || clip.Trim > 120 || clip.Duration < 0 || clip.Duration > 120 || clip.Volume < 0 || clip.Volume > 1 || clip.Rate < .25 || clip.Rate > 4 {
			return application.RenderResult{}, domain.ErrInvalid
		}
		source := filepath.Join(directory, fmt.Sprintf("audio-source-%d", len(audioFiles)))
		if e = os.WriteFile(source, f.Content, 0600); e != nil {
			return application.RenderResult{}, e
		}
		probe := exec.CommandContext(ctx, r.FFprobePath, "-v", "error", "-protocol_whitelist", "file,pipe", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", source)
		raw, e := probe.Output()
		if e != nil || len(raw) > 1000 {
			return application.RenderResult{}, errors.New("studio audio inspection failed")
		}
		if !strings.Contains(string(raw), "audio") {
			continue
		}
		if len(audioFiles) >= 16 {
			return application.RenderResult{}, errors.New("studio audio track bound exceeded")
		}
		index := len(audioFiles) + 1
		audioFiles = append(audioFiles, source)
		duration := metadata.Duration - clip.Start
		if clip.Duration > 0 && clip.Duration < duration {
			duration = clip.Duration
		}
		filter := fmt.Sprintf("[%d:a]atrim=start=%.6f:duration=%.6f,asetpts=PTS-STARTPTS", index, clip.Trim, duration*clip.Rate)
		rate := clip.Rate
		for rate > 2 {
			filter += ",atempo=2"
			rate /= 2
		}
		for rate < .5 {
			filter += ",atempo=.5"
			rate /= .5
		}
		filter += fmt.Sprintf(",atempo=%.6f,volume=%.6f,adelay=%d:all=1[a%d]", rate, clip.Volume, int(math.Round(clip.Start*1000)), index)
		audioFilters = append(audioFilters, filter)
	}
	out := filepath.Join(directory, "output."+bundle.Command.Format)
	args := []string{"-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file,pipe", "-threads", "2", "-framerate", strconv.Itoa(bundle.Command.FPS), "-i", filepath.Join(directory, "frame-%06d.png")}
	for _, source := range audioFiles {
		args = append(args, "-i", source)
	}
	if len(audioFiles) > 0 {
		labels := ""
		for i := range audioFiles {
			labels += fmt.Sprintf("[a%d]", i+1)
		}
		audioFilters = append(audioFilters, fmt.Sprintf("%samix=inputs=%d:normalize=0,apad,atrim=duration=%.6f[audio]", labels, len(audioFiles), float64(frames)/float64(bundle.Command.FPS)))
		args = append(args, "-filter_complex", strings.Join(audioFilters, ";"), "-map", "0:v:0", "-map", "[audio]")
		codec := "aac"
		if bundle.Command.Format == "webm" {
			codec = "libopus"
		}
		args = append(args, "-c:a", codec, "-ar", "48000", "-ac", "2")
	} else {
		args = append(args, "-an")
	}
	crf := 23
	if bundle.Command.Quality == "draft" {
		crf = 30
	} else if bundle.Command.Quality == "high" {
		crf = 18
	}
	typ := "video/mp4"
	if bundle.Command.Format == "webm" {
		args = append(args, "-c:v", "libvpx-vp9", "-crf", strconv.Itoa(crf), "-b:v", "0")
		typ = "video/webm"
	} else {
		args = append(args, "-c:v", "libx264", "-preset", "fast", "-crf", strconv.Itoa(crf), "-movflags", "+faststart")
		if bundle.Command.Format == "mov" {
			typ = "video/quicktime"
		}
	}
	args = append(args, "-pix_fmt", "yuv420p", "-fs", strconv.FormatInt(r.MaxBytes, 10), out)
	encode := exec.CommandContext(ctx, r.FFmpegPath, args...)
	encode.Stdout = io.Discard
	encode.Stderr = io.Discard
	encode.WaitDelay = time.Second
	if err = encode.Run(); err != nil {
		return application.RenderResult{}, errors.New("studio video encoding failed")
	}
	// A size-limited encoder may exit successfully with a truncated movie. Verify
	// the actual complete duration before admitting the output as a real render.
	probe := exec.CommandContext(ctx, r.FFprobePath, "-v", "error", "-protocol_whitelist", "file,pipe", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", out)
	raw, err := probe.Output()
	if err != nil || len(raw) > 100 {
		return application.RenderResult{}, errors.New("studio output inspection failed")
	}
	actual, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
	expected := float64(frames) / float64(bundle.Command.FPS)
	if err != nil || math.Abs(actual-expected) > 0.1 {
		return application.RenderResult{}, errors.New("studio render output incomplete")
	}
	file, err := os.Open(out)
	if err != nil {
		return application.RenderResult{}, err
	}
	defer file.Close()
	body, err := io.ReadAll(io.LimitReader(file, r.MaxBytes+1))
	if err != nil || len(body) < 1 || int64(len(body)) > r.MaxBytes {
		return application.RenderResult{}, errors.New("studio output exceeds bound")
	}
	return application.RenderResult{Content: body, MimeType: typ, DurationMs: int64(math.Round(actual * 1000)), Width: width, Height: height}, nil
}

var _ application.StudioRenderer = (*Renderer)(nil)
