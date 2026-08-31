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
	SessionSecret  string
	AdminPassword  string
	PublicURL      string
	Version        string
	RequestTimeout time.Duration
	TLSSkipVerify  bool
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

	return Config{
		ListenAddr:     listenAddr,
		BasePath:       basePath,
		DataDir:        dataDir,
		DatabasePath:   filepath.Join(dataDir, "oh-my-cpa.db"),
		MasterKey:      strings.TrimSpace(os.Getenv("OMCPA_MASTER_KEY")),
		SessionSecret:  strings.TrimSpace(os.Getenv("OMCPA_SESSION_SECRET")),
		AdminPassword:  strings.TrimSpace(os.Getenv("OMCPA_ADMIN_PASSWORD")),
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
