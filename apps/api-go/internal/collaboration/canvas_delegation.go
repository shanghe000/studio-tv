// A canvas Agent executes after the initiating HTTP request has ended.
package collaboration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
)

// CanvasDelegation retains a single page's original writer in the trusted STUDIO
// transport only. The persisted digest cannot be used as a writer credential.
type CanvasDelegation struct {
	client     string
	credential canvasWriteCredential
	modern     bool
}

func CanvasDelegationFrom(ctx context.Context) CanvasDelegation {
	c, modern := ctx.Value(canvasProofKey{}).(canvasWriteCredential)
	return CanvasDelegation{CanvasLeaseRequestFrom(ctx).ClientID, c, modern}
}

func (d CanvasDelegation) Digest() string {
	if d == (CanvasDelegation{}) {
		return ""
	}
	// HTTP header values cannot contain NUL. Distinguish malformed modern
	// headers from a legacy request without credentials.
	mode := "legacy"
	if d.modern {
		mode = "modern"
	}
	sum := sha256.Sum256([]byte(mode + "\x00" + d.client + "\x00" + d.credential.proof + "\x00" + d.credential.lease))
	return hex.EncodeToString(sum[:])
}

func (d CanvasDelegation) ApplyTo(headers http.Header) {
	if d.client != "" {
		headers.Set(CanvasSessionHeader, d.client)
	}
	if d.modern {
		headers.Set(CanvasProofHeader, d.credential.proof)
		headers.Set(CanvasLeaseHeader, d.credential.lease)
	}
}
