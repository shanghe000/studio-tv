package application

import (
	"strconv"
	"strings"
)

// PreferCapability keeps catalog order between suppliers, and prefers a newer
// public version within one supplier. It never interprets a native model ID.
func PreferCapability(candidate, current Capability) bool {
	priority := func(c Capability) int {
		if !c.Available {
			return -1
		}
		if c.TestMode {
			return 0
		}
		if c.Model != nil {
			return 2
		}
		return 1
	}
	if a, b := priority(candidate), priority(current); a != b {
		return a > b
	}
	if candidate.Model == nil || current.Model == nil || candidate.Model.ProviderRef != current.Model.ProviderRef {
		return false
	}
	a, b := strings.Split(candidate.Model.Version, "."), strings.Split(current.Model.Version, ".")
	for i := 0; i < len(a) || i < len(b); i++ {
		var av, bv uint64
		var err error
		if i < len(a) {
			av, err = strconv.ParseUint(a[i], 10, 64)
			if err != nil {
				return false
			}
		}
		if i < len(b) {
			bv, err = strconv.ParseUint(b[i], 10, 64)
			if err != nil {
				return false
			}
		}
		if av != bv {
			return av > bv
		}
	}
	return false
}
