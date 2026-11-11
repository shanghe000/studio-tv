package application

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

const nativeRegionFeature = "studio-tv/feature/image.region-recognize"
const nativeRegionScene = "studio-tv/scene/canvas-image-region-recognize"
const nativeRegionTemplateVersion = "studio-native-region-bbox-1"

var nativeRegionPoint = regexp.MustCompile(`^<point>([0-9]+) ([0-9]+)</point>$`)
var nativeRegionBox = regexp.MustCompile(`^([^<>\r\n]+?)[\t ]+<bbox>[\t ]*([0-9]+)[\t ]+([0-9]+)[\t ]+([0-9]+)[\t ]+([0-9]+)[\t ]*</bbox>$`)

func isNativeRegion(request gateway.InvocationRequest) bool {
	return request.PromptSpec != nil && request.PromptSpec.TemplateVersion == nativeRegionTemplateVersion && (request.PromptSpec.TemplateRef == nativeRegionFeature || request.PromptSpec.TemplateRef == nativeRegionScene)
}

func regionCoordinates(values []string) ([]int, bool) {
	coordinates := make([]int, len(values))
	for index, value := range values {
		number, err := strconv.Atoi(value)
		if err != nil || number < 0 || number > 1000 {
			return nil, false
		}
		coordinates[index] = number
	}
	return coordinates, true
}

// The frozen tar builder supplies exactly one normalized click and one image.
// The application resolves the image's owner/grant before this validation; no
// URL, replacement image, inferred point or model fallback is introduced here.
func regionPoint(request gateway.InvocationRequest) ([]int, error) {
	var point []int
	textCount, mediaCount := 0, 0
	for _, part := range request.Input {
		switch part.Type {
		case "TEXT":
			textCount++
			if part.Text == nil {
				return nil, promptFault("PROMPT_SPEC_INVALID")
			}
			match := nativeRegionPoint.FindStringSubmatch(strings.TrimSpace(*part.Text))
			if len(match) != 3 {
				return nil, promptFault("PROMPT_SPEC_INVALID")
			}
			var valid bool
			point, valid = regionCoordinates(match[1:])
			if !valid {
				return nil, promptFault("PROMPT_SPEC_INVALID")
			}
		case "MEDIA":
			mediaCount++
			if len(request.Attachments) != 1 || part.AttachmentRef == nil || *part.AttachmentRef != request.Attachments[0].Ref {
				return nil, promptFault("PROMPT_CONDITIONING_INVALID")
			}
		case "STRUCTURED":
			// STUDIO's immutable USER condition envelope remains unchanged.
		default:
			return nil, promptFault("PROMPT_SPEC_INVALID")
		}
	}
	if textCount != 1 || mediaCount != 1 {
		return nil, promptFault("PROMPT_SPEC_INVALID")
	}
	return point, nil
}

func validateNativeRegionInput(request gateway.InvocationRequest, cap gateway.Capability) error {
	if !isNativeRegion(request) {
		return nil
	}
	if cap.Kind != "IMAGE_UNDERSTANDING" || cap.Model == nil || cap.TestMode || len(request.Attachments) != 1 || request.Attachments[0].Kind != "IMAGE" {
		return promptFault("PROMPT_CAPABILITY_MISMATCH")
	}
	if request.PromptSpec.OutputContract == nil || request.PromptSpec.OutputContract.Type != "TEXT" || len(request.PromptSpec.Messages) == 0 {
		return promptFault("PROMPT_SPEC_INVALID")
	}
	for _, message := range request.PromptSpec.Messages {
		if message.Role != "USER" {
			return promptFault("PROMPT_SPEC_INVALID")
		}
	}
	if len(request.PromptSpec.Conditioning) != 1 || request.PromptSpec.Conditioning[0].AttachmentRef != request.Attachments[0].Ref || request.PromptSpec.Conditioning[0].Role != "REFERENCE_IMAGE" || request.PromptSpec.Conditioning[0].TargetAttachmentRef != nil {
		return promptFault("PROMPT_CONDITIONING_INVALID")
	}
	_, err := regionPoint(request)
	return err
}

// Syntax and point containment are enforceable protocol facts, not proof of
// detection accuracy. Preserve the exact model output; never swap coordinates,
// clamp bounds or manufacture a box from prose. Native oar displays NO_OBJECT
// through its existing localized 'no object recognized' click feedback.
func validateNativeRegionOutput(request gateway.InvocationRequest, invocation gateway.Invocation) error {
	if !isNativeRegion(request) {
		return nil
	}
	if len(invocation.OutputParts) != 1 || invocation.OutputParts[0].Type != "TEXT" || invocation.OutputParts[0].Text == nil {
		return promptFault("PROMPT_OUTPUT_INVALID")
	}
	text := strings.TrimSpace(*invocation.OutputParts[0].Text)
	if text == "NO_OBJECT" {
		return nil
	}
	point, err := regionPoint(request)
	if err != nil || text == "" {
		return promptFault("PROMPT_OUTPUT_INVALID")
	}
	for _, line := range strings.Split(text, "\n") {
		match := nativeRegionBox.FindStringSubmatch(strings.TrimSpace(line))
		if len(match) != 6 || !utf8.ValidString(match[1]) {
			return promptFault("PROMPT_OUTPUT_INVALID")
		}
		// Native oar permits a bullet and strips a final colon. Such a line
		// must still have a real label after its own display-only parsing.
		label := strings.TrimSpace(match[1])
		for _, bullet := range []string{"-", "•", "*"} {
			if strings.HasPrefix(label, bullet) {
				label = strings.TrimSpace(strings.TrimPrefix(label, bullet))
				break
			}
		}
		label = strings.TrimSpace(strings.TrimSuffix(strings.TrimSuffix(label, ":"), "："))
		if label == "" || label == "NO_OBJECT" {
			return promptFault("PROMPT_OUTPUT_INVALID")
		}
		box, valid := regionCoordinates(match[2:]) // y1 x1 y2 x2, exactly native oar order.
		if !valid || box[0] >= box[2] || box[1] >= box[3] || point[0] < box[1] || point[0] > box[3] || point[1] < box[0] || point[1] > box[2] {
			return promptFault("PROMPT_OUTPUT_INVALID")
		}
	}
	return nil
}
