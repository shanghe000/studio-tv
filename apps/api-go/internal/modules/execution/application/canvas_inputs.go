package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"

	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func HistoryOutputSHA256(output domain.Output) string {
	body, _ := json.Marshal(output)
	var value any
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if decoder.Decode(&value) == nil {
		// PostgreSQL JSONB normalizes object order and numeric exponent notation.
		// Exact tagged values avoid float rounding and number/string collisions.
		body, _ = json.Marshal(canonicalHistoryValue(value))
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

func canonicalHistoryValue(value any) any {
	switch x := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(x))
		for key := range x {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		pairs := []any{}
		for _, key := range keys {
			pairs = append(pairs, []any{key, canonicalHistoryValue(x[key])})
		}
		return []any{"object", pairs}
	case []any:
		items := []any{}
		for _, item := range x {
			items = append(items, canonicalHistoryValue(item))
		}
		return []any{"array", items}
	case json.Number:
		text := strings.ToLower(x.String())
		negative := strings.HasPrefix(text, "-")
		text = strings.TrimPrefix(text, "-")
		exponent := 0
		if index := strings.IndexByte(text, 'e'); index >= 0 {
			parsed, err := strconv.Atoi(text[index+1:])
			if err != nil || parsed < -1000000 || parsed > 1000000 {
				return []any{"number", x.String()}
			}
			exponent, text = parsed, text[:index]
		}
		if index := strings.IndexByte(text, '.'); index >= 0 {
			exponent -= len(text) - index - 1
			text = text[:index] + text[index+1:]
		}
		text = strings.TrimLeft(text, "0")
		if text == "" {
			return []any{"number", "0"}
		}
		trimmed := strings.TrimRight(text, "0")
		exponent += len(text) - len(trimmed)
		if negative {
			trimmed = "-" + trimmed
		}
		return []any{"number", trimmed + "e" + strconv.Itoa(exponent)}
	case string:
		return []any{"string", x}
	case bool:
		return []any{"boolean", x}
	default:
		return []any{"null"}
	}
}

// Raw documents from canvas script/storyboard nodes are user-authored content.
// A diffusion service accepts text and STUDIO's own visual condition envelopes,
// never arbitrary JSON as a condition. Encode only the document at its original
// position; no information is discarded and no document gains control authority.
func visualDocumentInput(cap gateway.Capability) bool {
	if cap.TestMode || cap.Model == nil {
		return false
	}
	switch cap.Model.ProviderRef {
	case "comfy", "h3", "minimax", "minimax-official", "volcengine-official":
		for _, kind := range cap.OutputKinds {
			if kind == "IMAGE" || kind == "VIDEO" {
				return true
			}
		}
	}
	return false
}
func canvasDocumentNode(source domain.Node) bool {
	return source.Type == "rh-script" || source.Type == "rh-storyboard"
}
func canvasDocumentPart(data json.RawMessage, version string, visual bool) gateway.InputPart {
	if visual {
		var compact bytes.Buffer
		if json.Compact(&compact, data) == nil {
			text := compact.String()
			return gateway.InputPart{Type: "TEXT", Text: &text}
		}
	}
	return gateway.InputPart{Type: "STRUCTURED", SchemaVersion: &version, Data: data}
}
func appendHistoryPart(parts *[]gateway.InputPart, output domain.Output, visualDocument bool) error {
	switch output.Type {
	case "ASSET", "ARTIFACT": // Imported local media remains an owned, versioned asset.
		if output.AssetID == nil || *output.AssetID == "" {
			return domain.ErrNotFound
		}
	case "TEXT":
		if output.Text == nil {
			return domain.ErrNotFound
		}
		text := *output.Text
		*parts = append(*parts, gateway.InputPart{Type: "TEXT", Text: &text})
	case "STRUCTURED":
		if output.SchemaVersion == "" || !json.Valid(output.Data) {
			return domain.ErrNotFound
		}
		version := output.SchemaVersion
		*parts = append(*parts, canvasDocumentPart(output.Data, version, visualDocument))
	default:
		return domain.ErrNotFound
	}
	return nil
}

func historySelection(node domain.Node, project string) (HistoryInputQuery, bool, error) {
	q := HistoryInputQuery{ProjectID: project, NodeID: node.ID}
	read := func(key string) (string, error) {
		raw := node.Data[key]
		if len(raw) == 0 || string(raw) == "null" {
			return "", nil
		}
		var value string
		if json.Unmarshal(raw, &value) != nil || len(value) > 200 {
			return "", domain.ErrInvalid
		}
		return value, nil
	}
	var err error
	q.OutputID, err = read("selectedHistoryOutputId")
	if err != nil {
		return q, false, err
	}
	q.ExecutionID, err = read("selectedOutputHistoryId")
	if err != nil {
		return q, false, err
	}
	if q.OutputID != "" {
		return q, true, nil
	}
	if q.ExecutionID == "" {
		return q, false, err
	}
	var index int
	if json.Unmarshal(node.Data["selectedOutputHistoryIndex"], &index) != nil || index < 0 || index >= 100 {
		return q, false, domain.ErrInvalid
	}
	q.OutputIndex = &index
	return q, true, nil
}

func (s *Service) selectedHistoryInput(ctx context.Context, owner string, q HistoryInputQuery) (HistoryInput, domain.InputReference, error) {
	reader, ok := s.store.(historyInputReader)
	if !ok {
		return HistoryInput{}, domain.InputReference{}, domain.ErrInvalid
	}
	h, err := reader.ResolveHistoryInput(ctx, owner, q)
	if err != nil {
		return h, domain.InputReference{}, err
	}
	ref, err := historyReference(q, h)
	return h, ref, err
}

func historyReference(q HistoryInputQuery, h HistoryInput) (domain.InputReference, error) {
	if h.TaskID == "" || h.ExecutionID == "" || h.Output.ID == "" || h.Output.DeletedAt != nil || q.OutputID != "" && q.OutputID != h.Output.ID || q.ExecutionID != "" && q.ExecutionID != h.ExecutionID {
		return domain.InputReference{}, domain.ErrNotFound
	}
	ref := domain.InputReference{SourceNodeID: q.NodeID, HistoryTaskID: h.TaskID, HistoryExecutionID: h.ExecutionID, HistoryOutputID: h.Output.ID, HistoryOutputSHA256: HistoryOutputSHA256(h.Output), Modality: h.Output.Type}
	if h.Output.AssetID != nil {
		ref.AssetID = *h.Output.AssetID
		ref.Keys = mediaKeys(q.NodeID, ref.AssetID, "")
	}
	return ref, nil
}

func currentHistoryID(node domain.Node) (string, error) {
	raw := node.Data["historyStorage"]
	if len(raw) == 0 || string(raw) == "null" {
		return "", nil
	}
	var storage struct {
		HistoryID string `json:"historyId"`
	}
	if json.Unmarshal(raw, &storage) != nil || len(storage.HistoryID) > 200 {
		return "", domain.ErrInvalid
	}
	return storage.HistoryID, nil
}

func sourceDisplayData(node domain.Node) map[string]json.RawMessage {
	data := map[string]json.RawMessage{}
	for _, key := range []string{"sourceObjects", "imageUrl", "videoUrl", "audioUrl", "assetId", "assetIds"} {
		if raw, ok := node.Data[key]; ok {
			data[key] = raw
		}
	}
	return data
}

func editedSourceText(node domain.Node) (string, bool) {
	if node.Type != "rh-text" {
		return "", false
	}
	for _, key := range []string{"text", "content"} {
		if raw, exists := node.Data[key]; exists {
			var text string
			if json.Unmarshal(raw, &text) == nil {
				return text, true
			}
		}
	}
	return "", false
}

func (s *Service) currentHistoryInputs(ctx context.Context, owner, project string, node domain.Node) ([]HistoryInput, bool, error) {
	eid, err := currentHistoryID(node)
	if err != nil || eid == "" {
		return nil, false, err
	}
	// STUDIO apply() stores the complete result batch plus historyId. Direct
	// displayed media and edited text can subsequently change independently;
	// they retain their current input semantics instead of resurrecting history.
	if _, edited := editedSourceText(node); edited || len(node.Data["applicationInput"]) > 0 {
		return nil, false, nil
	}
	displayed, err := mediaReferences(sourceDisplayData(node), node.ID)
	if err != nil {
		return nil, false, err
	}
	reader, ok := s.store.(interface {
		HistoryDetail(context.Context, string, string) (History, error)
	})
	if !ok {
		if len(displayed) > 0 {
			return nil, false, nil
		}
		return nil, false, domain.ErrInvalid
	}
	h, err := reader.HistoryDetail(ctx, owner, eid)
	if err != nil {
		if errors.Is(err, domain.ErrNotFound) && len(displayed) > 0 {
			return nil, false, nil
		}
		return nil, false, err
	}
	if h.ProjectID == nil || *h.ProjectID != project || h.NodeID != node.ID || h.ExecutionID != eid || h.TaskID == "" || len(h.Outputs) == 0 || len(h.Outputs) > 100 {
		if len(displayed) > 0 {
			return nil, false, nil
		}
		return nil, false, domain.ErrNotFound
	}
	available := map[string]bool{}
	for _, output := range h.Outputs {
		if output.AssetID != nil && output.DeletedAt == nil {
			available[*output.AssetID] = true
		}
	}
	for _, ref := range displayed {
		if !available[ref.AssetID] {
			return nil, false, nil
		}
	}
	// apply() automatically writes the first audio/video URL alongside its
	// whole output batch. A matching display copy does not select index zero.
	inputs := []HistoryInput{}
	for _, output := range h.Outputs {
		inputs = append(inputs, HistoryInput{TaskID: h.TaskID, ExecutionID: h.ExecutionID, Output: output})
	}
	return inputs, true, nil
}

// An ordinary media composer's unselected source renders its first output. An
// explicitly selected history was already resolved from the history store.
// Only narrow the batch with an actual displayed STUDIO URL, verified against this
// very execution. Other consumers still have full-batch history semantics.
func displayedHistoryInputs(source domain.Node, batch []HistoryInput) ([]HistoryInput, error) {
	if len(batch) == 0 {
		return batch, nil
	}
	var raw []json.RawMessage
	if json.Unmarshal(source.Data["output"], &raw) != nil || len(raw) == 0 {
		return batch, nil
	}
	var url string
	if json.Unmarshal(raw[0], &url) != nil {
		var display struct {
			URL string `json:"url"`
		}
		if json.Unmarshal(raw[0], &display) != nil {
			return batch, nil
		}
		url = display.URL
	}
	if !strings.HasPrefix(url, "rhtv-asset:") {
		return batch, nil
	}
	wanted := map[string]bool{strings.TrimPrefix(url, "rhtv-asset:"): true}
	// oNn includes an explicit audio URL alongside its displayed audio.
	if source.Type == "rh-audio" {
		if json.Unmarshal(source.Data["audioUrl"], &url) == nil && strings.HasPrefix(url, "rhtv-asset:") {
			wanted[strings.TrimPrefix(url, "rhtv-asset:")] = true
		}
	}
	rows := []HistoryInput{}
	for _, h := range batch {
		if h.Output.AssetID != nil && h.Output.DeletedAt == nil && wanted[*h.Output.AssetID] {
			rows = append(rows, h)
			delete(wanted, *h.Output.AssetID)
		}
	}
	if len(wanted) > 0 {
		return nil, domain.ErrNotFound
	}
	return rows, nil
}

// Runtime/display state and ordering hints never become media inputs. Only
// selected history resolved from the execution store may supply an old output.
func inputMetadataKey(key string) bool {
	switch strings.ToLower(key) {
	case "output", "outputs", "outputhistory", "nodeoutputhistory", "executionoutputhistory", "history", "historystorage", "executionoutputs", "structuredoutput", "selectedhistoryoutputid", "selectedoutputhistoryid", "selectedoutputhistoryindex", "imageorder", "videoorder", "audioorder", "taskid", "status", "_key":
		return true
	}
	return false
}

func mediaKeys(node, id, key string) []string {
	ref := "rhtv-asset:" + id
	keys := []string{}
	if key != "" {
		keys = append(keys, key)
	}
	if node != "" {
		keys = append(keys, node+"::"+ref)
	}
	keys = append(keys, ref)
	if node != "" {
		keys = append(keys, node)
	}
	return append(keys, id)
}

func mediaReferences(data map[string]json.RawMessage, node string) ([]domain.InputReference, error) {
	var value any
	body, _ := json.Marshal(data)
	if json.Unmarshal(body, &value) != nil {
		return nil, domain.ErrInvalid
	}
	refs := []domain.InputReference{}
	seen := map[string]int{}
	var walk func(any, string, string) error
	walk = func(v any, key, mediaKey string) error {
		switch x := v.(type) {
		case map[string]any:
			if candidate, ok := x["_key"].(string); ok {
				mediaKey = candidate
			}
			keys := make([]string, 0, len(x))
			for k := range x {
				if !inputMetadataKey(k) {
					keys = append(keys, k)
				}
			}
			sort.Strings(keys)
			for _, k := range keys {
				if err := walk(x[k], k, mediaKey); err != nil {
					return err
				}
			}
		case []any:
			for _, child := range x {
				if err := walk(child, key, mediaKey); err != nil {
					return err
				}
			}
		case string:
			id := ""
			if strings.HasPrefix(x, "rhtv-asset:") {
				id = strings.TrimPrefix(x, "rhtv-asset:")
			} else if strings.EqualFold(key, "assetId") || strings.EqualFold(key, "assetIds") {
				id = x
			} else if isMediaKey(key) && x != "" {
				return domain.ErrInvalid
			}
			if id == "" && !(strings.HasPrefix(x, "rhtv-asset:") || strings.EqualFold(key, "assetId") || strings.EqualFold(key, "assetIds")) {
				return nil
			}
			if len(id) < 1 || len(id) > 200 {
				return domain.ErrInvalid
			}
			ref := domain.InputReference{SourceNodeID: node, SourceOrder: len(refs), AssetID: id, Keys: mediaKeys(node, id, mediaKey)}
			if index, ok := seen[id]; ok {
				refs[index].Keys = append(refs[index].Keys, ref.Keys...)
			} else {
				seen[id] = len(refs)
				refs = append(refs, ref)
			}
		}
		return nil
	}
	return refs, walk(value, "", "")
}

func appendMediaReference(refs []domain.InputReference, ref domain.InputReference) []domain.InputReference {
	for i := range refs {
		if refs[i].SourceNodeID == ref.SourceNodeID && refs[i].AssetID == ref.AssetID && ref.AssetID != "" {
			refs[i].Keys = append(refs[i].Keys, ref.Keys...)
			// Preserve every selected history authority even if transport dedupes
			// two sources with the same asset.
			if ref.HistoryTaskID == "" {
				return refs
			}
		}
	}
	return append(refs, ref)
}

func mediaOrder(node domain.Node, kind string) ([][]string, error) {
	key := strings.ToLower(kind) + "Order"
	raw := node.Data[key]
	if len(raw) == 0 {
		var params map[string]json.RawMessage
		_ = json.Unmarshal(node.Data["params"], &params)
		raw = params[key]
	}
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var order []json.RawMessage
	if json.Unmarshal(raw, &order) != nil || len(order) > 1000 {
		return nil, domain.ErrInvalid
	}
	result := make([][]string, 0, len(order))
	for _, item := range order {
		var key string
		keys := []string{}
		if json.Unmarshal(item, &key) == nil {
			keys = append(keys, key)
		} else {
			var identity struct {
				Key     string `json:"_key"`
				URL     string `json:"url"`
				FileURL string `json:"fileUrl"`
				NodeID  string `json:"nodeId"`
			}
			if json.Unmarshal(item, &identity) != nil {
				return nil, domain.ErrInvalid
			}
			url := identity.URL
			if url == "" {
				url = identity.FileURL
			}
			if identity.Key != "" {
				keys = append(keys, identity.Key)
			} else if identity.NodeID != "" && url != "" {
				keys = append(keys, identity.NodeID+"::"+url)
			}
			if url != "" {
				keys = append(keys, url)
			}
			if identity.NodeID != "" {
				keys = append(keys, identity.NodeID)
			}
		}
		if len(keys) == 0 {
			return nil, domain.ErrInvalid
		}
		for _, key := range keys {
			if key == "" || len(key) > 1024 {
				return nil, domain.ErrInvalid
			}
		}
		result = append(result, keys)
	}
	return result, nil
}

// Text/vision generators retain wire order for images too. A reconnect must
// never silently change the meaning of "the first image" in a description.
func canvasTextTarget(node domain.Node) bool {
	return node.Type == "rh-text" || node.Type == "rh-script" || node.Type == "rh-storyboard"
}

// Preserve inherited context ahead of this form. Its own description precedes
// direct inputs, which must follow the current wires rather than canvas z-order.
// Collecting whole source records retains their authenticated history/structure.
func canvasSourceOrder(graph domain.Graph, target string) ([]json.RawMessage, map[string]bool) {
	direct := map[string]bool{}
	for _, e := range graph.Edges {
		if e.Target == target {
			direct[e.Source] = true
		}
	}
	ordered := make([]json.RawMessage, 0, len(graph.Nodes))
	wired := map[string]json.RawMessage{}
	var own json.RawMessage
	for _, raw := range graph.Nodes {
		var id struct{ ID string }
		_ = json.Unmarshal(raw, &id)
		switch {
		case id.ID == target:
			own = raw
		case direct[id.ID]:
			wired[id.ID] = raw
		default:
			ordered = append(ordered, raw)
		}
	}
	if own != nil {
		ordered = append(ordered, own)
	}
	for _, e := range graph.Edges {
		if e.Target == target {
			if raw := wired[e.Source]; raw != nil {
				ordered = append(ordered, raw)
			}
		}
	}
	return ordered, direct
}

// Native forms use incoming wire order for unranked media; the canvas node
// array is display order. Reconnecting a wire appends it after remaining wires.
func orderConnectedReferences(refs []domain.InputReference, graph domain.Graph, target string) {
	ranks := map[string]int{}
	for _, edge := range graph.Edges {
		if edge.Target == target {
			ranks[edge.Source] = len(ranks)
		}
	}
	rank := func(id string) int {
		if n, ok := ranks[id]; ok {
			return n
		}
		return len(ranks)
	}
	sort.SliceStable(refs, func(i, j int) bool { return rank(refs[i].SourceNodeID) < rank(refs[j].SourceNodeID) })
}

func collectReferenceOrder(refs []domain.InputReference, graph domain.Graph) {
	sources := map[string]int{}
	for index, raw := range graph.Nodes {
		var node domain.Node
		_ = json.Unmarshal(raw, &node)
		sources[node.ID] = index
	}
	sort.SliceStable(refs, func(i, j int) bool {
		left, right := sources[refs[i].SourceNodeID], sources[refs[j].SourceNodeID]
		if left != right {
			return left < right
		}
		return refs[i].SourceOrder < refs[j].SourceOrder
	})
}

func orderMediaReferences(refs []domain.InputReference, node domain.Node) ([]domain.InputReference, error) {
	refs = append([]domain.InputReference(nil), refs...)
	for _, kind := range []string{"IMAGE", "VIDEO", "AUDIO"} {
		order, err := mediaOrder(node, kind)
		if err != nil {
			return nil, err
		}
		ranks := map[string]int{}
		for i, keys := range order {
			for _, key := range keys {
				if _, ok := ranks[key]; !ok {
					ranks[key] = i
				}
			}
		}
		indexes := []int{}
		media := []domain.InputReference{}
		for i, ref := range refs {
			if ref.AssetID != "" && ref.Modality == kind {
				indexes = append(indexes, i)
				media = append(media, ref)
			}
		}
		rank := func(ref domain.InputReference) int {
			for _, key := range ref.Keys {
				if n, ok := ranks[key]; ok {
					return n
				}
			}
			return len(order)
		}
		sort.SliceStable(media, func(i, j int) bool { return rank(media[i]) < rank(media[j]) })
		for i, index := range indexes {
			refs[index] = media[i]
		}
	}
	for i := range refs {
		refs[i].Order = i
	}
	return refs, nil
}

func freezeReferenceRoles(refs []domain.InputReference, request gateway.InvocationRequest) {
	assets := map[string]string{}
	for _, a := range request.Attachments {
		assets[a.Ref] = a.SourceRef
	}
	for _, c := range request.PromptSpec.Conditioning {
		for i := range refs {
			if refs[i].AssetID == assets[c.AttachmentRef] {
				refs[i].Role = c.Role
			}
		}
	}
}

func orderRequestMedia(request *gateway.InvocationRequest, refs []domain.InputReference, selection promptSelection) {
	byID := map[string]gateway.Attachment{}
	for _, a := range request.Attachments {
		byID[a.SourceRef] = a
	}
	ordered := []gateway.Attachment{}
	seen := map[string]bool{}
	for _, ref := range refs {
		if a, ok := byID[ref.AssetID]; ok && !seen[a.Ref] {
			ordered = append(ordered, a)
			seen[a.Ref] = true
		}
	}
	for _, a := range request.Attachments {
		if !seen[a.Ref] {
			ordered = append(ordered, a)
		}
	}
	request.Attachments = ordered
	// Explicit conversation messages retain their own content order. Automatic
	// canvas inputs are user task data and may be sorted across their media slots.
	conversationRefs := map[string]bool{}
	for _, message := range selection.Messages {
		for _, id := range message.AssetIDs {
			conversationRefs[byID[id].Ref] = true
		}
	}
	ranks := map[string]int{}
	for i, a := range ordered {
		ranks[a.Ref] = i
	}
	indexes := []int{}
	media := []gateway.InputPart{}
	for i, part := range request.Input {
		if part.Type == "MEDIA" && part.AttachmentRef != nil && !conversationRefs[*part.AttachmentRef] {
			indexes = append(indexes, i)
			media = append(media, part)
		}
	}
	sort.SliceStable(media, func(i, j int) bool { return ranks[*media[i].AttachmentRef] < ranks[*media[j].AttachmentRef] })
	for i, index := range indexes {
		request.Input[index] = media[i]
	}
}
