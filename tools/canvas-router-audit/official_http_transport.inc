// Only included by STUDIO's Go build overlay for the local Router integration test.
package officialvideo

import "net/http"

func (e *Executor) CanvasAuditTransport(transport http.RoundTripper) { e.client.Transport = transport }
