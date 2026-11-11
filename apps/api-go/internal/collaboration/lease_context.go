package collaboration

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"net/http"

	"studiotv.local/service/api/internal/httpapi"
)

type canvasLeaseRequestKey struct{}

// CanvasLeaseRequest binds a page identifier to the verified caller. The page
// identifier supplies no authority without the same authenticated identity.
type CanvasLeaseRequest struct {
	Identity httpapi.Identity
	ClientID string
}

func WithCanvasLeaseRequest(ctx context.Context, identity httpapi.Identity, clientID string) context.Context {
	return context.WithValue(ctx, canvasLeaseRequestKey{}, CanvasLeaseRequest{identity, clientID})
}

func CanvasLeaseRequestFrom(ctx context.Context) CanvasLeaseRequest {
	value, _ := ctx.Value(canvasLeaseRequestKey{}).(CanvasLeaseRequest)
	return value
}

const CanvasProofHeader = "X-STUDIO-Canvas-Proof"
const CanvasLeaseHeader = "X-STUDIO-Canvas-Lease"

type canvasProofKey struct{}
type canvasWriteCredential struct{ proof, lease string }

func ContextWithCanvasProof(r *http.Request) context.Context {
	proofs, leases := r.Header.Values(CanvasProofHeader), r.Header.Values(CanvasLeaseHeader)
	if len(proofs) == 0 && len(leases) == 0 {
		return r.Context()
	}
	// The presence of either header marks a modern request, even if malformed.
	// It cannot fall through to legacy writes when its term has already expired.
	var credential canvasWriteCredential
	if len(proofs) == 1 && len(proofs[0]) >= 32 && len(proofs[0]) <= 96 {
		credential.proof = proofs[0]
	}
	if len(leases) == 1 && len(leases[0]) == 36 {
		credential.lease = leases[0]
	}
	return context.WithValue(r.Context(), canvasProofKey{}, credential)
}
func CanvasProofMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ctx := ContextWithCanvasProof(r); ctx != r.Context() {
			r = r.WithContext(ctx)
		}
		next.ServeHTTP(w, r)
	})
}
func CanvasProofDigest(secret string) []byte {
	if secret == "" {
		return nil
	}
	sum := sha256.Sum256([]byte(secret))
	return sum[:]
}
func MatchCanvasProof(stored []byte, supplied string) bool {
	return len(stored) == 0 || subtle.ConstantTimeCompare(stored, CanvasProofDigest(supplied)) == 1
}
