package telemetry

import (
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
)

// RegisterPool collects only the pool's in-memory Stat snapshot. It never
// connects, queries, acquires a connection or exports connection configuration.
// Register once for the application's pool, before serving metrics.
func (s *Server) RegisterPool(pool *pgxpool.Pool) error {
	if pool == nil {
		return errors.New("telemetry: database pool unavailable")
	}
	return s.registry.Register(newPoolCollector(func() poolSnapshot {
		stat := pool.Stat()
		return poolSnapshot{
			connections: [5]float64{float64(stat.AcquiredConns()), float64(stat.IdleConns()), float64(stat.TotalConns()), float64(stat.ConstructingConns()), float64(stat.MaxConns())},
			counters:    [7]float64{float64(stat.AcquireCount()), float64(stat.CanceledAcquireCount()), float64(stat.EmptyAcquireCount()), stat.AcquireDuration().Seconds(), float64(stat.NewConnsCount()), float64(stat.MaxIdleDestroyCount()), float64(stat.MaxLifetimeDestroyCount())},
		}
	}))
}

type poolSnapshot struct {
	connections [5]float64
	counters    [7]float64
}

type poolCollector struct {
	stat        func() poolSnapshot
	connections *prometheus.Desc
	counters    [7]*prometheus.Desc
}

func newPoolCollector(stat func() poolSnapshot) *poolCollector {
	c := &poolCollector{stat: stat, connections: prometheus.NewDesc("studiotv_db_pool_connections", "Pool connection counts from an in-memory statistics snapshot.", []string{"state"}, nil)}
	for i, metric := range [7][2]string{
		{"studiotv_db_pool_acquire_total", "Successful pool acquires."},
		{"studiotv_db_pool_acquire_canceled_total", "Pool acquires canceled by context."},
		{"studiotv_db_pool_acquire_empty_total", "Successful pool acquires that waited because the pool was empty."},
		{"studiotv_db_pool_acquire_duration_seconds_total", "Cumulative duration of successful pool acquires in seconds."},
		{"studiotv_db_pool_new_connections_total", "New pool connections opened."},
		{"studiotv_db_pool_max_idle_destroy_total", "Pool connections destroyed after reaching maximum idle time."},
		{"studiotv_db_pool_max_lifetime_destroy_total", "Pool connections destroyed after reaching maximum lifetime."},
	} {
		c.counters[i] = prometheus.NewDesc(metric[0], metric[1], nil, nil)
	}
	return c
}

func (c *poolCollector) Describe(ch chan<- *prometheus.Desc) {
	ch <- c.connections
	for _, desc := range c.counters {
		ch <- desc
	}
}

func (c *poolCollector) Collect(ch chan<- prometheus.Metric) {
	snapshot := c.stat()
	for i, state := range [5]string{"acquired", "idle", "total", "constructing", "max"} {
		ch <- prometheus.MustNewConstMetric(c.connections, prometheus.GaugeValue, snapshot.connections[i], state)
	}
	for i, desc := range c.counters {
		ch <- prometheus.MustNewConstMetric(desc, prometheus.CounterValue, snapshot.counters[i])
	}
}
