package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/oh-my-cpa/oh-my-cpa/internal/app"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
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
	defer running.Close()
	if err := running.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		logger.Error("server stopped with error", "error", err)
		os.Exit(1)
	}
}
