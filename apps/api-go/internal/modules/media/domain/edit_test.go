package domain

import (
	"errors"
	"strings"
	"testing"
)

func TestStudioEditsSavedHTMLWithoutRunningScripts(t *testing.T) {
	source := `<html><body><main><p id="caption" style="background:url('data:x;a');color:red">Old</p><p>Keep</p></main><script>throw Error('must never execute')</script></body></html>`
	text, color := "<New & real>", "blue"
	cmd := EditCommand{Target: ElementTarget{ID: "caption"}, Operations: []EditOperation{{Type: "style", Property: "color", Value: &color}, {Type: "text", Value: &text}}}
	edited, err := EditHTML(source, cmd)
	if err != nil || !strings.Contains(edited, "&lt;New &amp; real&gt;") || !strings.Contains(edited, "background:url(&#39;data:x;a&#39;)") || !strings.Contains(edited, "color:blue") || !strings.Contains(edited, "must never execute") {
		t.Fatal("actual HTML edit did not preserve source", edited, err)
	}
	index := 1
	removed, err := EditHTML(source, EditCommand{Target: ElementTarget{Selector: "main > p:nth-of-type(2)", SelectorIndex: new(int)}, Operations: []EditOperation{{Type: "remove"}}})
	if err != nil || strings.Contains(removed, ">Keep<") || !strings.Contains(removed, ">Old<") {
		t.Fatal("real selected element removal", err)
	}
	if _, err = EditHTML(source, EditCommand{Target: ElementTarget{ID: "caption", SelectorIndex: &index}, Operations: cmd.Operations}); !errors.Is(err, ErrElementNotFound) {
		t.Fatal("missing selection accepted", err)
	}
	for _, bad := range []EditCommand{{Target: ElementTarget{ID: "caption"}, Operations: []EditOperation{{Type: "eval", Value: &text}}}, {Target: ElementTarget{ID: "caption"}, Operations: []EditOperation{{Type: "attribute", Property: "onclick", Value: &text}}}, {Target: ElementTarget{Selector: "main:has(p)"}, Operations: []EditOperation{{Type: "remove"}}}} {
		if _, err = EditHTML(source, bad); err == nil {
			t.Fatal("invalid edit accepted")
		}
	}
}
