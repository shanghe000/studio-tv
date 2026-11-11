package codexappserver

import (
	"context"
	"encoding/json"
	"strings"

	app "studiotv.local/service/api/internal/modules/agentrun/application"
)

type nativeItem struct {
	Type         string          `json:"type"`
	ID           string          `json:"id"`
	Text         *string         `json:"text"`
	Phase        *string         `json:"phase"`
	Delivery     *string         `json:"delivery"`
	Questions    json.RawMessage `json:"questions"`
	Tool         string          `json:"tool"`
	Namespace    string          `json:"namespace"`
	Arguments    json.RawMessage `json:"arguments"`
	Status       string          `json:"status"`
	Success      *bool           `json:"success"`
	ContentItems []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"contentItems"`
}
type nativeTurn struct {
	ID        string       `json:"id"`
	Status    string       `json:"status"`
	Items     []nativeItem `json:"items"`
	ItemsView string       `json:"itemsView"`
}
type nativeThread struct {
	ID             string       `json:"id"`
	CLIVersion     string       `json:"cliVersion"`
	Cwd            string       `json:"cwd"`
	HistoryMode    string       `json:"historyMode"`
	ParentThreadID *string      `json:"parentThreadId"`
	Turns          []nativeTurn `json:"turns"`
}
type nativeThreadResponse struct {
	Thread          nativeThread `json:"thread"`
	Model           string       `json:"model"`
	ReasoningEffort *string      `json:"reasoningEffort"`
	Cwd             string       `json:"cwd"`
	ApprovalPolicy  string       `json:"approvalPolicy"`
	Sandbox         struct {
		Type string `json:"type"`
	} `json:"sandbox"`
	InstructionSources []string `json:"instructionSources"`
}

// Optional read-only receipt hydration is implemented by STUDIO's durable broker.
// It may read only an existing terminal frozen call and never execute it.
type receiptVerifier interface {
	VerifyToolReceipt(context.Context, app.RuntimeToolCall) (app.RuntimeToolResult, error)
}

func validThreadResponse(v nativeThreadResponse, r app.RuntimeRequest) bool {
	return identity(v.Thread.ID) && v.Thread.CLIVersion == RuntimeVersion && v.Thread.HistoryMode == HistoryMode && v.Thread.ParentThreadID == nil && v.Thread.Cwd == Workspace && v.Cwd == Workspace && v.Model == r.Model && v.ReasoningEffort != nil && *v.ReasoningEffort == r.Effort && v.ApprovalPolicy == "never" && v.Sandbox.Type == "readOnly" && len(v.InstructionSources) == 0
}
func supportedMessage(item nativeItem) bool {
	if item.Text == nil || item.Delivery != nil {
		return false
	}
	if item.Phase != nil && *item.Phase != "commentary" && *item.Phase != "final_answer" {
		return false
	}
	if len(item.Questions) > 0 && string(item.Questions) != "null" {
		var q []json.RawMessage
		if json.Unmarshal(item.Questions, &q) != nil || len(q) > 0 {
			return false
		}
	}
	return true
}
func itemDigest(item nativeItem) string { return digest(item) }
func validateNotification(n notification, threadID, turnID string, completed map[string]string) (bool, error) {
	var p struct {
		ThreadID string     `json:"threadId"`
		TurnID   string     `json:"turnId"`
		Turn     nativeTurn `json:"turn"`
		Item     nativeItem `json:"item"`
	}
	if json.Unmarshal(n.params, &p) != nil {
		return false, ErrProtocol
	}
	if n.method == "turn/started" || n.method == "turn/completed" {
		p.TurnID = p.Turn.ID
	}
	if p.ThreadID != threadID || p.TurnID != turnID {
		return false, nil
	}
	switch n.method {
	case "item/started", "item/completed":
		if !identity(p.Item.ID) {
			return false, ErrProtocol
		}
		switch p.Item.Type {
		case "userMessage", "reasoning":
		case "agentMessage":
			if !supportedMessage(p.Item) {
				return false, ErrProfile
			}
		case "dynamicToolCall":
			if p.Item.Namespace != "" || !toolName.MatchString(p.Item.Tool) {
				return false, ErrProfile
			}
		default:
			return false, ErrProfile
		}
		// Native dynamic-tool events may truncate results. Its full authoritative
		// item is compared with the persisted ToolBroker receipt below.
		if n.method == "item/completed" && p.Item.Type == "agentMessage" {
			completed[p.Item.ID] = itemDigest(p.Item)
		}
	case "turn/completed":
		return true, nil
	case "model/rerouted":
		return false, ErrProfile
	}
	return false, nil
}
func verifyCompletedItems(completed map[string]string, items []nativeItem) error {
	seen := map[string]bool{}
	for _, item := range items {
		if hash, ok := completed[item.ID]; ok {
			if hash != itemDigest(item) {
				return ErrUnknown
			}
			seen[item.ID] = true
		}
	}
	for id := range completed {
		if !seen[id] {
			return ErrUnknown
		}
	}
	return nil
}
func finishFromSnapshot(ctx context.Context, t *transport, c *checkpoint, h app.ToolHandler) (app.RuntimeResult, error) {
	if c.Calls == nil {
		c.Calls = map[string]callEvidence{}
	}
	var snapshot struct {
		Thread nativeThread `json:"thread"`
	}
	if c.HistoryMode != HistoryMode {
		return app.RuntimeResult{}, ErrUnknown
	}
	if t.call(ctx, "thread/read", map[string]any{"threadId": c.ThreadID, "includeTurns": false}, &snapshot) != nil {
		return app.RuntimeResult{}, ErrUnknown
	}
	if snapshot.Thread.ID != c.ThreadID || snapshot.Thread.CLIVersion != RuntimeVersion || snapshot.Thread.HistoryMode != c.HistoryMode || snapshot.Thread.Cwd != Workspace || snapshot.Thread.ParentThreadID != nil {
		return app.RuntimeResult{}, ErrProfile
	}
	turn, err := readCompletedTurn(ctx, t, c.ThreadID, c.TurnID)
	if err != nil {
		return app.RuntimeResult{}, err
	}
	switch turn.Status {
	case "completed":
	case "failed":
		return app.RuntimeResult{}, ErrTurnFailed
	case "interrupted":
		return app.RuntimeResult{}, ErrCanceled
	default:
		return app.RuntimeResult{}, ErrUnknown
	}
	if turn.Items == nil || turn.ItemsView != "full" || len(turn.Items) > 1024 {
		return app.RuntimeResult{}, ErrUnknown
	}
	seen := map[string]bool{}
	calls := map[string]bool{}
	texts := []string{}
	total := 0
	for _, item := range turn.Items {
		if !identity(item.ID) || seen[item.ID] {
			return app.RuntimeResult{}, ErrProtocol
		}
		seen[item.ID] = true
		switch item.Type {
		case "userMessage", "reasoning":
		case "agentMessage":
			if !supportedMessage(item) {
				return app.RuntimeResult{}, ErrProfile
			}
			if item.Phase != nil && *item.Phase == "commentary" {
				continue
			}
			text := *item.Text
			total += len(text)
			if strings.TrimSpace(text) == "" || total > 1<<20 || credentialText.MatchString(text) || strings.Contains(text, c.ThreadID) || strings.Contains(text, c.TurnID) || strings.Contains(text, "/runtime/codex") || strings.Contains(text, "/run/company-codex") {
				return app.RuntimeResult{}, ErrProfile
			}
			texts = append(texts, text)
		case "dynamicToolCall":
			evidence, ok := c.Calls[item.ID]
			if !ok {
				verifier, available := h.(receiptVerifier)
				if !available || item.Namespace != "" || !toolName.MatchString(item.Tool) || !json.Valid(item.Arguments) || len(item.Arguments) > 128<<10 {
					return app.RuntimeResult{}, ErrUnknown
				}
				receipt, err := verifier.VerifyToolReceipt(ctx, app.RuntimeToolCall{ThreadID: c.ThreadID, TurnID: c.TurnID, CallID: item.ID, Name: item.Tool, Namespace: item.Namespace, Arguments: item.Arguments})
				if err != nil || !json.Valid(receipt.Output) || len(receipt.Output) > 256<<10 || credentialText.Match(receipt.Output) {
					return app.RuntimeResult{}, ErrUnknown
				}
				output, normalizeErr := canonicalOutput(receipt.Output)
				if normalizeErr != nil {
					return app.RuntimeResult{}, ErrUnknown
				}
				evidence = callEvidence{Name: item.Tool, Namespace: item.Namespace, ArgumentsHash: argumentDigest(item.Arguments), Success: receipt.Success, Output: output}
				c.Calls[item.ID] = evidence
				ok = true
			}
			if !ok || item.Namespace != "" || item.Tool != evidence.Name || item.Namespace != evidence.Namespace || argumentDigest(item.Arguments) != evidence.ArgumentsHash || item.Success == nil || *item.Success != evidence.Success || len(item.ContentItems) != 1 || item.ContentItems[0].Type != "inputText" || item.ContentItems[0].Text != string(evidence.Output) {
				return app.RuntimeResult{}, ErrUnknown
			}
			if item.Status != "completed" && item.Status != "failed" || evidence.Success && item.Status != "completed" {
				return app.RuntimeResult{}, ErrUnknown
			}
			calls[item.ID] = true
		default:
			return app.RuntimeResult{}, ErrProfile
		}
	}
	if len(texts) == 0 || len(calls) != len(c.Calls) {
		return app.RuntimeResult{}, ErrUnknown
	}
	rawCheckpoint := marshalCheckpoint(c)
	if len(rawCheckpoint) > 4<<20 || h.SaveCheckpoint(ctx, rawCheckpoint) != nil {
		return app.RuntimeResult{}, ErrUnknown
	}
	t.lastSnapshot = turn.Items
	return app.RuntimeResult{Text: strings.Join(texts, "\n\n"), TerminalVerified: true, Checkpoint: marshalCheckpoint(c)}, nil
}

// Exhaust bounded paginated turn history, then require a full target item view.
// Every observed dynamic-tool item must still match its durable STUDIO receipt.
func readCompletedTurn(ctx context.Context, t *transport, threadID, turnID string) (*nativeTurn, error) {
	var target *nativeTurn
	cursor := ""
	cursors, turns := map[string]bool{}, map[string]bool{}
	for pageIndex := 0; pageIndex < 8; pageIndex++ {
		params := map[string]any{"threadId": threadID, "itemsView": "full", "limit": 32, "sortDirection": "desc"}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var page struct {
			Data       []nativeTurn `json:"data"`
			NextCursor *string      `json:"nextCursor"`
		}
		if t.call(ctx, "thread/turns/list", params, &page) != nil {
			return nil, ErrUnknown
		}
		if page.Data == nil || len(page.Data) > 32 || len(page.Data) == 0 && page.NextCursor != nil {
			return nil, ErrProtocol
		}
		for _, turn := range page.Data {
			if !identity(turn.ID) || turns[turn.ID] {
				return nil, ErrProtocol
			}
			turns[turn.ID] = true
			if turn.ID == turnID {
				copy := turn
				target = &copy
			}
		}
		if page.NextCursor == nil {
			if target == nil {
				return nil, ErrUnknown
			}
			switch target.ItemsView {
			case "full":
				return target, nil
			case "summary", "notLoaded":
				items, err := readTurnItems(ctx, t, threadID, turnID)
				if err != nil {
					return nil, err
				}
				target.Items, target.ItemsView = items, "full"
				return target, nil
			default:
				return nil, ErrUnknown
			}
		}
		if !validCursor(*page.NextCursor) || cursors[*page.NextCursor] {
			return nil, ErrProtocol
		}
		cursor = *page.NextCursor
		cursors[cursor] = true
	}
	return nil, ErrUnknown
}

func validCursor(cursor string) bool {
	return len(cursor) > 0 && len(cursor) <= 4096 && !strings.ContainsAny(cursor, "\x00\r\n")
}

func readTurnItems(ctx context.Context, t *transport, threadID, turnID string) ([]nativeItem, error) {
	items := []nativeItem{}
	cursor := ""
	cursors, ids := map[string]bool{}, map[string]bool{}
	for pageIndex := 0; pageIndex < 8; pageIndex++ {
		params := map[string]any{"threadId": threadID, "turnId": turnID, "limit": 128, "sortDirection": "asc"}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var page struct {
			Data []struct {
				TurnID string     `json:"turnId"`
				Item   nativeItem `json:"item"`
			} `json:"data"`
			NextCursor *string `json:"nextCursor"`
		}
		if t.call(ctx, "thread/items/list", params, &page) != nil {
			return nil, ErrUnknown
		}
		if page.Data == nil || len(page.Data) > 128 || len(page.Data) == 0 && page.NextCursor != nil {
			return nil, ErrProtocol
		}
		for _, entry := range page.Data {
			if entry.TurnID != turnID || !identity(entry.Item.ID) || ids[entry.Item.ID] {
				return nil, ErrProtocol
			}
			ids[entry.Item.ID] = true
			items = append(items, entry.Item)
		}
		if page.NextCursor == nil {
			return items, nil
		}
		if !validCursor(*page.NextCursor) || cursors[*page.NextCursor] {
			return nil, ErrProtocol
		}
		cursor = *page.NextCursor
		cursors[cursor] = true
	}
	return nil, ErrUnknown
}
