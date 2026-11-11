package main

import (
	"context"
	"flag"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"studiotv.local/service/api/internal/bootstrap"
	"studiotv.local/service/api/internal/config"
	"studiotv.local/service/api/internal/product"
	"studiotv.local/service/api/internal/telemetry"
)

func main() {
	healthcheck := flag.Bool("healthcheck", false, "check the running API readiness")
	observabilityCheck := flag.Bool("observability-check", false, "send one fixed observability acceptance notification without starting the API")
	flag.Parse()
	// The container healthcheck must work without loading secrets, starting a
	// second API process, or needing a separate Node/curl/wget runtime.
	if *healthcheck {
		client := &http.Client{Timeout: 3 * time.Second}
		response, err := client.Get("http://127.0.0.1:3000/readyz")
		if err != nil {
			os.Exit(1)
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			os.Exit(1)
		}
		return
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))
	var err error
	if *observabilityCheck {
		err = checkObservability()
	} else {
		err = run()
	}
	if err != nil {
		// Never put a DB connection string, OAuth response, secret or token in
		// process logs. Specific configuration errors are fixed non-secret text.
		slog.Error("API startup or shutdown failed", "stage", err.Error())
		os.Exit(1)
	}
}

func run() error {
	stopping, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	logger, err := bootstrap.NewObserver(cfg)
	if err != nil {
		return err
	}
	slog.SetDefault(logger.Logger())
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = logger.Close(ctx)
	}()
	var metrics *telemetry.Server
	if cfg.MetricsEnabled {
		metrics = telemetry.New()
	}
	gateway, err := bootstrap.ModelGatewayFromEnv(metrics)
	if err != nil {
		return err
	}
	runtime, err := product.NewRuntime(cfg, gateway, logger)
	if err != nil {
		return err
	}
	runtime.WithMetrics(metrics)
	app, err := bootstrap.NewWithRuntime(stopping, cfg, runtime.RegisterRuntimeRoutes, bootstrap.Observability{Logger: logger, Metrics: metrics})
	if err != nil {
		return err
	}
	defer app.Close()
	working, cancelWorker := context.WithCancel(stopping)
	done := make(chan struct{})
	go func() { defer close(done); runtime.Run(working) }()
	if err = app.BeforeClose(func() { cancelWorker(); <-done }); err != nil {
		cancelWorker()
		<-done
		return err
	}
	return app.Serve(stopping)
}

func checkObservability() error {
	cfg, err := config.FromEnv()
	if err != nil {
		return err
	}
	logger, err := bootstrap.NewObserver(cfg)
	if err != nil {
		return err
	}
	slog.SetDefault(logger.Logger())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err = logger.Check(ctx)
	closing, closeCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer closeCancel()
	_ = logger.Close(closing)
	if err != nil {
		return err
	}
	slog.Info("observability acceptance notification delivered", "notifications_sent", logger.Stats().Sent)
	return nil
}
