// Package principal preserves the authenticated caller independently of a
// project's canonical storage owner. Values are installed only by the server.
package principal

import "context"

type actorKey struct{}

func WithActor(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, actorKey{}, id)
}

func Actor(ctx context.Context, fallback string) string {
	if id, ok := ctx.Value(actorKey{}).(string); ok && id != "" {
		return id
	}
	return fallback
}

// Project identifies a server-authorized input boundary; never install it from
// an unverified browser field.
type projectKey struct{}

func WithProject(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, projectKey{}, id)
}
func Project(ctx context.Context) string { id, _ := ctx.Value(projectKey{}).(string); return id }
