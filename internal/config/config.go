package config

import (
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Config contains process configuration. Secrets are read once at startup and
// are never included in API responses.
type Config struct {
	ListenAddr     string
	BasePath       string
	DataDir        string
	DatabasePath   string
	CPA            CPAConfig
	MasterKey      string
	Usage          UsageConfig
	PublicURL      string
	Version        string
	RequestTimeout time.Duration
	TLSSkipVerify  bool
}

// UsageConfig controls the request-record pipeline that backs the dashboard and
// every later analytics feature.
type UsageConfig struct {
	// Enabled gates background capture. When false the dashboard still serves
	// whatever was stored before, but nothing new is collected.
	Enabled bool
	// Mode selects the collection path: auto, subscribe, resp_pull, http_pull or off.
	Mode string
	// IdleInterval is the active polling delay; empty queues back off to MaxIdleInterval.
	IdleInterval    time.Duration
	MaxIdleInterval time.Duration
	// BatchSize caps one pop.
	BatchSize int
	// AggregateInterval bounds how stale rollup-assisted queries can get.
	AggregateInterval time.Duration
	// RetentionDays prunes detail and rollup rows; zero keeps everything.
	RetentionDays int
	// CollectErrors also subscribes to CPA's push-only errors channel.
	CollectErrors bool
}

type CPAConfig struct {
	BaseURL       string
	UsageAddr     string
	ManagementKey string
}

// NormalizeBasePath returns a clean URL path without a trailing slash. An
// empty environment value means the documented default (/omc); callers that
// explicitly need the site root should pass "/".
func NormalizeBasePath(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "/omc", nil
	}
	if raw == "/" {
		return "", nil
	}
	if !strings.HasPrefix(raw, "/") {
		raw = "/" + raw
	}
	if strings.ContainsAny(raw, "?#") {
		return "", fmt.Errorf("base path must not contain query or fragment")
	}
	for _, segment := range strings.Split(raw, "/") {
		if segment == ".." {
			return "", fmt.Errorf("base path must not contain parent traversal")
		}
	}
	clean := path.Clean(raw)
	if clean == "." || clean == "/" {
		return "", nil
	}
	return clean, nil
}

func Load() (Config, error) {
	basePath, err := NormalizeBasePath(os.Getenv("OMCPA_BASE_PATH"))
	if err != nil {
		return Config{}, fmt.Errorf("OMCPA_BASE_PATH: %w", err)
	}

	dataDir := strings.TrimSpace(os.Getenv("OMCPA_DATA_DIR"))
	if dataDir == "" {
		dataDir = "./data"
	}
	dataDir = filepath.Clean(dataDir)

	listenAddr := strings.TrimSpace(os.Getenv("OMCPA_LISTEN_ADDR"))
	if listenAddr == "" {
		listenAddr = ":8080"
	}

	baseURL := strings.TrimSpace(os.Getenv("OMCPA_CPA_BASE_URL"))
	usageAddr := strings.TrimSpace(os.Getenv("OMCPA_CPA_USAGE_ADDR"))
	if usageAddr == "" && baseURL != "" {
		usageAddr = deriveUsageAddr(baseURL)
	}

	timeout := 15 * time.Second
	if raw := strings.TrimSpace(os.Getenv("OMCPA_REQUEST_TIMEOUT")); raw != "" {
		parsed, parseErr := time.ParseDuration(raw)
		if parseErr != nil || parsed <= 0 {
			return Config{}, fmt.Errorf("OMCPA_REQUEST_TIMEOUT must be a positive duration: %q", raw)
		}
		timeout = parsed
	}

	tlsSkipVerify, err := parseBoolEnv("OMCPA_CPA_TLS_SKIP_VERIFY", false)
	if err != nil {
		return Config{}, err
	}

	usage, err := loadUsageConfig()
	if err != nil {
		return Config{}, err
	}

	return Config{
		ListenAddr:     listenAddr,
		Usage:          usage,
		BasePath:       basePath,
		DataDir:        dataDir,
		DatabasePath:   filepath.Join(dataDir, "oh-my-cpa.db"),
		MasterKey:      strings.TrimSpace(os.Getenv("OMCPA_MASTER_KEY")),
		PublicURL:      strings.TrimSpace(os.Getenv("OMCPA_PUBLIC_URL")),
		Version:        envOr("OMCPA_VERSION", "v0.1.0-dev"),
		RequestTimeout: timeout,
		TLSSkipVerify:  tlsSkipVerify,
		CPA: CPAConfig{
			BaseURL:       baseURL,
			UsageAddr:     usageAddr,
			ManagementKey: strings.TrimSpace(os.Getenv("OMCPA_CPA_MANAGEMENT_KEY")),
		},
	}, nil
}

