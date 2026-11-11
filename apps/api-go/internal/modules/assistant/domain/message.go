package domain

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

// Parts are retained as JSON to preserve structured number precision. They are
// checked on read. Only user TEXT parts may be appended; structured validation
// and owned READY media authorization remain unimplemented.
type Message struct {
	ID             string
	ConversationID string
	Sequence       int64
	Role           string
	Content        json.RawMessage
	CreatedAt      time.Time
}

var ErrMessagePartsUnavailable = errors.New("multimodal message writes are not implemented")

// ValidateUserTextParts deliberately keeps the historical read shape broader
// than the write shape. Every TEXT part is nonempty, and the whole text cannot
// be whitespace. Whitespace-only parts may preserve separators in a message.
func ValidateUserTextParts(content json.RawMessage) error {
	if !utf8.Valid(content) || ValidateParts(content) != nil {
		return ErrInvalid
	}
	var parts []map[string]json.RawMessage
	if json.Unmarshal(content, &parts) != nil || len(parts) < 1 {
		return ErrInvalid
	}
	unsupported := false
	hasText := false
	for _, part := range parts {
		var kind, text string
		_ = json.Unmarshal(part["type"], &kind)
		if kind != "TEXT" {
			unsupported = true
			continue
		}
		_ = json.Unmarshal(part["text"], &text)
		if text == "" || strings.ContainsRune(text, '\x00') {
			return ErrInvalid
		}
		hasText = hasText || strings.TrimSpace(text) != ""
	}
	if unsupported {
		return ErrMessagePartsUnavailable
	}
	if !hasText {
		return ErrInvalid
	}
	return nil
}

// AppendUserText allocates the sequence on a locked aggregate. The caller must
// persist the message, advanced root and idempotency receipt in the same UoW.
func (c *Conversation) AppendUserText(id string, content json.RawMessage, expected int64, at time.Time) (Message, error) {
	return c.appendUserParts(id, content, expected, at, ValidateUserTextParts)
}
func (c *Conversation) AppendUserParts(id string, content json.RawMessage, expected int64, at time.Time) (Message, error) {
	return c.appendUserParts(id, content, expected, at, ValidateUserParts)
}
func (c *Conversation) appendUserParts(id string, content json.RawMessage, expected int64, at time.Time, validate func(json.RawMessage) error) (Message, error) {
	if c.DeletedAt != nil {
		return Message{}, ErrConversationNotFound
	}
	if expected < 1 {
		return Message{}, ErrInvalid
	}
	if c.Revision != expected {
		return Message{}, &VersionConflict{Current: c.Revision}
	}
	if !ValidID(id) || !ValidID(c.ID) || c.OwnerID == "" || (c.Kind != Global && c.Kind != Canvas && c.Kind != HF) || at.IsZero() || c.Revision < 1 || c.Revision == math.MaxInt64 || c.NextMessageSequence < 1 || c.NextMessageSequence == math.MaxInt64 {
		return Message{}, ErrInvalid
	}
	if err := validate(content); err != nil {
		return Message{}, err
	}
	at = at.UTC().Truncate(time.Millisecond)
	message := Message{ID: id, ConversationID: c.ID, Sequence: c.NextMessageSequence, Role: "USER", Content: append(json.RawMessage(nil), content...), CreatedAt: at}
	if !c.TitleGenerated && IsPlaceholderTitle(c.Title) {
		if title := SuggestedConversationTitle(content); title != "" {
			c.Title = title
			c.TitleGenerated = true
		}
	}
	c.NextMessageSequence++
	c.Revision++
	c.UpdatedAt = at
	return message, nil
}
func ValidateUserParts(content json.RawMessage) error {
	if !utf8.Valid(content) || ValidateParts(content) != nil {
		return ErrInvalid
	}
	var parts []map[string]json.RawMessage
	if json.Unmarshal(content, &parts) != nil || len(parts) < 1 {
		return ErrInvalid
	}
	hasContent := false
	for _, part := range parts {
		var kind, text string
		_ = json.Unmarshal(part["type"], &kind)
		switch kind {
		case "TEXT":
			_ = json.Unmarshal(part["text"], &text)
			if text == "" || strings.ContainsRune(text, '\x00') {
				return ErrInvalid
			}
			hasContent = hasContent || strings.TrimSpace(text) != ""
		case "ASSET":
			hasContent = true
		case "STRUCTURED":
			var code string
			_ = json.Unmarshal(part["schemaCode"], &code)
			if code != "ASSISTANT_SKILL_V1" {
				return ErrMessagePartsUnavailable
			}
			var skill struct {
				SkillID  string `json:"skillId"`
				Revision int64  `json:"revision"`
				Version  string `json:"version"`
				Markdown string `json:"markdown"`
				Files    []struct {
					Path    string `json:"path"`
					Content string `json:"content"`
				} `json:"files"`
			}
			decoder := json.NewDecoder(strings.NewReader(string(part["value"])))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&skill) != nil || !ValidID(skill.SkillID) || skill.Revision < 1 || skill.Version == "" || len(skill.Markdown) > 200000 || len(skill.Files) > 100 {
				return ErrInvalid
			}
			for _, file := range skill.Files {
				if file.Path == "" || len(file.Path) > 300 || len(file.Content) > 200000 {
					return ErrInvalid
				}
			}
			hasContent = true
		default:
			return ErrMessagePartsUnavailable
		}
	}
	if !hasContent {
		return ErrInvalid
	}
	return nil
}
func HasSkillParts(content json.RawMessage) bool {
	var parts []struct {
		Type       string `json:"type"`
		SchemaCode string `json:"schemaCode"`
	}
	_ = json.Unmarshal(content, &parts)
	for _, p := range parts {
		if p.Type == "STRUCTURED" && p.SchemaCode == "ASSISTANT_SKILL_V1" {
			return true
		}
	}
	return false
}
func MessageAssetIDs(content json.RawMessage) []string {
	var parts []struct {
		Type    string `json:"type"`
		AssetID string `json:"assetId"`
	}
	_ = json.Unmarshal(content, &parts)
	ids := []string{}
	seen := map[string]bool{}
	for _, p := range parts {
		if p.Type == "ASSET" && !seen[p.AssetID] {
			ids = append(ids, p.AssetID)
			seen[p.AssetID] = true
		}
	}
	return ids
}

func ValidateParts(content json.RawMessage) error {
	var parts []map[string]json.RawMessage
	if json.Unmarshal(content, &parts) != nil || parts == nil || len(parts) > 100 {
		return ErrInvalid
	}
	for _, part := range parts {
		var kind string
		if json.Unmarshal(part["type"], &kind) != nil {
			return ErrInvalid
		}
		switch kind {
		case "TEXT":
			if len(part) != 2 || !validString(part["text"], 0, 200000) {
				return ErrInvalid
			}
		case "ASSET":
			if len(part) != 2 || !validString(part["assetId"], 1, 200) {
				return ErrInvalid
			}
		case "STRUCTURED":
			var value map[string]json.RawMessage
			if len(part) != 3 || !validString(part["schemaCode"], 0, 100) || json.Unmarshal(part["value"], &value) != nil || value == nil {
				return ErrInvalid
			}
		default:
			return ErrInvalid
		}
	}
	return nil
}
func validString(raw json.RawMessage, min, max int) bool {
	// json.Unmarshal accepts null for a string; null is not a contract string.
	if len(raw) == 0 || raw[0] != '"' {
		return false
	}
	var value string
	if json.Unmarshal(raw, &value) != nil || !utf8.ValidString(value) {
		return false
	}
	n := utf8.RuneCountInString(value)
	return n >= min && n <= max
}
