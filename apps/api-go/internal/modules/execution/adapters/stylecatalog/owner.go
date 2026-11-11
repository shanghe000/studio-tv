package stylecatalog

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/modules/execution/application"
	"studiotv.local/service/api/internal/modules/execution/domain"
	resources "studiotv.local/service/api/internal/modules/resources/domain"
)

// User recipes are resolved from their owner's resource record, never from a
// client-supplied body or a SYSTEM item with an unregistered hidden prompt.
func (c *Catalog) ownerDefinition(ctx context.Context, owner, id string) (application.StyleDefinition, error) {
	var name string
	var revision int64
	var raw []byte
	err := c.pool.QueryRow(ctx, `SELECT i.name,i.revision,i.content FROM resources.items i WHERE i.id=$1 AND i.family='PROMPT' AND i.scope='USER' AND i.owner_id=$2 AND i.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM resources.asset_refs ar LEFT JOIN public.assets a ON a.id=ar.asset_id AND a.owner_id=ar.owner_id LEFT JOIN public.projects p ON p.id=a.project_id AND p.owner_id=a.owner_id WHERE ar.resource_id=i.id AND (a.id IS NULL OR a.state<>'READY' OR a.deleted_at IS NOT NULL OR p.deleted_at IS NOT NULL))`, id, owner).Scan(&name, &revision, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return application.StyleDefinition{}, domain.ErrNotFound
	}
	if err != nil {
		return application.StyleDefinition{}, err
	}
	var body resources.PromptContent
	if json.Unmarshal(raw, &body) != nil || body.MediaScope != "IMAGE" || (body.PromptType != "STYLE" && body.PromptType != "PROMPT") {
		return application.StyleDefinition{}, domain.ErrInvalid
	}
	key := "customPrompt"
	if body.PromptType == "STYLE" {
		key = "styleLibrary"
	}
	prompt := strings.TrimSpace(strings.Join([]string{body.PrefixPrompt, body.SuffixPrompt}, "\n"))
	if body.PromptType == "STYLE" && strings.TrimSpace(body.PrefixPrompt) != "" {
		prompt = strings.TrimSpace(body.PrefixPrompt)
	}
	def := application.StyleDefinition{SchemaVersion: "1", SourceScope: "USER", Revision: revision, ID: id, Key: key, Label: name, Prompt: prompt, PrefixPrompt: body.PrefixPrompt, SuffixPrompt: body.SuffixPrompt, PromptType: body.PromptType}
	if body.ReferenceAssetID != nil {
		def.ReferenceAssetID = *body.ReferenceAssetID
	}
	return def, nil
}
