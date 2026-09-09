package app

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/api"
	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage/ingest"
)

type App struct {
	cfg        config.Config
	db         *repository.DB
	repo       *repository.Repository
	cipher     *crypto.Cipher
	handler    *api.Handler
	httpServer *http.Server
	logger     *slog.Logger
	// pipeline captures CPA request records into the local database. Nil when
	// ingestion is disabled or no CPA instance is configured yet.
	pipeline *ingest.Pipeline
	// pricing keeps model prices fresh from models.dev; nil-safe service.
	pricing *pricing.Service
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
	// Oh My CPA has no separate administrator password: the CPA management key
	// is the only login credential. The app still boots without one so the UI
	// can explain what to configure; the login endpoint then reports 503.
	var authManager *auth.Manager
	if strings.TrimSpace(cfg.CPA.ManagementKey) != "" {
		authManager, err = auth.New(cfg.CPA.ManagementKey, cfg.BasePath, cfg.PublicURL)
		if err != nil {
			return nil, fmt.Errorf("initialize administrator authentication: %w", err)
		}
	}
	db, err := repository.Open(ctx, cfg.DatabasePath,
		repository.WithMigrationBackup(cipher, filepath.Join(cfg.DataDir, "backups"), 5),
	)
	if err != nil {
		return nil, err
	}
	repo := repository.New(db)
	if err := bootstrapDefaultInstance(ctx, cfg, repo, cipher); err != nil {
		db.Close()
		return nil, err
	}
	handler := api.NewHandler(cfg, repo, cipher, logger, authManager)

	// Zero-config pricing: the service syncs once at startup and then daily, and
	// manual operator rows always win. Failures degrade to stale prices, never
	// to wrong ones.
	pricingService := pricing.NewService(repo, nil, logger)
	pricingService.SetModelLister(&cpaModelLister{repo: repo, cipher: cipher, cfg: cfg})
	handler.SetPricing(pricingService)

	pipeline, err := buildUsagePipeline(cfg, repo, handler, logger, cipher)
	if err != nil {
		db.Close()
		return nil, err
	}
	return &App{
		cfg:     cfg,
		db:      db,
		repo:    repo,
		cipher:  cipher,
		handler: handler,
		logger:  logger,

		pipeline: pipeline,

		pricing: pricingService,
	}, nil
}

// usageUpstream adapts the CPA management client to the collector's narrower
// view of it. The concrete *management.UsageStream already satisfies
// ingest.Stream; only the client method signature needs wrapping, which keeps
// the ingest package free of any dependency on the management client type.
type usageUpstream struct{ client *management.Client }

func (u usageUpstream) PingUsageChannel(ctx context.Context) error {
	return u.client.PingUsageChannel(ctx)
}

func (u usageUpstream) OpenUsageStream(ctx context.Context, channel string) (ingest.Stream, error) {
	stream, err := u.client.OpenUsageStream(ctx, channel)
	if err != nil {
		return nil, err
	}
	return stream, nil
}

func (u usageUpstream) PopUsageQueue(ctx context.Context, count int) ([]string, error) {
	return u.client.PopUsageQueue(ctx, count)
}

func (u usageUpstream) UsageQueueJSON(ctx context.Context, count int) ([]string, error) {
	return u.client.UsageQueueJSON(ctx, count)
}

// cpaModelLister satisfies pricing.ModelLister by discovering all models and
// aliases configured across all providers and auth-files in the default CPA instance.
type cpaModelLister struct {
	repo   *repository.Repository
	cipher *crypto.Cipher
	cfg    config.Config
}

