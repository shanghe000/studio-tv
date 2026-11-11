package http_test

import (
	"github.com/google/uuid"
	"testing"
)

func TestHTTPLifecycleOwnershipPreconditionsAndUnsupportedPersistence(t *testing.T) {
	h := newHarness(t)
	id := h.create("test-a", "project-a", "Lifecycle headers", uuid.NewString())
	path := "/api/v2/conversations/" + id
	for _, suffix := range []string{"/turns/message-a", "/messages/message-a"} {
		headers := map[string]string{"Idempotency-Key": uuid.NewString(), "If-Match": `"1"`}
		h.request("DELETE", path+suffix, "", "", headers, 401, "Error")
		h.request("DELETE", path+suffix, "test-b", "", headers, 404, "Error")
		h.request("DELETE", path+suffix, "test-a", "", map[string]string{"Idempotency-Key": uuid.NewString()}, 428, "Error")
		h.request("DELETE", path+suffix, "test-a", "", map[string]string{"Idempotency-Key": uuid.NewString(), "If-Match": `W/"1"`}, 400, "Error")
		h.request("DELETE", path+suffix, "test-a", "", map[string]string{"Idempotency-Key": "forged", "If-Match": `"1"`}, 400, "Error")
		h.request("DELETE", path+suffix, "test-a", `{"ownerId":"forged"}`, headers, 400, "Error")
		h.request("DELETE", path+suffix+"?ownerId=owner-b", "test-a", "", headers, 400, "Error")
		h.request("DELETE", path+suffix, "test-a", "", headers, 501, "Error")
	}
	h.request("GET", path+"/client-tools/pending", "test-b", "", nil, 404, "Error")
	h.request("GET", path+"/client-tools/pending?ownerId=owner-b", "test-a", "", nil, 400, "Error")
	h.request("GET", path+"/client-tools/pending", "test-a", "", nil, 501, "Error")
	h.f.deny = true
	h.request("GET", path+"/client-tools/pending", "test-a", "", nil, 403, "Error")
	h.request("DELETE", path+"/messages/message-a", "test-a", "", map[string]string{"If-Match": `"1"`, "Idempotency-Key": uuid.NewString()}, 403, "Error")
}
