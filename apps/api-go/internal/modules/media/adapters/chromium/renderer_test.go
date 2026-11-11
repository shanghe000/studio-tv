package chromium

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	mediaHTTP "studiotv.local/service/api/internal/modules/media/adapters/http"
	"studiotv.local/service/api/internal/modules/media/domain"
	"testing"
	"time"
)

func rendererTools(t *testing.T) (string, string, string) {
	t.Helper()
	chrome := os.Getenv("TEST_CHROMIUM_PATH")
	if chrome == "" {
		chrome = "chromium"
	}
	ff := os.Getenv("TEST_FFMPEG_PATH")
	if ff == "" {
		ff = "ffmpeg"
	}
	probe := os.Getenv("TEST_FFPROBE_PATH")
	if probe == "" {
		probe = "ffprobe"
	}
	for _, p := range []string{chrome, ff, probe} {
		if _, e := exec.LookPath(p); e != nil {
			t.Skip("actual Chromium/FFmpeg/FFprobe unavailable")
		}
	}
	return chrome, ff, probe
}
func TestChromiumRendersAuthoredHTMLToPlayableMovie(t *testing.T) {
	chrome, ff, probe := rendererTools(t)
	renderer, e := New(chrome, ff, probe, 8<<20, os.Getenv("TEST_CHROMIUM_SANDBOX_MODE"))
	if e != nil {
		t.Fatal(e)
	}
	html := `<!doctype html><html><head><style>html,body{margin:0}#scene{width:160px;height:96px;background:#123456}#box{width:30px;height:30px;background:#f33;animation:move 1s linear infinite}@keyframes move{from{transform:translateX(0)}to{transform:translateX(100px)}}</style></head><body><main id="scene" data-composition-id="scene" data-duration="0.25" data-width="160" data-height="96"><div id="box"></div></main></body></html>`
	bundle := domain.StudioBundle{ID: "hf_test", Revision: 1, Command: domain.RenderCommand{FPS: 24, Quality: "draft", Format: "mp4"}, Files: []domain.StudioFile{{Path: "index.html", MimeType: "text/html", Content: []byte(html)}}}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	result, e := renderer.Render(ctx, bundle)
	if e != nil {
		t.Fatal("actual authored HTML render", e)
	}
	if result.Width != 160 || result.Height != 96 || result.DurationMs < 240 || result.DurationMs > 300 || result.MimeType != "video/mp4" {
		t.Fatal("render metadata invalid", result.DurationMs)
	}
	path := filepath.Join(t.TempDir(), "actual.mp4")
	os.WriteFile(path, result.Content, 0600)
	if e = exec.CommandContext(ctx, ff, "-v", "error", "-i", path, "-f", "null", "-").Run(); e != nil {
		t.Fatal("render movie cannot decode", e)
	}
	bundle.Command.Composition = "compositions/selected.html"
	bundle.Files = append(bundle.Files, domain.StudioFile{Path: "compositions/selected.html", MimeType: "text/html", Content: []byte(`<html><body><main data-composition-id="actual-scene" data-duration="0.25" data-width="128" data-height="72" style="width:128px;height:72px;background:green">Chosen file</main></body></html>`)})
	selected, e := renderer.Render(ctx, bundle)
	if e != nil || selected.Width != 128 || selected.Height != 72 {
		t.Fatal("requested owned composition file was not actually rendered", selected.Width, selected.Height, e)
	}
	bundle.Command.Composition = "compositions/missing.html"
	if _, e = renderer.Render(ctx, bundle); e == nil {
		t.Fatal("missing composition file admitted")
	}
	bundle.Command.Composition = ""
	bundle.Files = bundle.Files[:1]
	bundle.Files[0].Content = []byte(`<html><script src="http://127.0.0.1:1/private.js"></script><body data-composition-id="scene" data-duration="0.25" data-width="160" data-height="96"></body></html>`)
	if _, e = renderer.Render(ctx, bundle); e == nil {
		t.Fatal("render silently omitted prohibited external script")
	}
	canceled, stop := context.WithCancel(ctx)
	stop()
	if _, e = renderer.Render(canceled, bundle); e == nil {
		t.Fatal("canceled browser render succeeded")
	}
}

func TestChromiumExecutesActualStudioFrameAndEditBridge(t *testing.T) {
	chrome, ff, probe := rendererTools(t)
	renderer, e := New(chrome, ff, probe, 8<<20, os.Getenv("TEST_CHROMIUM_SANDBOX_MODE"))
	if e != nil {
		t.Fatal(e)
	}
	// The actual bridge receives commands in this document, checks authored
	// metadata and DOM, and exposes assertion failures as browser exceptions.
	html := `<html><body style="margin:0"><main data-composition-id="scene" data-duration="0.25" data-width="160" data-height="96" style="position:absolute;left:0;top:0;width:160px;height:96px;background:red"><p id="caption">Old</p></main><script>let ready=false,state=false,timeline=false,edit=false;window.addEventListener('message',e=>{const m=e.data;if(m.source!=='hf-preview')return;if(m.type==='ready'){ready=m.durationInFrames===8&&m.width===160;postMessage({source:'hf-parent',type:'control',action:'seek',frame:3},'*');postMessage({source:'hf-parent',type:'edit',requestId:'actual-edit',action:'apply',target:{id:'caption'},operations:[{type:'text',value:'New real text'}]},'*')}if(m.type==='timeline')timeline=m.durationInFrames===8;if(m.type==='state'&&m.frame===3)state=true;if(m.type==='edit-result'&&m.requestId==='actual-edit')edit=m.data.selection.text==='New real text';if(ready&&state&&timeline&&edit){document.querySelector('main').setAttribute('data-bridge-verified','true');document.querySelector('main').style.background='#00ff00'}});</script>` + mediaHTTP.PreviewBridge("index.html", "") + `<script>window.addEventListener('load',()=>setTimeout(()=>{if(document.querySelector('main').getAttribute('data-bridge-verified')!=='true')throw Error('actual frame/edit bridge failed')},200));</script></body></html>`
	bundle := domain.StudioBundle{ID: "hf_bridge", Revision: 1, Command: domain.RenderCommand{FPS: 24, Quality: "draft", Format: "mp4"}, Files: []domain.StudioFile{{Path: "index.html", MimeType: "text/html", Content: []byte(html)}}}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	result, e := renderer.Render(ctx, bundle)
	if e != nil {
		t.Fatal("actual bridge frame/selection mutation", e)
	}
	path := filepath.Join(t.TempDir(), "bridge.mp4")
	if e = os.WriteFile(path, result.Content, 0600); e != nil {
		t.Fatal(e)
	}
	pixels, e := exec.CommandContext(ctx, ff, "-v", "error", "-i", path, "-vf", "select=eq(n\\,5)", "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1").Output()
	if e != nil || len(pixels) < 3 || pixels[1] < 200 || pixels[0] > 60 || pixels[2] > 60 {
		t.Fatal("last actual movie frame did not reflect verified bridge mutation", e)
	}
}
func TestChromiumConfigurationFailsClosed(t *testing.T) {
	if _, e := New("chrome", "ffmpeg", "probe", 1, "unsupported"); e == nil {
		t.Fatal("unknown browser sandbox accepted")
	}
	if _, e := New("", "ffmpeg", "probe", 1); e == nil {
		t.Fatal("missing browser accepted")
	}
}
