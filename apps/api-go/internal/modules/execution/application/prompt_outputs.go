package application

import (
	"encoding/json"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

// A provider success receipt is insufficient when the selected STUDIO feature
// requires a specific result. Generic mock text cannot satisfy structured tools.
func validatePromptOutput(request gateway.InvocationRequest, invocation gateway.Invocation) error {
	if err := validateNativeStyleOutput(request, invocation); err != nil {
		return err
	}
	if err := validateNativeRegionOutput(request, invocation); err != nil {
		return err
	}
	if request.PromptSpec == nil || request.PromptSpec.OutputContract == nil {
		return promptFault("PROMPT_SPEC_INVALID")
	}
	contract := request.PromptSpec.OutputContract
	switch contract.Type {
	case "TEXT":
		for _, part := range invocation.OutputParts {
			if part.Type != "TEXT" || part.Text == nil || strings.TrimSpace(*part.Text) == "" {
				return promptFault("PROMPT_OUTPUT_INVALID")
			}
		}
		if len(invocation.OutputParts) == 0 {
			return promptFault("PROMPT_OUTPUT_INVALID")
		}
	case "MEDIA":
		media := false
		for _, part := range invocation.OutputParts {
			if part.Type == "ARTIFACT" && part.ArtifactRef != nil {
				media = true
			}
		}
		if !media {
			return promptFault("PROMPT_OUTPUT_INVALID")
		}
	case "JSON_SCHEMA":
		if contract.Schema == nil || contract.Strict == nil || !*contract.Strict || len(invocation.OutputParts) != 1 {
			return promptFault("PROMPT_OUTPUT_INVALID")
		}
		part := invocation.OutputParts[0]
		var value any
		switch part.Type {
		case "TEXT":
			if part.Text == nil || json.Unmarshal([]byte(*part.Text), &value) != nil {
				return promptFault("PROMPT_OUTPUT_INVALID")
			}
		case "STRUCTURED":
			if part.SchemaVersion == nil || contract.SchemaVersion == nil || *part.SchemaVersion != *contract.SchemaVersion || json.Unmarshal(part.Data, &value) != nil {
				return promptFault("PROMPT_OUTPUT_INVALID")
			}
		default:
			return promptFault("PROMPT_OUTPUT_INVALID")
		}
		var document map[string]any
		if json.Unmarshal(contract.Schema, &document) != nil {
			return promptFault("PROMPT_SPEC_INVALID")
		}
		compiler := jsonschema.NewCompiler()
		compiler.AssertFormat()
		if compiler.AddResource("https://studio.local/output-schema", document) != nil {
			return promptFault("PROMPT_SPEC_INVALID")
		}
		schema, err := compiler.Compile("https://studio.local/output-schema")
		if err != nil {
			return promptFault("PROMPT_SPEC_INVALID")
		}
		if schema.Validate(value) != nil {
			return promptFault("PROMPT_OUTPUT_INVALID")
		}
	default:
		return promptFault("PROMPT_SPEC_INVALID")
	}
	return nil
}
