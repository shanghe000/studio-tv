package application

import (
	"context"
	"encoding/json"
)

// LongformGateway is optional: existing invocation/catalog implementations do
// not acquire a second contract merely by satisfying Gateway.
type LongformGateway interface {
	LongformCapabilities(context.Context, Actor) (json.RawMessage, error)
	LongformCreate(context.Context, Actor, json.RawMessage) (json.RawMessage, error)
	LongformProject(context.Context, Actor, string) (json.RawMessage, error)
	LongformAction(context.Context, Actor, string, json.RawMessage) (json.RawMessage, error)
	LongformArtifact(context.Context, Actor, string, string) (Artifact, []byte, error)
}