func deriveUsageAddr(rawBaseURL string) string {
	parsed, err := url.Parse(rawBaseURL)
	if err != nil || parsed.Hostname() == "" {
		return ""
	}
	port := parsed.Port()
	if port == "" {
		port = "8317"
	}
	return parsed.Hostname() + ":" + port
}

func parseBoolEnv(name string, fallback bool) (bool, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, fmt.Errorf("%s must be boolean: %q", name, raw)
	}
	return value, nil
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

// loadUsageConfig reads the request-record pipeline settings.
func loadUsageConfig() (UsageConfig, error) {
	enabled, err := parseBoolEnv("OMCPA_USAGE_INGEST_ENABLED", true)
	if err != nil {
		return UsageConfig{}, err
	}
	collectErrors, err := parseBoolEnv("OMCPA_USAGE_COLLECT_ERRORS", true)
	if err != nil {
		return UsageConfig{}, err
	}
	idleInterval := time.Second
	if raw := strings.TrimSpace(os.Getenv("OMCPA_USAGE_IDLE_INTERVAL")); raw != "" {
		parsed, parseErr := time.ParseDuration(raw)
		if parseErr != nil || parsed <= 0 {
			return UsageConfig{}, fmt.Errorf("OMCPA_USAGE_IDLE_INTERVAL must be a positive duration: %q", raw)
		}
		idleInterval = parsed
	}
	maxIdleInterval := max(idleInterval, 10*time.Second)
	if raw := strings.TrimSpace(os.Getenv("OMCPA_USAGE_MAX_IDLE_INTERVAL")); raw != "" {
		parsed, parseErr := time.ParseDuration(raw)
		if parseErr != nil || parsed < idleInterval {
			return UsageConfig{}, fmt.Errorf("OMCPA_USAGE_MAX_IDLE_INTERVAL must be at least OMCPA_USAGE_IDLE_INTERVAL: %q", raw)
		}
		maxIdleInterval = parsed
	}
	aggregateInterval := 15 * time.Second
	if raw := strings.TrimSpace(os.Getenv("OMCPA_USAGE_AGGREGATE_INTERVAL")); raw != "" {
		parsed, parseErr := time.ParseDuration(raw)
		if parseErr != nil || parsed <= 0 {
			return UsageConfig{}, fmt.Errorf("OMCPA_USAGE_AGGREGATE_INTERVAL must be a positive duration: %q", raw)
		}
		aggregateInterval = parsed
	}
	batchSize := 1000
	if raw := strings.TrimSpace(os.Getenv("OMCPA_USAGE_BATCH_SIZE")); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed <= 0 || parsed > 10000 {
			return UsageConfig{}, fmt.Errorf("OMCPA_USAGE_BATCH_SIZE must be between 1 and 10000: %q", raw)
		}
		batchSize = parsed
	}
	retentionDays := 90
	if raw := strings.TrimSpace(os.Getenv("OMCPA_USAGE_RETENTION_DAYS")); raw != "" {
		parsed, parseErr := strconv.Atoi(raw)
		if parseErr != nil || parsed < 0 {
			return UsageConfig{}, fmt.Errorf("OMCPA_USAGE_RETENTION_DAYS must be zero or positive: %q", raw)
		}
		retentionDays = parsed
	}
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("OMCPA_USAGE_INGEST_MODE")))
	if mode == "" {
		mode = "auto"
	}
	switch mode {
	case "auto", "subscribe", "resp_pull", "http_pull", "off":
	default:
		return UsageConfig{}, fmt.Errorf("OMCPA_USAGE_INGEST_MODE must be auto, subscribe, resp_pull, http_pull or off")
	}
	return UsageConfig{
		Enabled:           enabled,
		Mode:              mode,
		IdleInterval:      idleInterval,
		MaxIdleInterval:   maxIdleInterval,
		BatchSize:         batchSize,
		AggregateInterval: aggregateInterval,
		RetentionDays:     retentionDays,
		CollectErrors:     collectErrors,
	}, nil
}
