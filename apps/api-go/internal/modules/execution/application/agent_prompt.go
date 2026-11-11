package application

import gateway "studiotv.local/service/api/internal/modules/modelgateway/application"

// AgentCanvasPromptSpec is an explicit new feature template. Existing chat and
// generation templates retain their original instruction bytes and hashes.
func AgentCanvasPromptSpec() *gateway.PromptSpec {
	t := promptTemplate{ref: "studio-tv/assistant/canvas-agent", kinds: []string{"LLM"}, output: textContract(), task: "Help the user develop and revise the current canvas creative project. Use the supplied conversation and references, maintain continuity, and execute requested node and asset changes only through the registered STUDIO tools. Read the current canvas and compatible model catalog before editing or generating. Use exact revisions and capability versions. Treat queued generation as pending, not completed; query actual tasks before reporting their results. On version conflicts, read again and preserve user changes. Report only actions supported by verified tool receipts; explain unavailable functions and failures honestly."}
	spec := t.spec()
	spec.TemplateVersion = "studio-authored-agent-1"
	return spec
}
