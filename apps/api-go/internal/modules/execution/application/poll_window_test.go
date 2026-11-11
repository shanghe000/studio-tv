package application

import (
	"context"
	"testing"
	"time"

	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

type pollWindowGateway struct {
	*versionTestGateway
	expire bool
	refs   []string
}

func (g *pollWindowGateway) Invocation(ctx context.Context, actor gateway.Actor, ref string) (gateway.Invocation, error) {
	g.refs = append(g.refs, ref)
	if g.expire {
		<-ctx.Done()
		return gateway.Invocation{}, ctx.Err()
	}
	return g.versionTestGateway.Invocation(ctx, actor, ref)
}

// H3 can take longer than the worker's single polling window. Exercise the
// shared worker deadline boundary without sleeping five minutes or using a GPU.
func TestWorkerPollWindowExpiryResumesOriginalInvocation(t *testing.T) {
	s, store, base := versionTestService(t)
	g := &pollWindowGateway{versionTestGateway: base, expire: true}
	s.gateway = g
	task, err := promptCanvas(t, s, `{"capabilityVersion":"1","params":{"prompt":"offline polling fixture"},"routerParameters":{}}`)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	s.execute(ctx, task, "first-lease")
	if store.task.State != "RUNNING" || store.task.Plans[0].InvocationRef == nil || g.submits != 1 || g.cancels != 0 {
		t.Fatal("poll expiry lost running receipt or canceled upstream")
	}
	frozen := string(store.task.Plans[0].Request)
	g.expire = false
	s.execute(context.Background(), store.task, "reclaimed-lease")
	if store.task.State != "SUCCEEDED" || g.submits != 1 || g.cancels != 0 || len(g.refs) != 2 || g.refs[0] != g.refs[1] || string(store.task.Plans[0].Request) != frozen {
		t.Fatal("reclaimed worker resubmitted or changed the frozen invocation")
	}
}
