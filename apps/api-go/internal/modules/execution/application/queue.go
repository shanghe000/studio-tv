package application

import "context"

// QueueGroup is an aggregate of persisted execution tasks, never plan counts.
// H3 tasks are included while they wait in STUDIO, before a Router receipt exists.
type QueueGroup struct {
	Kind, CapabilityFamily string
	Queued, Running        int64
	OldestQueuedAgeSeconds float64
}

// QueueReader is an operational, read-only port. It exposes no task, owner,
// project, prompt, artifact, or invocation identities.
type QueueReader interface {
	GenerationQueue(context.Context) ([]QueueGroup, error)
}