func (l *cpaModelLister) ListConfiguredModels(ctx context.Context) ([]string, error) {
	instance, err := l.repo.GetInstance(ctx, "default")
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || strings.Contains(err.Error(), "no rows") {
			return nil, nil
		}
		return nil, err
	}
	if strings.TrimSpace(instance.BaseURL) == "" {
		return nil, nil
	}
	key, err := l.cipher.Decrypt(instance.ManagementKeyCiphertext, instance.ManagementKeyNonce)
	if err != nil {
		return nil, fmt.Errorf("decrypt CPA management key: %w", err)
	}
	defer func() {
		for i := range key {
			key[i] = 0
		}
	}()
	client, err := management.NewClient(instance.BaseURL, string(key), l.cfg.RequestTimeout, l.cfg.TLSSkipVerify)
	if err != nil {
		return nil, fmt.Errorf("build CPA management client: %w", err)
	}
	return client.ListAllConfiguredModels(ctx)
}

// buildUsagePipeline wires capture, decode and maintenance over the default CPA
// instance. It is intentionally skipped, not failed, when CPA is not configured:
// the UI must still boot and explain what is missing.
func buildUsagePipeline(cfg config.Config, repo *repository.Repository, handler *api.Handler, logger *slog.Logger, fingerprinter interface {
	Fingerprint(...string) (string, error)
}) (*ingest.Pipeline, error) {
	if !cfg.Usage.Enabled || cfg.Usage.Mode == string(ingest.ModeOff) {
		logger.Info("usage ingestion disabled", "mode", cfg.Usage.Mode, "enabled", cfg.Usage.Enabled)
		return nil, nil
	}
	if strings.TrimSpace(cfg.CPA.BaseURL) == "" || strings.TrimSpace(cfg.CPA.ManagementKey) == "" {
		logger.Info("usage ingestion waiting for a configured CPA instance")
		return nil, nil
	}
	client, err := management.NewClient(cfg.CPA.BaseURL, cfg.CPA.ManagementKey, cfg.RequestTimeout, cfg.TLSSkipVerify)
	if err != nil {
		return nil, fmt.Errorf("build CPA usage client: %w", err)
	}
	runner, err := ingest.NewRunner("default", usageUpstream{client}, repo, repo, logger, ingest.Config{
		Mode:          ingest.Mode(cfg.Usage.Mode),
		IdleInterval:  cfg.Usage.IdleInterval,
		BatchSize:     cfg.Usage.BatchSize,
		CollectErrors: cfg.Usage.CollectErrors,
	})
	if err != nil {
		return nil, fmt.Errorf("build usage collector: %w", err)
	}
	processor, err := ingest.NewProcessorWithFingerprinter(repo, logger, 0, cfg.Usage.IdleInterval, fingerprinter)
	if err != nil {
		return nil, fmt.Errorf("build usage processor: %w", err)
	}
	maintenance, err := ingest.NewMaintenance(repo, logger, cfg.Usage.AggregateInterval, cfg.Usage.RetentionDays)
	if err != nil {
		return nil, fmt.Errorf("build usage maintenance: %w", err)
	}
	pipeline, err := ingest.NewPipeline(runner, processor, maintenance, repo)
	if err != nil {
		return nil, fmt.Errorf("build usage pipeline: %w", err)
	}
	handler.SetUsagePipeline(pipeline)
	return pipeline, nil
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

	pipelineErrors := make(chan error, 1)
	if a.pipeline != nil {
		go func() {
			a.logger.Info("usage ingestion started",
				"mode", a.cfg.Usage.Mode,
				"idle_interval", a.cfg.Usage.IdleInterval.String(),
				"batch_size", a.cfg.Usage.BatchSize,
				"retention_days", a.cfg.Usage.RetentionDays)
			pipelineErrors <- a.pipeline.Run(ctx)
		}()
	}

	// The pricing loop is best-effort: losing it keeps prices stale but never
	// stops request capture or the HTTP server.
	go func() {
		if err := a.pricing.Run(ctx); err != nil {
			a.logger.Warn("pricing sync loop stopped", "error", err)
		}
	}()

	select {
	case err := <-pipelineErrors:
		// Losing the capture loop means the dashboard stops gaining history;
		// treat it as fatal rather than serving silently stale numbers.
		if err != nil && !errors.Is(err, context.Canceled) {
			return fmt.Errorf("usage pipeline stopped: %w", err)
		}
		return nil
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
