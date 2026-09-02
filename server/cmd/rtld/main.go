// Command rtld is the rtl-improved backend: a read-through cache and recorder
// in front of RTL's public bus API.
//
// It is deliberately optional. The PWA calls RTL directly when this is
// unreachable, so an outage here degrades the app to exactly what it was before
// this server existed — never to something broken.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/mismaah/rtl-improved/server/internal/api"
	"github.com/mismaah/rtl-improved/server/internal/hub"
	"github.com/mismaah/rtl-improved/server/internal/poller"
	"github.com/mismaah/rtl-improved/server/internal/rollup"
	"github.com/mismaah/rtl-improved/server/internal/rtl"
	"github.com/mismaah/rtl-improved/server/internal/store"
)

func main() {
	var (
		addr        = flag.String("addr", envOr("RTLD_ADDR", ":8080"), "listen address")
		upstream    = flag.String("upstream", envOr("RTLD_UPSTREAM", rtl.DefaultBaseURL), "RTL API base URL")
		allowOrigin = flag.String("allow-origin", envOr("RTLD_ALLOW_ORIGIN", "*"), "CORS Access-Control-Allow-Origin")
		logLevel    = flag.String("log-level", envOr("RTLD_LOG_LEVEL", "info"), "debug, info, warn or error")
		dbPath      = flag.String("db", envOr("RTLD_DB", "rtld.db"), "SQLite path; empty disables history and live streaming")
		trustProxy  = flag.Bool("trust-proxy", envOr("RTLD_TRUST_PROXY", "") == "1",
			"treat CF-Connecting-IP / X-Forwarded-For as the real client; only safe when the sole route in is through that proxy")
		maxConns = flag.Int("max-connections", envInt("RTLD_MAX_CONNECTIONS", hub.DefaultMaxConnections), "maximum concurrent SSE connections")
		maxPer   = flag.Int("max-per-client", envInt("RTLD_MAX_PER_CLIENT", hub.DefaultMaxPerClient), "maximum concurrent SSE connections per client address")
		// Without this a storage failure is survivable: the server still works
		// as a cache. That is the right runtime behaviour and the wrong
		// deployment outcome — a deploy that quietly stops recording history
		// looks healthy while losing exactly what it was deployed for.
		requireStore = flag.Bool("require-store", envOr("RTLD_REQUIRE_STORE", "") == "1",
			"exit rather than run cache-only when the database cannot be opened")
		// A preflight for deployment: the ways a mounted volume refuses to be
		// written to — a mismatched uid, SELinux, rootless subuid remapping —
		// are not visible from the host, so the only honest test is to try it
		// from inside the container that will do the writing.
		check = flag.Bool("check", false, "open the database, verify it is writable, and exit")
	)
	flag.Parse()

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parseLevel(*logLevel)}))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *check {
		if err := checkStore(ctx, *dbPath); err != nil {
			log.Error("store check failed", "path", *dbPath, "err", err)
			os.Exit(1)
		}
		log.Info("store check passed", "path", *dbPath)
		return
	}

	client := rtl.NewClient(*upstream)
	options := api.Options{
		RTL:               client,
		Log:               log,
		AllowOrigin:       *allowOrigin,
		TrustProxyHeaders: *trustProxy,
	}
	if *allowOrigin == "*" {
		log.Warn("CORS is open to any origin; set -allow-origin to your front end")
	}
	if !*trustProxy {
		log.Info("proxy headers not trusted; per-client limits use the socket address",
			"hint", "set -trust-proxy when running behind a Cloudflare Tunnel")
	}

	// History and live streaming both hang off the store. Without it the server
	// is still a useful read-through cache, so a storage problem degrades rather
	// than prevents startup.
	if *dbPath != "" {
		db, err := store.Open(ctx, *dbPath)
		if err != nil {
			if *requireStore {
				log.Error("could not open the store", "path", *dbPath, "err", err,
					"hint", "check the mounted directory is writable by this container's user")
				os.Exit(1)
			}
			log.Error("could not open the store; running as a cache only", "path", *dbPath, "err", err)
		} else {
			defer db.Close()
			go db.RunRetention(ctx, log)

			broker := hub.NewWithLimits(*maxConns, *maxPer)
			live := poller.New(client, broker, db, log)
			go live.Run(ctx)

			// The rollup has to outlive nothing and precede everything: raw
			// fixes are pruned at RawRetention and the aggregates derived from
			// them are not, so a fix that expires unrolled is simply lost.
			go rollup.NewJob(db, live, log).Run(ctx)

			options.Hub = broker
			options.Poller = live
			log.Info("history and live streaming enabled", "db", *dbPath,
				"rawRetention", store.RawRetention, "aggregateRetention", store.AggregateRetention,
				"rollupInterval", rollup.Interval)
		}
	}

	server := api.NewServer(options)

	httpServer := &http.Server{
		Addr:    *addr,
		Handler: server.Handler(),
		// Generous write timeout: SSE streams live on this server too, and a
		// short one would sever them mid-journey.
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", *addr, "upstream", *upstream)
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		log.Error("server failed", "err", err)
		os.Exit(1)
	case <-ctx.Done():
		log.Info("shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		log.Error("graceful shutdown failed", "err", err)
		os.Exit(1)
	}
	log.Info("stopped")
}

// checkStore opens the database and writes to it, then cleans up after itself.
// Opening alone is not proof: SQLite will happily open a file it cannot later
// write, and it is the write that fails in production.
func checkStore(ctx context.Context, path string) error {
	if path == "" {
		return nil // No store configured; nothing to check.
	}
	db, err := store.Open(ctx, path)
	if err != nil {
		return err
	}
	defer db.Close()

	if err := db.PutTimetable(ctx, "0000-00-00", []byte("{}")); err != nil {
		return fmt.Errorf("write test: %w", err)
	}
	return db.DeleteTimetable(ctx, "0000-00-00")
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if parsed, err := strconv.Atoi(v); err == nil {
			return parsed
		}
	}
	return fallback
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func parseLevel(name string) slog.Level {
	var level slog.Level
	if err := level.UnmarshalText([]byte(name)); err != nil {
		return slog.LevelInfo
	}
	return level
}
