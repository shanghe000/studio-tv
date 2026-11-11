package domain

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"
)

func TestUserTextWriteBoundariesAndHistoricalReadShapes(t *testing.T) {
	if err := ValidateUserTextParts(json.RawMessage(`[{"type":"TEXT","text":" \n "},{"type":"TEXT","text":"saved"}]`)); err != nil {
		t.Fatal("nonempty whitespace separator rejected in nonblank overall text", err)
	}
	for _, content := range []string{`null`, `[]`, `{}`, `[null]`, `[{"type":"TEXT","text":""}]`, `[{"type":"TEXT","text":" \n\t　"}]`, `[{"type":"TEXT","text":"ok"},{"type":"TEXT","text":""}]`, `[{"type":"TEXT","text":"a\u0000b"}]`, `[{"type":"TEXT","text":"x","role":"ASSISTANT"}]`, `[{"type":"TEXT","text":null}]`, `[{"type":"NATIVE","text":"x"}]`} {
		if !errors.Is(ValidateUserTextParts(json.RawMessage(content)), ErrInvalid) {
			t.Fatalf("invalid text accepted: %s", content)
		}
	}
	for _, content := range []string{`[{"type":"ASSET","assetId":"a"}]`, `[{"type":"STRUCTURED","schemaCode":"s","value":{"n":1}}]`, `[{"type":"TEXT","text":"ok"},{"type":"ASSET","assetId":"a"}]`} {
		if !errors.Is(ValidateUserTextParts(json.RawMessage(content)), ErrMessagePartsUnavailable) {
			t.Fatalf("multimodal falsely writable: %s", content)
		}
	}
	parts := make([]map[string]string, 100)
	for i := range parts {
		parts[i] = map[string]string{"type": "TEXT", "text": " 狐 "}
	}
	content, _ := json.Marshal(parts)
	if err := ValidateUserTextParts(content); err != nil {
		t.Fatal("100 valid parts rejected", err)
	}
	content, _ = json.Marshal(append(parts, parts[0]))
	if !errors.Is(ValidateUserTextParts(content), ErrInvalid) {
		t.Fatal("101 parts accepted")
	}
	content, _ = json.Marshal([]map[string]string{{"type": "TEXT", "text": strings.Repeat("狐", 200001)}})
	if !errors.Is(ValidateUserTextParts(content), ErrInvalid) {
		t.Fatal("overlong text accepted")
	}
	if ValidateParts(json.RawMessage(`[]`)) != nil || ValidateParts(json.RawMessage(`[{"type":"TEXT","text":""}]`)) != nil {
		t.Fatal("historical read contract was tightened")
	}
}

func TestAggregateAppendsServerUserMessageAndAdvancesOnlyAfterValidation(t *testing.T) {
	root, _ := NewConversation("conversation-a", VerifiedActor{OwnerID: "owner-a"}, Create{Kind: Global}, time.Now())
	before := root
	content := json.RawMessage(`[{"type":"TEXT","text":"hi"}]`)
	var conflict *VersionConflict
	if _, err := root.AppendUserText("message-a", content, 2, time.Now()); !errors.As(err, &conflict) || root != before {
		t.Fatal("stale append mutated root")
	}
	if _, err := root.AppendUserText("message-a", json.RawMessage(`[]`), 1, time.Now()); !errors.Is(err, ErrInvalid) || root != before {
		t.Fatal("invalid append mutated root")
	}
	at := time.Now()
	message, err := root.AppendUserText("message-a", content, 1, at)
	if err != nil || message.Sequence != 1 || message.Role != "USER" || root.NextMessageSequence != 2 || root.Revision != 2 || !message.CreatedAt.Equal(at.UTC().Truncate(time.Millisecond)) {
		t.Fatal("message/aggregate projection inconsistent")
	}
	content[0] = ' '
	if message.Content[0] != '[' {
		t.Fatal("message aliases caller content")
	}
	root.NextMessageSequence = math.MaxInt64
	before = root
	if _, err = root.AppendUserText("message-b", message.Content, 2, at); !errors.Is(err, ErrInvalid) || root != before {
		t.Fatal("sequence overflow mutated root")
	}
	root.NextMessageSequence = 2
	root.Revision = math.MaxInt64
	if _, err = root.AppendUserText("message-b", message.Content, math.MaxInt64, at); !errors.Is(err, ErrInvalid) {
		t.Fatal("revision overflow accepted")
	}
}
