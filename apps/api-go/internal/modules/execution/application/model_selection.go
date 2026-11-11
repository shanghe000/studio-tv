package application

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func textualCapability(c gateway.Capability) bool {
	return c.Kind == "LLM" || c.Kind == "IMAGE_UNDERSTANDING"
}

// The key is frozen privately at acceptance. A model change starts a new epoch;
// continuing the same successful epoch reuses its native session across restarts.
func routerConversationKey(cid, mid string, cap gateway.Capability, in ConversationInput) string {
	if in.PreviousCapabilityRef == cap.Ref && in.PreviousCapabilityVersion == cap.Version && in.PreviousState == "SUCCEEDED" {
		if in.RouterConversationRef != "" {
			return in.RouterConversationRef
		}
		if cap.Model == nil {
			return cid
		}
	}
	if cap.Model == nil && in.PreviousCapabilityRef == "" {
		return cid
	}
	raw, _ := json.Marshal([]string{cid, mid, cap.Ref, cap.Version})
	hash := sha256.Sum256(raw)
	return "studio-model-" + hex.EncodeToString(hash[:])
}
