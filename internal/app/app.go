package app

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/api"
	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type App struct {
	cfg        config.Config
	db         *repository.DB
	repo       *repository.Repository
	cipher     *crypto.Cipher
	handler    *api.Handler
	httpServer *http.Server
	logger     *slog.Logger
}

func New(ctx context.Context, cfg config.Config, logger *slog.Logger) (*App, error) {
	if logger == nil {
		logger = slog.Default()
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	if cfg.MasterKey == "" {
		return nil, errors.New("OMCPA_MASTER_KEY is required")
	}
	cipher, err := crypto.New(cfg.MasterKey)
	if err != nil {
		return nil, fmt.Errorf("initialize secret cipher: %w", err)
	}
	authManager, err := auth.New(cfg.AdminPassword, cfg.SessionSecret, cfg.BasePath, cfg.PublicURL)
	if err != nil {
		return nil, fmt.Errorf("initialize administrator authentication: %w", err)
	}
	db, err := repository.Open(ctx, cfg.DatabasePath)
	if err != nil {
		return nil, err
	}
	repo := repository.New(db)
	if err := bootstrapDefaultInstance(ctx, cfg, repo, cipher); err != nil {
		db.Close()
		return nil, err
	}
	handler := api.NewHandler(cfg, repo, cipher, logger, authManager)
	return &App{
		cfg:     cfg,
		db:      db,
		repo:    repo,
		cipher:  cipher,
		handler: handler,
		logger:  logger,
	}, nil
}

func (a *App) Handler() http.Handler {
	return a.handler.Router()
}

func (a *App) Run(ctx context.Context) error {
	a.httpServer = &http.Server{
		Addr:              a.cfg.ListenAddr,
		Handler:           a.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	serverErrors := make(chan error, 1)
	go func() {
		a.logger.Info("HTTP server listening", "addr", a.cfg.ListenAddr, "base_path", a.cfg.BasePath)
		serverErrors <- a.httpServer.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := a.httpServer.Shutdown(shutdownContext); err != nil {
			return fmt.Errorf("shutdown HTTP server: %w", err)
		}
		return nil
	case err := <-serverErrors:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func (a *App) Close() error {
	if a == nil || a.db == nil {
		return nil
	}
	return a.db.Close()
}

func bootstrapDefaultInstance(ctx context.Context, cfg config.Config, repo *repository.Repository, cipher *crypto.Cipher) error {
	if strings.TrimSpace(cfg.CPA.BaseURL) == "" || strings.TrimSpace(cfg.CPA.ManagementKey) == "" {
		// Allow the binary to start before CPA is configured. The discovery API
		// will report a clear configuration error until the instance is added.
		return nil
	}
	if _, err := management.NewClient(cfg.CPA.BaseURL, cfg.CPA.ManagementKey, cfg.RequestTimeout, cfg.TLSSkipVerify); err != nil {
		return fmt.Errorf("validate CPA configuration: %w", err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte(cfg.CPA.ManagementKey))
	if err != nil {
		return fmt.Errorf("encrypt CPA management key: %w", err)
	}
	now := time.Now().UTC()
	instance := domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default CPA",
		BaseURL:                 strings.TrimRight(cfg.CPA.BaseURL, "/"),
		UsageAddr:               cfg.CPA.UsageAddr,
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		Status:                  "unknown",
		CreatedAt:               now,
		UpdatedAt:               now,
	}
	if existing, err := repo.GetInstance(ctx, instance.ID); err == nil {
		instance.CreatedAt = existing.CreatedAt
		// An environment-provided key is intentionally refreshed at startup so
		// rotation does not require manually editing SQLite.
	} else if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("load default CPA instance: %w", err)
	}
	return repo.UpsertInstance(ctx, instance)
}

// NewSessionSecret returns a cryptographically random secret suitable for a
// deployment bootstrap command. It is not used as a fallback in production.
func NewSessionSecret() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}
