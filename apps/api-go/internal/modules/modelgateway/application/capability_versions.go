package application

import (
	"context"
	"regexp"
)

// ExactCapabilityGateway is an optional extension to the latest catalog port.
// It reads the immutable metadata for one actor-scoped capability/version pair.
// A missing version must fail rather than resolve to a newer catalog entry.
type ExactCapabilityGateway interface {
	CapabilityVersion(context.Context, Actor, string, string) (Capability, error)
}

var exactRefPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$`)
var exactVersionPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,99}$`)

func ValidCapabilityVersionQuery(ref, version string) bool {
	return exactRefPattern.MatchString(ref) && exactVersionPattern.MatchString(version)
}
