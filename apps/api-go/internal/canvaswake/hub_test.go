package canvaswake

import "testing"

func TestWakeIsCoalescedAndProjectScoped(t *testing.T) {
	h := New()
	a, done := h.Subscribe("a")
	defer done()
	b, other := h.Subscribe("b")
	defer other()
	h.wake("a")
	h.wake("a")
	if len(a) != 1 || len(b) != 0 {
		t.Fatal("incorrect notification distribution")
	}
}
