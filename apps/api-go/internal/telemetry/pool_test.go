package telemetry

import (
	"context"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPoolSnapshotTypesAndValues(t *testing.T) {
	s := New()
	calls := 0
	if err := s.registry.Register(newPoolCollector(func() poolSnapshot {
		calls++
		return poolSnapshot{connections: [5]float64{2, 3, 6, 1, 10}, counters: [7]float64{12, 2, 4, .25, 8, 1, 2}}
	})); err != nil {
		t.Fatal(err)
	}
	body := scrape(t, s)
	for _, line := range []string{`studiotv_db_pool_connections{state="acquired"} 2`, `studiotv_db_pool_connections{state="max"} 10`, `studiotv_db_pool_acquire_total 12`, `studiotv_db_pool_acquire_canceled_total 2`, `studiotv_db_pool_acquire_duration_seconds_total 0.25`} {
		if !strings.Contains(body, line) {
			t.Fatalf("missing %s", line)
		}
	}
	if calls != 1 {
		t.Fatalf("snapshots per scrape: %d", calls)
	}
	families, err := s.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		if strings.HasPrefix(family.GetName(), "studiotv_db_pool_") {
			if family.GetName() == "studiotv_db_pool_connections" {
				if len(family.Metric) != 5 || family.GetType().String() != "GAUGE" {
					t.Fatal("connection gauges incorrect")
				}
			} else if family.GetType().String() != "COUNTER" {
				t.Fatal("pool cumulative value must be counter")
			}
		}
	}
}

func TestRegisterPoolNeverConnectsAndDoesNotExposeConfiguration(t *testing.T) {
	cfg, err := pgxpool.ParseConfig("postgres://private-user:private-password@127.0.0.1:1/private-database?sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	cfg.MinConns = 0
	cfg.MaxConns = 13
	var connects atomic.Int32
	cfg.BeforeConnect = func(context.Context, *pgx.ConnConfig) error { connects.Add(1); return context.Canceled }
	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	s := New()
	if err := s.RegisterPool(nil); err == nil {
		t.Fatal("nil pool accepted")
	}
	if err := s.RegisterPool(pool); err != nil {
		t.Fatal(err)
	}
	if err := s.RegisterPool(pool); err == nil {
		t.Fatal("duplicate pool collector accepted")
	}
	for range 3 {
		body := scrape(t, s)
		if !strings.Contains(body, `studiotv_db_pool_connections{state="max"} 13`) {
			t.Fatal("pool max missing")
		}
		for _, value := range []string{"private-user", "private-password", "private-database", "127.0.0.1"} {
			if strings.Contains(body, value) {
				t.Fatal("configuration leaked")
			}
		}
	}
	if connects.Load() != 0 {
		t.Fatal("metrics attempted a database connection")
	}
}
