package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/oh-my-cpa/oh-my-cpa/internal/app"
	"github.com/oh-my-cpa/oh-my-cpa/internal/applog"
	"github.com/oh-my-cpa/oh-my-cpa/internal/backup"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/mcpbridge"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/updater"
)

const MCP_USAGE = `Usage: oh-my-cpa mcp

Serves Oh My CPA's capabilities to an MCP client over standard input and output.
A client that speaks Streamable HTTP does not need this process: it connects to
<console URL>/api/mcp with "Authorization: Bearer <CPA management key>".

Environment:
  OMCPA_SERVER_URL          console URL including its base path, for example
                            https://omc.example.com (plain HTTP is accepted
                            for loopback addresses only)
  OMCPA_CPA_MANAGEMENT_KEY  the CPA management key that signs in to the console
`

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "mcp" {
		if len(os.Args) > 2 {
			// Standard output is the protocol channel, so usage goes to standard error.
			fmt.Fprint(os.Stderr, MCP_USAGE)
			if os.Args[2] == "-h" || os.Args[2] == "--help" || os.Args[2] == "help" {
				return
			}
			os.Exit(2)
		}
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		if err := mcpbridge.Run(ctx, os.Getenv("OMCPA_SERVER_URL"), os.Getenv("OMCPA_CPA_MANAGEMENT_KEY"), envOr("OMCPA_VERSION", config.BuildVersion)); err != nil {
			slog.Error("MCP bridge stopped", "error", err)
			os.Exit(1)
		}
		return
	}

	if len(os.Args) > 1 && os.Args[1] == updater.ROLE_COMMAND {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		code := updater.Run(ctx, os.Args[2:], envOr("OMCPA_VERSION", config.BuildVersion), os.Stdout, os.Stderr)
		stop()
		os.Exit(code)
	}

	// Stderr stays the durable log; the tee keeps a bounded, redacted copy the console
	// reads as the OMC service log.
	serviceLog := applog.NewBuffer(applog.DefaultCapacity)
	logger := slog.New(applog.NewHandler(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}), serviceLog))
	// Route package-level slog calls (including API error reporting) here.
	slog.SetDefault(logger)
	// A local .env is a developer convenience only: real environment variables
	// keep precedence, so containers and CI never depend on the file.
	applied, err := config.LoadDotEnv(config.DotEnvPath())
	if err != nil {
		logger.Error("invalid environment file", "path", config.DotEnvPath(), "error", err)
		os.Exit(2)
	}
	cfg, err := config.Load()
	if err != nil {
		if applied > 0 {
			logger.Info("loaded environment file", "path", config.DotEnvPath(), "variables", applied)
		}
		logger.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if len(os.Args) > 1 && os.Args[1] == "database" {
		if applied > 0 {
			logger.Info("loaded environment file", "path", config.DotEnvPath(), "variables", applied)
		}
		if cfg.IsDemoMode {
			logger.Error("database commands are unavailable in demo mode")
			os.Exit(2)
		}
		if err := backup.RunCommand(ctx, cfg.DatabasePath, cfg.MasterKey, cfg.Version, os.Args[2:], os.Stdout); err != nil {
			logger.Error("database command failed", "error", err)
			os.Exit(1)
		}
		return
	}

	writeStartupBanner(os.Stderr, serviceLog, config.ResolveBuildInfo(cfg.Version), cfg.CPA.ManagementKey, cfg.MasterKey)
	if applied > 0 {
		logger.Info("loaded environment file", "path", config.DotEnvPath(), "variables", applied)
	}

	running, err := app.New(ctx, cfg, logger)
	if err != nil {
		logger.Error("failed to initialize Oh My CPA", "error", err)
		os.Exit(1)
	}
	logger = slog.Default()
	defer running.Close()
	if err := running.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("server stopped with error", "error", err)
		os.Exit(1)
	}
}

func sanitizeBuildField(value string, knownSecrets ...string) string {
	trimmed := strings.TrimSpace(value)
	var longSecrets []string
	for _, secret := range knownSecrets {
		candidate := strings.TrimSpace(secret)
		if candidate == "" {
			continue
		}
		if trimmed == candidate {
			return security.RedactedValue
		}
		// Only match substrings for non-trivial secret lengths so short local-dev
		// keys like "dev" cannot mask suffixes such as "v0.1.0-dev".
		if len(candidate) >= 8 {
			longSecrets = append(longSecrets, candidate)
		}
	}
	return security.RedactText(value, longSecrets...)
}

func writeStartupBanner(stderr io.Writer, serviceLog *applog.Buffer, info config.BuildInfo, knownSecrets ...string) {
	safe := config.BuildInfo{
		Version: sanitizeBuildField(info.Version, knownSecrets...),
		Commit:  sanitizeBuildField(info.Commit, knownSecrets...),
		BuiltAt: sanitizeBuildField(info.BuiltAt, knownSecrets...),
	}
	_, _ = fmt.Fprintln(stderr, safe.Banner())
	if serviceLog != nil {
		// Route through applog.Handler with a discard sink so the buffer applies the
		// exact same redaction and length bounds as stderr slog records without emitting
		// a duplicate JSON line.
		capture := slog.New(applog.NewHandler(slog.NewJSONHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelInfo}), serviceLog))
		capture.Info("Oh My CPA starting", "version", safe.Version, "commit", safe.Commit, "built_at", safe.BuiltAt)
	}
}
