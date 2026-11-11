package telemetry

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func queueMetric(t *testing.T, s *Server, name string, labels map[string]string) float64 {
	t.Helper()
	families, err := s.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		if family.GetName() != name {
			continue
		}
		for _, metric := range family.Metric {
			matches := len(metric.Label) == len(labels)
			for _, pair := range metric.Label {
				matches = matches && labels[pair.GetName()] == pair.GetValue()
			}
			if matches {
				if metric.Gauge != nil {
					return metric.Gauge.GetValue()
				}
				return metric.Counter.GetValue()
			}
		}
	}
	t.Fatalf("metric not found: %s %v", name, labels)
	return 0
}

func TestGenerationQueueFailureRetainsSnapshotAndReportsStaleness(t *testing.T) {
	s := New()
	labels := map[string]string{"kind": "canvas", "capability_family": "h3", "state": "queued"}
	if queueMetric(t, s, "studiotv_generation_queue_sampler_up", nil) != 0 || queueMetric(t, s, "studiotv_generation_queue_last_success_timestamp_seconds", nil) != 0 {
		t.Fatal("unobserved queue looked healthy")
	}
	now := time.Now().Add(-2 * time.Second)
	s.generationQueue.observe([]GenerationQueueGroup{{Kind: "CANVAS", CapabilityFamily: "h3", Queued: 2, Running: 1, OldestQueuedAgeSeconds: 60}}, nil, now, .02)
	timestamp := queueMetric(t, s, "studiotv_generation_queue_last_success_timestamp_seconds", nil)
	if queueMetric(t, s, "studiotv_generation_tasks", labels) != 2 {
		t.Fatal("pre-Router waiting tasks missing")
	}
	age := queueMetric(t, s, "studiotv_generation_oldest_queued_age_seconds", map[string]string{"kind": "canvas", "capability_family": "h3"})
	if age < 62 || age > 65 {
		t.Fatalf("oldest age did not advance between samples: %f", age)
	}
	s.generationQueue.observe(nil, errors.New("private-dsn-and-password"), now.Add(time.Second), .04)
	if queueMetric(t, s, "studiotv_generation_tasks", labels) != 2 || queueMetric(t, s, "studiotv_generation_queue_last_success_timestamp_seconds", nil) != timestamp {
		t.Fatal("failed sample erased the last known queue or marked it fresh")
	}
	if queueMetric(t, s, "studiotv_generation_queue_sampler_up", nil) != 0 || queueMetric(t, s, "studiotv_generation_queue_sample_errors_total", nil) != 1 {
		t.Fatal("failed read not exposed")
	}
	if strings.Contains(scrape(t, s), "private-dsn") {
		t.Fatal("database error text leaked")
	}
	s.generationQueue.observe(nil, nil, time.Now(), .01)
	if queueMetric(t, s, "studiotv_generation_tasks", labels) != 0 || queueMetric(t, s, "studiotv_generation_queue_sampler_up", nil) != 1 {
		t.Fatal("a successful empty queue retained old tasks")
	}
	if queueMetric(t, s, "studiotv_generation_oldest_queued_age_seconds", map[string]string{"kind": "canvas", "capability_family": "h3"}) != 0 {
		t.Fatal("empty queue retained waiting age")
	}
}

func TestGenerationQueueScrapesDoNotReadSourceAndLabelsAreBounded(t *testing.T) {
	s := New()
	calls := 0
	s.sampleGenerationQueue(context.Background(), func(ctx context.Context) ([]GenerationQueueGroup, error) {
		calls++
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > generationQueueSampleTimeout {
			t.Fatal("background read has no bounded timeout")
		}
		groups := []GenerationQueueGroup{}
		for range 100 {
			groups = append(groups, GenerationQueueGroup{Kind: "private-project-and-owner", CapabilityFamily: "private-capability", Queued: 1})
		}
		return groups, nil
	})
	for range 4 {
		body := scrape(t, s)
		if strings.Contains(body, "private-project") || strings.Contains(body, "private-capability") {
			t.Fatal("unbounded private label exported")
		}
	}
	if calls != 1 || queueMetric(t, s, "studiotv_generation_tasks", map[string]string{"kind": "other", "capability_family": "other", "state": "queued"}) != 100 {
		t.Fatal("scrape invoked SQL or unknown groups were discarded")
	}
	families, _ := s.registry.Gather()
	for _, family := range families {
		if family.GetName() == "studiotv_generation_tasks" && len(family.Metric) != len(generationKinds)*len(generationFamilies)*2 {
			t.Fatal("task metric cardinality is not fixed")
		}
	}
}

func TestGenerationQueueSamplerCancellationAndConcurrentScrapes(t *testing.T) {
	s := New()
	ctx, cancel := context.WithCancel(context.Background())
	entered, exited := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(exited)
		s.RunGenerationQueue(ctx, func(reading context.Context) ([]GenerationQueueGroup, error) {
			close(entered)
			<-reading.Done()
			return nil, reading.Err()
		})
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("sampler did not read immediately")
	}
	cancel()
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("sampler did not cancel before pool shutdown")
	}
	if queueMetric(t, s, "studiotv_generation_queue_sample_errors_total", nil) != 0 {
		t.Fatal("normal shutdown recorded a failed read")
	}
	var workers sync.WaitGroup
	var failed atomic.Bool
	for worker := range 4 {
		workers.Add(1)
		go func(worker int) {
			defer workers.Done()
			for range 25 {
				if worker == 0 {
					s.generationQueue.observe([]GenerationQueueGroup{{Kind: "CANVAS", CapabilityFamily: "h3", Queued: 2}}, nil, time.Now(), .01)
				} else if _, err := s.registry.Gather(); err != nil {
					failed.Store(true)
				}
			}
		}(worker)
	}
	workers.Wait()
	if failed.Load() {
		t.Fatal("concurrent snapshots produced invalid metrics")
	}
}
