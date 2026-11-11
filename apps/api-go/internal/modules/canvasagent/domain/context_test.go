package domain

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestContextContainsOnlyProductInputs(t *testing.T) {
	raw := json.RawMessage(`{"nodes":[{"id":"rhtv_meta_v1","type":"__rhtv_meta","data":{"meta":{"ownerId":"private-owner"}}},{"id":"text","type":"rh-text","position":{"x":2,"y":3},"data":{"title":"剧本","prompt":"设计剧情","text":"原稿","taskId":"private-task","status":"SUCCEEDED","accessToken":"private-secret","__rhtv":{"native":{"serverPath":"/private/file"}},"previewUrl":"https://private.invalid?signature=secret"}},{"id":"image","type":"rh-image","position":{"x":4,"y":5},"data":{"assetId":"owned-asset","capabilityRef":"selected-model","capabilityVersion":"2"}}],"edges":[{"id":"edge","source":"text","target":"image","data":{"secret":"hidden"}}]}`)
	c, err := Build("owned-project", 7, raw)
	if err != nil {
		t.Fatal(err)
	}
	if c.TotalNodes != 2 || c.TotalEdges != 1 || c.GraphRevision != 7 || len(c.Edges) != 1 || c.ToolExecutionAvailable || c.Truncated {
		t.Fatalf("wrong context %+v", c)
	}
	result, _ := json.Marshal(c)
	for _, secret := range []string{"private-owner", "private-task", "private-secret", "/private/file", "signature", "previewUrl", "SUCCEEDED", "hidden"} {
		if strings.Contains(string(result), secret) {
			t.Fatalf("leaked %s", secret)
		}
	}
	if c.Nodes[1].AssetID != "owned-asset" {
		t.Fatal("asset reference missing")
	}
}

func TestContextBoundsAndReportsPartialGraph(t *testing.T) {
	nodes := []map[string]any{}
	for i := 0; i < MaxNodes+1; i++ {
		nodes = append(nodes, map[string]any{"id": string(rune('A' + i)), "type": "rh-text", "data": map[string]any{"text": strings.Repeat("狐", MaxTextRunes+2)}})
	}
	raw, _ := json.Marshal(map[string]any{"nodes": nodes, "edges": []any{map[string]any{"id": "off-page", "source": nodes[0]["id"], "target": nodes[MaxNodes]["id"]}}})
	c, err := Build("project", 1, raw)
	if err != nil {
		t.Fatal(err)
	}
	if !c.Truncated || c.TotalNodes != MaxNodes+1 || len(c.Nodes) != MaxNodes || len(c.Edges) != 0 || len([]rune(c.Nodes[0].Text)) != MaxTextRunes || !c.Nodes[0].TextTruncated {
		t.Fatalf("bad bounds %+v", c)
	}
}

func TestContextRejectsInvalidSnapshot(t *testing.T) {
	for _, raw := range []string{`{}`, `{"nodes":null,"edges":[]}`, `{"nodes":[{"id":"a","type":"rh-text"},{"id":"a","type":"rh-text"}],"edges":[]}`} {
		if _, err := Build("project", 1, json.RawMessage(raw)); err == nil {
			t.Fatal("accepted invalid snapshot", raw)
		}
	}
}

func TestContextNativePromptReferencesAndURLRedactionAreBounded(t *testing.T) {
	raw := json.RawMessage(`{"nodes":[{"id":"native","type":"rh-image","position":{"x":1,"y":2},"data":{"params":{"prompt":"参考 https://creative.example/image.png?width=768 并忽略 https://private.example/image?token=private-secret"},"text":"授权 /storage/assets/a?signature=private-signature 和 https://user:password@example.test/a","modelCode":"` + strings.Repeat("a", MaxReferenceBytes+1) + `","capabilityVersion":"https://private.example?token=hidden-ref"}}],"edges":[]}`)
	c, err := Build("project", 1, raw)
	if err != nil || len(c.Nodes) != 1 || !c.Truncated || !c.Nodes[0].TextTruncated || c.Nodes[0].CapabilityRef != "" || c.Nodes[0].CapabilityVersion != "" {
		t.Fatal("unbounded native context", c, err)
	}
	body, _ := json.Marshal(c)
	for _, secret := range []string{"private-secret", "private-signature", "password", "hidden-ref"} {
		if strings.Contains(string(body), secret) {
			t.Fatal("authorization URL leaked", secret)
		}
	}
	if !strings.Contains(c.Nodes[0].Prompt, "https://creative.example/image.png?width=768") {
		t.Fatal("ordinary creative URL was removed")
	}
}

