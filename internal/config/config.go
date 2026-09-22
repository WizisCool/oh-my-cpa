package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net"
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
	Release        ReleaseConfig
	// TrustedProxyCIDRs are the direct peer networks whose forwarding headers
	// may be used for per-client login throttling. Empty means trust none.
	TrustedProxyCIDRs []string
	// IsDemoMode turns this process into the public demonstration build: the
	// console is served from fixtures, so it needs no CPA, no management key and
	// no provider credential, and the server refuses every operator surface that
	// would touch real secret material. It is off unless OMCPA_DEMO_MODE is set,
	// which is what keeps the self-hosted default byte-for-byte unchanged.
	IsDemoMode bool
}

// ReleaseConfig controls the release-observation surface: which published versions
// the console reports, and whether it looks for them on its own.
type ReleaseConfig struct {
	// Enabled gates the background sweep only. The page's own check and the manual
	// button keep working when it is false, because those are an operator asking a
	// question rather than the process deciding to talk to the internet.
	Enabled bool
	// AutoCheck gates the check the page performs when it is opened, independently of
	// Enabled. It exists because two questions are not one: "may this process reach the
	// internet on its own" and "may opening a page spend a request from a shared budget".
	// A self-hosted deployment wants the first disabled and the second enabled - the page
	// exists to answer "is there a newer version". A test suite wants both disabled, since
	// its page visits are not a reader asking anything. The manual button keeps working in
	// both cases, because that is an operator's explicit request.
	AutoCheck bool
	// OMCRepository and CPARepository name the published release sources as
	// "owner/name". Only the identifier is configurable: the host is fixed, so this
	// cannot become a way to make the server fetch an arbitrary address.
	OMCRepository string
	CPARepository string
	// Interval is the background sweep period.
	Interval time.Duration
}

// Default release sources. The gateway default is the upstream the project is built
// against; the console default is this project's own repository. A deployment that
// runs a fork overrides them rather than editing code.
const (
	DefaultOMCRepository = "WizisCool/oh-my-cpa"
	DefaultCPARepository = "router-for-me/CLIProxyAPI"
	// DefaultReleaseInterval is six hours: often enough to notice a release the same
	// day, rare enough that the unauthenticated GitHub budget of sixty requests per
	// hour is never at risk from the sweep itself.
	DefaultReleaseInterval = 6 * time.Hour
)

// DemoModeEnv is the switch that turns a self-hosted deployment into the public
// demonstration. The default is deliberately off.
const DemoModeEnv = "OMCPA_DEMO_MODE"

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
	demoMode, err := parseBoolEnv(DemoModeEnv, false)
	if err != nil {
		return Config{}, err
	}

	basePathEnv := strings.TrimSpace(os.Getenv("OMCPA_BASE_PATH"))
	if demoMode && basePathEnv == "" {
		// A pasted demo URL has to be the console itself. Only the demo default
		// moves; an explicit OMCPA_BASE_PATH still wins, so a self-hosted
		// deployment that turned the demo on keeps its own sub-path.
		basePathEnv = "/"
	}
	basePath, err := NormalizeBasePath(basePathEnv)
	if err != nil {
		return Config{}, fmt.Errorf("OMCPA_BASE_PATH: %w", err)
	}

	dataDir := strings.TrimSpace(os.Getenv("OMCPA_DATA_DIR"))
	if dataDir == "" {
		dataDir = "./data"
		if demoMode {
			// Demo data is disposable by definition, and the platform that runs the
			// public demo mounts no writable volume: /tmp is the only directory a
			// container image may write to there.
			dataDir = filepath.Join(os.TempDir(), "oh-my-cpa-demo")
		}
	}
	dataDir = filepath.Clean(dataDir)

	listenAddr := strings.TrimSpace(os.Getenv("OMCPA_LISTEN_ADDR"))
	if listenAddr == "" {
		listenAddr = ":8080"
		if demoMode {
			listenAddr = demoListenAddr()
		}
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
	trustedProxyCIDRs, err := parseTrustedProxyCIDRs()
	if err != nil {
		return Config{}, err
	}

	masterKey := strings.TrimSpace(os.Getenv("OMCPA_MASTER_KEY"))
	publicURL := strings.TrimSpace(os.Getenv("OMCPA_PUBLIC_URL"))
	if demoMode {
		if masterKey == "" {
			// A demo holds no operator secret to protect, and demanding one would make
			// the deployment refuse to boot over a value nobody needs. Rotating it per
			// process is what makes a restarted demo start from a clean fixture again.
			masterKey, err = randomDemoMasterKey()
			if err != nil {
				return Config{}, err
			}
		}
		// The origin is stated by OMCPA_PUBLIC_URL rather than discovered, because the
		// demonstration no longer runs on a platform that announces one. A demo without
		// it keeps a session cookie usable over plain HTTP, which is what a local run
		// wants; a deployment sets it.
	}

	usage, err := loadUsageConfig()
	if err != nil {
		return Config{}, err
	}
	releaseConfig, err := loadReleaseConfig()
	if err != nil {
		return Config{}, err
	}
	if demoMode {
		// The fixture database is the whole history, and there is no CPA queue to
		// drain: leaving capture on would only poll an upstream that does not
		// exist and overwrite the fixture with nothing.
		usage.Enabled = false
		usage.Mode = "off"
	}

	cpa := CPAConfig{
		BaseURL:       baseURL,
		UsageAddr:     usageAddr,
		ManagementKey: strings.TrimSpace(os.Getenv("OMCPA_CPA_MANAGEMENT_KEY")),
	}
	if demoMode {
		// The real endpoint is replaced by the in-process fixture once it is
		// listening; see internal/demo. Clearing it here keeps the fixture the only
		// credential a demo can carry, even if the deployment inherits a stale one.
		cpa = CPAConfig{}
	}

	databasePath := filepath.Join(dataDir, "oh-my-cpa.db")
	if demoMode {
		// A demo database is per-boot: it is deleted and rebuilt so the history always
		// ends at the moment the visitor arrives. The file has its own name so that a
		// deployment which pointed the demo at a directory holding real data cannot
		// have that data deleted with it.
		databasePath = filepath.Join(dataDir, "oh-my-cpa-demo.db")
	}

	return Config{
		ListenAddr:        listenAddr,
		Usage:             usage,
		BasePath:          basePath,
		DataDir:           dataDir,
		DatabasePath:      databasePath,
		MasterKey:         masterKey,
		PublicURL:         publicURL,
		Version:           envOr("OMCPA_VERSION", "v0.1.0-dev"),
		RequestTimeout:    timeout,
		TLSSkipVerify:     tlsSkipVerify,
		TrustedProxyCIDRs: trustedProxyCIDRs,
		Release:           releaseConfig,
		CPA:               cpa,
		IsDemoMode:        demoMode,
	}, nil
}

