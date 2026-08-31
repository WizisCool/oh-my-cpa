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
