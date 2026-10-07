package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/oh-my-cpa/oh-my-cpa/internal/app"
	"github.com/oh-my-cpa/oh-my-cpa/internal/applog"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/mcpbridge"
)

const MCP_USAGE = `Usage: oh-my-cpa mcp

Serves Oh My CPA's capabilities to an MCP client over standard input and output.
A client that speaks Streamable HTTP does not need this process: it connects to
<console URL>/api/mcp with "Authorization: Bearer <CPA management key>".

Environment:
  OMCPA_SERVER_URL          console URL including its base path, for example
                            https://omc.example.com/omc (plain HTTP is accepted
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

	// Stderr stays the durable log; the tee keeps a bounded, redacted copy the console
	// reads as the OMC service log.
	serviceLog := applog.NewBuffer(applog.DefaultCapacity)
	logger := slog.New(applog.NewHandler(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}), serviceLog))
	// Route package-level slog calls (including API error reporting) here.
	slog.SetDefault(logger)
	// A local .env is a developer convenience only: real environment variables
	// keep precedence, so containers and CI never depend on the file.
	if applied, err := config.LoadDotEnv(config.DotEnvPath()); err != nil {
		logger.Error("invalid environment file", "path", config.DotEnvPath(), "error", err)
		os.Exit(2)
	} else if applied > 0 {
		logger.Info("loaded environment file", "path", config.DotEnvPath(), "variables", applied)
	}
	cfg, err := config.Load()
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

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