// loadReleaseConfig reads the release-observation settings.
//
// A malformed boolean is reported rather than ignored, matching every other switch in this
// file. Ignoring it would leave a deployment that asked to stop reaching the internet doing
// exactly that, with nothing to indicate the setting had not been understood.
func loadReleaseConfig() (ReleaseConfig, error) {
	enabled, err := parseBoolEnv("OMCPA_UPDATE_CHECK_ENABLED", true)
	if err != nil {
		return ReleaseConfig{}, err
	}
	autoCheck, err := parseBoolEnv("OMCPA_UPDATE_CHECK_ON_PAGE_LOAD", true)
	if err != nil {
		return ReleaseConfig{}, err
	}
	return ReleaseConfig{
		Enabled:       enabled,
		AutoCheck:     autoCheck,
		OMCRepository: envOr("OMCPA_OMC_REPO", DefaultOMCRepository),
		CPARepository: envOr("OMCPA_CPA_REPO", DefaultCPARepository),
		Interval:      DefaultReleaseInterval,
	}, nil
}

func parseTrustedProxyCIDRs() ([]string, error) {
	raw := strings.TrimSpace(os.Getenv("OMCPA_TRUSTED_PROXY_CIDRS"))
	if raw == "" {
		return nil, nil
	}
	networks := make([]string, 0)
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		_, network, err := net.ParseCIDR(entry)
		if err != nil {
			return nil, fmt.Errorf("OMCPA_TRUSTED_PROXY_CIDRS contains %q: %w", entry, err)
		}
		networks = append(networks, network.String())
	}
	return networks, nil
}

// demoListenAddr resolves the port the public demo serves on. A container
// platform routes to a port it chooses and announces it through PORT, while a
// local run keeps the documented default.
func demoListenAddr() string {
	if port := strings.TrimSpace(os.Getenv("PORT")); port != "" {
		return ":" + port
	}
	return ":8080"
}

// randomDemoMasterKey mints the per-process key that encrypts the demo's
// disposable local state. It is never displayed, exported or persisted.
func randomDemoMasterKey() (string, error) {
	material := make([]byte, 32)
	if _, err := rand.Read(material); err != nil {
		return "", fmt.Errorf("generate demo master key: %w", err)
	}
	return hex.EncodeToString(material), nil
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
	// 400 days, not 90: the dashboard's token grid is a calendar year, so a shorter horizon would
	// leave the year's own beginning unreadable from October onward - the panel would spend the last
	// quarter of every year showing that spring had no traffic. 400 rather than 365 leaves enough
	// slack that neither a leap year nor an offset boundary can push January 1st out of the window.
	retentionDays := 400
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