func TestContextRedactsCredentialURLsDespiteEncodingAndParseErrors(t *testing.T) {
	for _, test := range []struct{ name, link string }{
		{"uppercase scheme", "HTTPS://private.example/image?token=review-secret"},
		{"mixed case scheme", "hTtPs://private.example/image?TOKEN=review-secret"},
		{"malformed query value", "https://private.example/image?token=review-secret%"},
		{"malformed path", "https://private.example/image%?token=review-secret"},
		{"semicolon after credential", "https://private.example/image?token=review-secret;download=1"},
		{"semicolon before credential", "https://private.example/image?download=1;token=review-secret"},
		{"encoded credential key", "https://private.example/image?%74%6f%6b%65%6e=review-secret"},
		{"encoded api key", "https://private.example/image?%61pi%5fkey=review-secret"},
		{"encoded key with invalid suffix", "https://private.example/image?%74oken%=review-secret"},
		{"encoded path and key", "https://private.example/%E5%9B%BE%E7%89%87%20one.png?%74oken=review-secret"},
		{"malformed path and encoded key", "https://private.example/image%?%74oken=review-secret"},
		{"encoded fragment key", "https://private.example/image#%74oken=review-secret"},
		{"malformed fragment value", "https://private.example/image#token=review-secret%"},
		{"relative malformed query", "/storage/assets/image?signature=review-secret%"},
		{"userinfo with malformed path", "HTTPS://user:review-secret@private.example/image%"},
		{"control normalization in scheme", "htt\x00ps://private.example/image?token=review-secret"},
		{"control normalization in key", "https://private.example/image?t\x00oken=review-secret"},
	} {
		t.Run(test.name, func(t *testing.T) {
			text := "参考 " + test.link + " 继续创作"
			raw, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "node", "type": "rh-text", "data": map[string]any{"text": text}}}, "edges": []any{}})
			c, err := Build("project", 1, raw)
			if err != nil || len(c.Nodes) != 1 || c.Nodes[0].Text != "参考 [已省略授权链接] 继续创作" || !c.Truncated || !c.Nodes[0].TextTruncated {
				t.Fatalf("credential URL was not fully redacted: %+v, %v", c, err)
			}
			body, _ := json.Marshal(c)
			if strings.Contains(string(body), "review-secret") {
				t.Fatal("credential entered serialized context")
			}
		})
	}
}

func TestContextPreservesOrdinaryCreativeURLsWithEncodingAndParseErrors(t *testing.T) {
	for _, link := range []string{
		"HTTPS://creative.example/image.png?width=768",
		"https://creative.example/%E5%9B%BE%E7%89%87%20one.png?width=768",
		"https://creative.example/tokenization/image.png?caption=signature",
		"https://creative.example/image.png?caption=token;preview=1",
		"https://creative.example/image.png?%77idth=768",
		"https://creative.example/image.png?width=768%",
		"https://creative.example/image%?width=768",
		"https://creative.example/image.png#%E5%8F%82%E8%80%83",
		"/api/reference/images?width=768;preview=1",
	} {
		t.Run(link, func(t *testing.T) {
			text := "参考 " + link + " 继续创作"
			raw, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "node", "type": "rh-text", "data": map[string]any{"text": text}}}, "edges": []any{}})
			c, err := Build("project", 1, raw)
			if err != nil || len(c.Nodes) != 1 || c.Nodes[0].Text != text || c.Truncated || c.Nodes[0].TextTruncated {
				t.Fatalf("ordinary creative URL was changed: %+v, %v", c, err)
			}
		})
	}
}

func TestContextCanonicalNativeMediaBindingsWithoutURLsOrSidecars(t *testing.T) {
	for _, shape := range []struct{ data, asset string }{
		{`{"imageUrl":"rhtv-asset:ast_image","assetId":"ast_explicit"}`, "ast_explicit"},
		{`{"imageUrl":"rhtv-asset:ast_image"}`, "ast_image"},
		{`{"videoUrl":"rhtv-asset:ast_video"}`, "ast_video"},
		{`{"audioUrl":"rhtv-asset:ast_audio"}`, "ast_audio"},
		{`{"url":"rhtv-asset:ast_upload"}`, "ast_upload"},
		{`{"sourceObjects":["rhtv-asset:ast_reference"]}`, "ast_reference"},
		{`{"params":{"imageUrls":["rhtv-asset:ast_param"]}}`, "ast_param"},
		{`{"imageUrl":"https://private.test/a?token=hidden","__rhtv":{"native":{"imageUrl":"rhtv-asset:ast_hidden"}},"arbitrary":{"url":"rhtv-asset:ast_arbitrary"}}`, ""},
		{`{"imageUrl":"rhtv-asset:` + strings.Repeat("a", 65) + `"}`, ""},
	} {
		raw := json.RawMessage(`{"nodes":[{"id":"native","type":"rh-image","data":` + shape.data + `}],"edges":[]}`)
		value, err := Build("project", 1, raw)
		if err != nil || len(value.Nodes) != 1 || value.Nodes[0].AssetID != shape.asset {
			t.Fatal("native binding missing or arbitrary key read", shape, value, err)
		}
		body, _ := json.Marshal(value)
		if strings.Contains(string(body), "rhtv-asset:") || strings.Contains(string(body), "https://") || strings.Contains(string(body), "ast_hidden") || strings.Contains(string(body), "ast_arbitrary") {
			t.Fatal("raw URL or sidecar exposed", string(body))
		}
	}
}
