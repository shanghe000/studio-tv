package application

import (
	"encoding/json"
	"github.com/google/uuid"
	"testing"
)

func TestActionAllowlistAndUint64SeedPreservation(t *testing.T) {
	for _, typ := range []string{"generateAll", "retrySegment", "adoptCandidate", "keepFollowing", "composeSelected", "stopAfterSegment"} {
		raw := json.RawMessage(`{"requestId":"` + uuid.NewString() + `","expectedRevision":2,"type":"` + typ + `"}`)
		if e := ValidateAction(raw); e != nil {
			t.Fatal(typ, e)
		}
	}
	for _, raw := range []string{`{"requestId":"` + uuid.NewString() + `","expectedRevision":1,"type":"execute","command":"rm"}`, `{"requestId":"bad","expectedRevision":1,"type":"generateAll"}`, `{"requestId":"` + uuid.NewString() + `","expectedRevision":1,"type":"generateAll","ownerId":"foreign"}`} {
		if ValidateAction(json.RawMessage(raw)) == nil {
			t.Fatal("unsafe action accepted", raw)
		}
	}
	var p map[string]any
	if e := decode(json.RawMessage(`{"seed":18446744073709551615,"settings":{"seed":"18446744073709551615"}}`), &p); e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(p)
	if string(raw) != `{"seed":18446744073709551615,"settings":{"seed":"18446744073709551615"}}` {
		t.Fatal("seed precision lost", string(raw))
	}
}

func TestPairedAudioCapacityAndIndexValidation(t *testing.T) {
	refs := []Reference{}
	for i := range 9 {
		refs = append(refs, Reference{Kind: "IMAGE", AssetID: string(rune('a' + i))})
	}
	for i := range 3 {
		refs = append(refs, Reference{Kind: "VIDEO", AssetID: string(rune('a' + i))})
	}
	for i := range 3 {
		refs = append(refs, Reference{Kind: "AUDIO", AssetID: string(rune('a' + i))})
	}
	for i := range 3 {
		index := i
		refs = append(refs, Reference{Kind: "AUDIO", AssetID: string(rune('a' + i)), Role: "VIDEO_AUDIO", VideoIndex: &index})
	}
	if e := ValidateReferences(refs); e != nil {
		t.Fatal("valid 18 refs refused", e)
	}
	duplicate := 0
	refs[len(refs)-1].VideoIndex = &duplicate
	if ValidateReferences(refs) == nil {
		t.Fatal("same video audio paired twice")
	}
	invalid := 3
	refs[len(refs)-1].VideoIndex = &invalid
	if ValidateReferences(refs) == nil {
		t.Fatal("missing video accepted")
	}
}
