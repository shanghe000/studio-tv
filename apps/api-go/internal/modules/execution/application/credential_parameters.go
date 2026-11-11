package application

import (
	"encoding/json"
	"strings"
)

// These names are reserved only inside submitted model parameters/conditions.
// Other canvas metadata and motion subject labels are not authentication input.
func credentialParameter(value any) bool {
	switch x := value.(type) {
	case map[string]any:
		for key, child := range x {
			normal := strings.ToLower(strings.NewReplacer("_", "", "-", "").Replace(key))
			switch normal {
			case "apikey", "providerapikey", "authorization", "credentialref":
				return true
			}
			if credentialParameter(child) {
				return true
			}
		}
	case []any:
		for _, child := range x {
			if credentialParameter(child) {
				return true
			}
		}
	}
	return false
}

func rawCredentialParameter(raw json.RawMessage) bool {
	var value any
	return json.Unmarshal(raw, &value) == nil && credentialParameter(value)
}
