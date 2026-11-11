package telemetry

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// GenerationQueueGroup contains counts only. Unknown dimensions are reduced to
// other, so a new capability or untrusted string cannot create label cardinality.
type GenerationQueueGroup struct {
	Kind, CapabilityFamily string
	Queued, Running        int64
	OldestQueuedAgeSeconds float64
}

type GenerationQueueSource func(context.Context) ([]GenerationQueueGroup, error)

const generationQueueSampleInterval = 5 * time.Second
const generationQueueSampleTimeout = 3 * time.Second

// RunGenerationQueue performs bounded background reads independently of model
// execution. /metrics only reads the last snapshot and never acquires the DB.
// The caller owns its context and must wait for return before closing the pool.
func (s *Server) RunGenerationQueue(ctx context.Context, source GenerationQueueSource) {
	if source == nil {
		return
	}
	ticker := time.NewTicker(generationQueueSampleInterval)
	defer ticker.Stop()
	for ctx.Err() == nil {
		s.sampleGenerationQueue(ctx, source)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (s *Server) sampleGenerationQueue(ctx context.Context, source GenerationQueueSource) {
	started := time.Now()
	reading, cancel := context.WithTimeout(ctx, generationQueueSampleTimeout)
	groups, err := source(reading)
	cancel()
	if ctx.Err() != nil {
		return
	}
	s.generationQueue.observe(groups, err, time.Now(), time.Since(started).Seconds())
}

var generationKinds = [...]string{"canvas", "assistant", "media", "sketch", "studio", "other"}
var generationFamilies = [...]string{"h3", "other"}

type generationGroupKey struct{ kind, family string }
type generationQueueSnapshot struct {
	groups     map[generationGroupKey]GenerationQueueGroup
	sampledAt  time.Time
	up         float64
	duration   float64
	errorCount float64
}
type generationQueueCollector struct {
	mu           sync.RWMutex
	snapshot     generationQueueSnapshot
	tasks        *prometheus.Desc
	oldestAge    *prometheus.Desc
	samplerUp    *prometheus.Desc
	lastSuccess  *prometheus.Desc
	sampleTime   *prometheus.Desc
	sampleErrors *prometheus.Desc
}

func newGenerationQueueCollector() *generationQueueCollector {
	return &generationQueueCollector{
		snapshot:     generationQueueSnapshot{groups: map[generationGroupKey]GenerationQueueGroup{}},
		tasks:        prometheus.NewDesc("studiotv_generation_tasks", "Persisted active STUDIO tasks, counted once; running includes upstream execution and result import, not only GPU work.", []string{"kind", "capability_family", "state"}, nil),
		oldestAge:    prometheus.NewDesc("studiotv_generation_oldest_queued_age_seconds", "Age of the oldest persisted QUEUED STUDIO task; zero for an empty group. Values advance between successful samples.", []string{"kind", "capability_family"}, nil),
		samplerUp:    prometheus.NewDesc("studiotv_generation_queue_sampler_up", "One if the latest background queue read succeeded, zero before the first read or after a failed read.", nil, nil),
		lastSuccess:  prometheus.NewDesc("studiotv_generation_queue_last_success_timestamp_seconds", "Unix timestamp of the last successful background queue read; zero before the first success.", nil, nil),
		sampleTime:   prometheus.NewDesc("studiotv_generation_queue_sample_duration_seconds", "Duration of the latest background queue read, including failures.", nil, nil),
		sampleErrors: prometheus.NewDesc("studiotv_generation_queue_sample_errors_total", "Failed background queue reads; no database error text is recorded.", nil, nil),
	}
}

func generationKind(value string) string {
	value = strings.ToLower(value)
	for _, allowed := range generationKinds {
		if value == allowed {
			return value
		}
	}
	return "other"
}

func (c *generationQueueCollector) observe(groups []GenerationQueueGroup, err error, now time.Time, duration float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.snapshot.duration = duration
	if err != nil {
		c.snapshot.up = 0
		c.snapshot.errorCount++
		return // Preserve the last known counts and timestamp; never report false zero.
	}
	next := make(map[generationGroupKey]GenerationQueueGroup, len(groups))
	for _, group := range groups {
		family := "other"
		if group.CapabilityFamily == "h3" {
			family = "h3"
		}
		key := generationGroupKey{generationKind(group.Kind), family}
		previous := next[key]
		previous.Queued += max(group.Queued, 0)
		previous.Running += max(group.Running, 0)
		previous.OldestQueuedAgeSeconds = max(previous.OldestQueuedAgeSeconds, group.OldestQueuedAgeSeconds)
		next[key] = previous
	}
	c.snapshot.groups = next
	c.snapshot.sampledAt = now
	c.snapshot.up = 1
}

func (c *generationQueueCollector) Describe(ch chan<- *prometheus.Desc) {
	for _, desc := range []*prometheus.Desc{c.tasks, c.oldestAge, c.samplerUp, c.lastSuccess, c.sampleTime, c.sampleErrors} {
		ch <- desc
	}
}

func (c *generationQueueCollector) Collect(ch chan<- prometheus.Metric) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	lastSuccess, elapsed := float64(0), float64(0)
	if !c.snapshot.sampledAt.IsZero() {
		lastSuccess = float64(c.snapshot.sampledAt.UnixNano()) / 1e9
		elapsed = max(time.Since(c.snapshot.sampledAt).Seconds(), 0)
	}
	for _, kind := range generationKinds {
		for _, family := range generationFamilies {
			group := c.snapshot.groups[generationGroupKey{kind, family}]
			ch <- prometheus.MustNewConstMetric(c.tasks, prometheus.GaugeValue, float64(group.Queued), kind, family, "queued")
			ch <- prometheus.MustNewConstMetric(c.tasks, prometheus.GaugeValue, float64(group.Running), kind, family, "running")
			age := float64(0)
			if group.Queued > 0 {
				age = group.OldestQueuedAgeSeconds + elapsed
			}
			ch <- prometheus.MustNewConstMetric(c.oldestAge, prometheus.GaugeValue, age, kind, family)
		}
	}
	ch <- prometheus.MustNewConstMetric(c.samplerUp, prometheus.GaugeValue, c.snapshot.up)
	ch <- prometheus.MustNewConstMetric(c.lastSuccess, prometheus.GaugeValue, lastSuccess)
	ch <- prometheus.MustNewConstMetric(c.sampleTime, prometheus.GaugeValue, c.snapshot.duration)
	ch <- prometheus.MustNewConstMetric(c.sampleErrors, prometheus.CounterValue, c.snapshot.errorCount)
}
