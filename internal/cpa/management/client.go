package management

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	baseURL    string
	management string
	httpClient *http.Client
}

func NewClient(baseURL, managementKey string, timeout time.Duration, tlsSkipVerify bool) (*Client, error) {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" {
		return nil, errors.New("CPA base URL is required")
	}
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid CPA base URL %q", baseURL)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("CPA base URL must use http or https")
	}
	if parsed.User != nil {
		return nil, errors.New("CPA base URL must not contain user info")
	}
	if strings.TrimSpace(managementKey) == "" {
		return nil, errors.New("CPA management key is required")
	}
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if tlsSkipVerify {
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true} // #nosec G402 -- explicit operator opt-in for private CPA deployments.
	} else {
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return &Client{
		baseURL:    baseURL,
		management: managementKey,
		httpClient: &http.Client{Timeout: timeout, Transport: transport},
	}, nil
}

func (c *Client) BaseURL() string { return c.baseURL }

// ManagementKeyPresent is intentionally the only key-related observation the
// client exposes. The actual key is never returned or formatted in an error.
func (c *Client) ManagementKeyPresent() bool { return c != nil && c.management != "" }

func (c *Client) DoJSON(ctx context.Context, method, endpoint string, output any) error {
	_, err := c.DoJSONWithMeta(ctx, method, endpoint, output)
	return err
}

// ResponseMeta contains non-sensitive metadata from a CPA management response.
// It intentionally excludes request URLs and authorization values.
type ResponseMeta struct {
	StatusCode int
	Header     http.Header
}

// DoJSONWithMeta is kept as a typed internal escape hatch for response metadata
// such as CPA version headers. Callers still provide a fixed management endpoint;
// this client does not expose a general-purpose browser proxy.
func (c *Client) DoJSONWithMeta(ctx context.Context, method, endpoint string, output any) (ResponseMeta, error) {
	if c == nil {
		return ResponseMeta{}, errors.New("CPA client is not initialized")
	}
	request, err := c.newRequest(ctx, method, endpoint, nil, "")
	if err != nil {
		return ResponseMeta{}, err
	}
	return c.do(request, output)
}

func (c *Client) newRequest(ctx context.Context, method, endpoint string, body io.Reader, contentType string) (*http.Request, error) {
	if c == nil {
		return nil, errors.New("CPA client is not initialized")
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+"/v0/management"+endpoint, body)
	if err != nil {
		return nil, fmt.Errorf("create CPA request: %w", err)
	}
	if strings.TrimSpace(contentType) != "" {
		request.Header.Set("Content-Type", contentType)
	}
	return request, nil
}

func (c *Client) doJSONBody(ctx context.Context, method, endpoint string, payload any, output any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode CPA request: %w", err)
	}
	return c.doBody(ctx, method, endpoint, data, "application/json", output)
}

func (c *Client) doBody(ctx context.Context, method, endpoint string, data []byte, contentType string, output any) error {
	request, err := c.newRequest(ctx, method, endpoint, bytes.NewReader(data), contentType)
	if err != nil {
		return err
	}
	_, err = c.do(request, output)
	return err
}

func (c *Client) AuthFiles(ctx context.Context) (AuthFilesResponse, error) {
	response, _, err := c.AuthFilesWithMeta(ctx)
	return response, err
}

func (c *Client) AuthFilesWithMeta(ctx context.Context) (AuthFilesResponse, ResponseMeta, error) {
	var response AuthFilesResponse
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, "/auth-files", &response)
	if err != nil {
		return AuthFilesResponse{}, meta, err
	}
	return response, meta, nil
}

func (c *Client) CodexAPIKeys(ctx context.Context) (CodexAPIKeysResponse, error) {
	var response CodexAPIKeysResponse
	if err := c.DoJSON(ctx, http.MethodGet, "/codex-api-key", &response); err != nil {
		return CodexAPIKeysResponse{}, err
	}
	return response, nil
}

func (c *Client) OpenAICompatibility(ctx context.Context) (OpenAICompatibilityResponse, error) {
	var response OpenAICompatibilityResponse
	if err := c.DoJSON(ctx, http.MethodGet, "/openai-compatibility", &response); err != nil {
		return OpenAICompatibilityResponse{}, err
	}
	return response, nil
}

type ClientAPIKeysResponse struct {
	APIKeys []string `json:"api-keys"`
}

func (c *Client) ClientAPIKeys(ctx context.Context) ([]string, error) {
	var response ClientAPIKeysResponse
	if err := c.DoJSON(ctx, http.MethodGet, "/api-keys", &response); err != nil {
		return nil, err
	}
	return response.APIKeys, nil
}

func (c *Client) UpdateClientAPIKeys(ctx context.Context, keys []string) error {
	if keys == nil {
		keys = []string{}
	}
	return c.doJSONBody(ctx, http.MethodPut, "/api-keys", keys, nil)
}

func (c *Client) UpdateCodexAPIKeys(ctx context.Context, entries []CodexAPIKey) error {
	if entries == nil {
		entries = []CodexAPIKey{}
	}
	return c.doJSONBody(ctx, http.MethodPut, "/codex-api-key", entries, nil)
}

func (c *Client) UpdateOpenAICompatibility(ctx context.Context, entries []OpenAICompatibility) error {
	if entries == nil {
		entries = []OpenAICompatibility{}
	}
	return c.doJSONBody(ctx, http.MethodPut, "/openai-compatibility", entries, nil)
}

type ClaudeAPIKey struct {
	APIKey         string            `json:"api-key"`
	AuthIndex      string            `json:"auth-index,omitempty"`
	Priority       *int              `json:"priority,omitempty"`
	Weight         *int              `json:"weight,omitempty"`
	Prefix         string            `json:"prefix,omitempty"`
	BaseURL        string            `json:"base-url,omitempty"`
	ProxyURL       string            `json:"proxy-url,omitempty"`
	Models         []ModelAlias      `json:"models,omitempty"`
	Headers        map[string]string `json:"headers,omitempty"`
	DisableCooling *bool             `json:"disable-cooling,omitempty"`
}

type ClaudeAPIKeysResponse struct {
	Entries []ClaudeAPIKey `json:"claude-api-key"`
}

func (c *Client) ClaudeAPIKeys(ctx context.Context) ([]ClaudeAPIKey, error) {
	var response ClaudeAPIKeysResponse
	if err := c.DoJSON(ctx, http.MethodGet, "/claude-api-key", &response); err != nil {
		return nil, err
	}
	return response.Entries, nil
}

type GeminiAPIKey struct {
	APIKey         string            `json:"api-key"`
	AuthIndex      string            `json:"auth-index,omitempty"`
	Priority       *int              `json:"priority,omitempty"`
	Weight         *int              `json:"weight,omitempty"`
	Prefix         string            `json:"prefix,omitempty"`
	BaseURL        string            `json:"base-url,omitempty"`
	ProxyURL       string            `json:"proxy-url,omitempty"`
	Models         []ModelAlias      `json:"models,omitempty"`
	Headers        map[string]string `json:"headers,omitempty"`
	DisableCooling *bool             `json:"disable-cooling,omitempty"`
}

type GeminiAPIKeysResponse struct {
	Entries []GeminiAPIKey `json:"gemini-api-key"`
}

func (c *Client) GeminiAPIKeys(ctx context.Context) ([]GeminiAPIKey, error) {
	var response GeminiAPIKeysResponse
	if err := c.DoJSON(ctx, http.MethodGet, "/gemini-api-key", &response); err != nil {
		return nil, err
	}
	return response.Entries, nil
}

func (c *Client) UpdateClaudeAPIKeys(ctx context.Context, entries []ClaudeAPIKey) error {
	if entries == nil {
		entries = []ClaudeAPIKey{}
	}
	return c.doJSONBody(ctx, http.MethodPut, "/claude-api-key", entries, nil)
}

func (c *Client) UpdateGeminiAPIKeys(ctx context.Context, entries []GeminiAPIKey) error {
	if entries == nil {
		entries = []GeminiAPIKey{}
	}
	return c.doJSONBody(ctx, http.MethodPut, "/gemini-api-key", entries, nil)
}

type OAuthAuthURLResponse struct {
	URL string `json:"url"`
}

func (c *Client) OAuthAuthURL(ctx context.Context, provider string) (string, error) {
	provider = strings.ToLower(strings.TrimSpace(provider))
	var response OAuthAuthURLResponse
	endpoint := fmt.Sprintf("/%s-auth-url", provider)
	if err := c.DoJSON(ctx, http.MethodGet, endpoint, &response); err != nil {
		return "", err
	}
	return response.URL, nil
}

type OAuthStatusResponse struct {
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

func (c *Client) OAuthStatus(ctx context.Context, sessionID string) (OAuthStatusResponse, error) {
	var response OAuthStatusResponse
	endpoint := "/get-auth-status"
	if strings.TrimSpace(sessionID) != "" {
		endpoint += "?session_id=" + url.QueryEscape(sessionID)
	}
	if err := c.DoJSON(ctx, http.MethodGet, endpoint, &response); err != nil {
		return OAuthStatusResponse{}, err
	}
	return response, nil
}

func (c *Client) CancelOAuthSession(ctx context.Context, sessionID string) error {
	endpoint := "/oauth-session"
	if strings.TrimSpace(sessionID) != "" {
		endpoint += "?session_id=" + url.QueryEscape(sessionID)
	}
	return c.DoJSON(ctx, http.MethodDelete, endpoint, nil)
}

func (c *Client) OAuthCallback(ctx context.Context, code, state string) error {
	payload := map[string]string{
		"code":  code,
		"state": state,
	}
	return c.doJSONBody(ctx, http.MethodPost, "/oauth-callback", payload, nil)
}

func (c *Client) ResetQuota(ctx context.Context, authIndex string) error {
	authIndex = strings.TrimSpace(authIndex)
	if authIndex == "" {
		return errors.New("auth_index is required")
	}
	payload := map[string]string{"auth_index": authIndex}
	return c.doJSONBody(ctx, http.MethodPost, "/reset-quota", payload, nil)
}

// PatchAuthFileStatus changes only the disabled state of a named auth file.
// The endpoint and request shape are fixed here rather than supplied by an
// HTTP caller.
func (c *Client) PatchAuthFileStatus(ctx context.Context, name, authIndex string, disabled bool) (map[string]any, error) {
	payload := map[string]any{
		"name":       strings.TrimSpace(name),
		"auth_index": strings.TrimSpace(authIndex),
		"disabled":   disabled,
	}
	var response map[string]any
	if err := c.doJSONBody(ctx, http.MethodPatch, "/auth-files/status", payload, &response); err != nil {
		return nil, err
	}
	return response, nil
}

// PatchAuthFileFields forwards the explicitly validated auth-file metadata
// fields to CPA's fixed fields endpoint.
func (c *Client) PatchAuthFileFields(ctx context.Context, name string, fields map[string]any) (map[string]any, error) {
	payload := make(map[string]any, len(fields)+1)
	payload["name"] = strings.TrimSpace(name)
	for key, value := range fields {
		payload[key] = value
	}
	var response map[string]any
	if err := c.doJSONBody(ctx, http.MethodPatch, "/auth-files/fields", payload, &response); err != nil {
		return nil, err
	}
	return response, nil
}

// UploadAuthFile uses CPA's documented raw-JSON upload form. The filename is
// query-encoded by this method and the handler validates the JSON before it is
// passed here.
func (c *Client) UploadAuthFile(ctx context.Context, name string, data []byte) (map[string]any, error) {
	query := url.Values{}
	query.Set("name", strings.TrimSpace(name))
	var response map[string]any
	if err := c.doBody(ctx, http.MethodPost, "/auth-files?"+query.Encode(), data, "application/json", &response); err != nil {
		return nil, err
	}
	return response, nil
}

// DeleteAuthFiles deletes the named files through CPA's batch JSON contract.
func (c *Client) DeleteAuthFiles(ctx context.Context, names []string) (map[string]any, error) {
	payload := map[string]any{"names": names}
	var response map[string]any
	if err := c.doJSONBody(ctx, http.MethodDelete, "/auth-files", payload, &response); err != nil {
		return nil, err
	}
	return response, nil
}

// DownloadAuthFile returns raw bytes for one explicitly named JSON auth file.
func (c *Client) DownloadAuthFile(ctx context.Context, name string) ([]byte, ResponseMeta, error) {
	query := url.Values{}
	query.Set("name", strings.TrimSpace(name))
	request, err := c.newRequest(ctx, http.MethodGet, "/auth-files/download?"+query.Encode(), nil, "")
	if err != nil {
		return nil, ResponseMeta{}, err
	}
	return c.doBytes(request, 8*1024*1024)
}

// DownloadRequestLog fetches one CPA raw request log by request id.
//
// The id is validated here rather than by callers: CPA resolves it to a filename
// inside its log directory, so a traversal or empty value must never reach it.
// The response is capped like other downloads.
func (c *Client) DownloadRequestLog(ctx context.Context, requestID string) ([]byte, ResponseMeta, error) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" || strings.ContainsAny(requestID, "/\\") || strings.Contains(requestID, "..") {
		return nil, ResponseMeta{}, errors.New("invalid request id")
	}
	request, err := c.newRequest(ctx, http.MethodGet, "/request-log-by-id/"+url.PathEscape(requestID), nil, "")
	if err != nil {
		return nil, ResponseMeta{}, err
	}
	return c.doBytes(request, 16*1024*1024)
}

// AuthFileModels reads the model list for one named auth file.
func (c *Client) AuthFileModels(ctx context.Context, name string) ([]AuthModel, error) {
	query := url.Values{}
	query.Set("name", strings.TrimSpace(name))
	var response struct {
		Models []AuthModel `json:"models"`
	}
	if err := c.DoJSON(ctx, http.MethodGet, "/auth-files/models?"+query.Encode(), &response); err != nil {
		return nil, err
	}
	return response.Models, nil
}

// ConfigScalarsDTO contains safe, non-sensitive projected scalar configuration.
type ConfigScalarsDTO struct {
	ProxyURL               string `json:"proxy_url"`
	WSAuth                 bool   `json:"ws_auth"`
	ForceModelPrefix       bool   `json:"force_model_prefix"`
	Debug                  bool   `json:"debug"`
	RequestLog             bool   `json:"request_log"`
	LoggingToFile          bool   `json:"logging_to_file"`
	LogsMaxTotalSizeMB     int64  `json:"logs_max_total_size_mb"`
	ErrorLogsMaxFiles      int64  `json:"error_logs_max_files"`
	RoutingStrategy        string `json:"routing_strategy"`
	RequestRetry           int64  `json:"request_retry"`
	MaxRetryInterval       int64  `json:"max_retry_interval"`
	MaxRetryCredentials    int64  `json:"max_retry_credentials"`
	UsageStatisticsEnabled bool   `json:"usage_statistics_enabled"`
}

// ConfigScalars fetches and safely projects the scalar settings from CPA.
func (c *Client) ConfigScalars(ctx context.Context) (ConfigScalarsDTO, error) {
	raw, _, err := c.Config(ctx)
	if err != nil {
		return ConfigScalarsDTO{}, err
	}
	dto := ConfigScalarsDTO{
		ProxyURL:               stringValue(raw["proxy-url"]),
		WSAuth:                 boolValue(raw["ws-auth"]),
		ForceModelPrefix:       boolValue(raw["force-model-prefix"]),
		Debug:                  boolValue(raw["debug"]),
		RequestLog:             boolValue(raw["request-log"]),
		LoggingToFile:          boolValue(raw["logging-to-file"]),
		LogsMaxTotalSizeMB:     int64Value(raw["logs-max-total-size-mb"]),
		ErrorLogsMaxFiles:      int64Value(raw["error-logs-max-files"]),
		RequestRetry:           int64Value(raw["request-retry"]),
		MaxRetryInterval:       int64Value(raw["max-retry-interval"]),
		MaxRetryCredentials:    int64Value(raw["max-retry-credentials"]),
		UsageStatisticsEnabled: boolValue(raw["usage-statistics-enabled"]),
	}
	if raw["routing"] != nil {
		if routingMap, ok := raw["routing"].(map[string]any); ok {
			dto.RoutingStrategy = stringValue(routingMap["strategy"])
		}
	}
	if dto.RoutingStrategy == "" {
		dto.RoutingStrategy = "round-robin"
	}
	return dto, nil
}

type scalarEndpointDef struct {
	Path string
	Kind string // "bool", "string", "int", "strategy"
}

var knownScalarEndpoints = map[string]scalarEndpointDef{
	"debug":                    {Path: "/debug", Kind: "bool"},
	"proxy_url":                {Path: "/proxy-url", Kind: "string"},
	"request_log":              {Path: "/request-log", Kind: "bool"},
	"logging_to_file":          {Path: "/logging-to-file", Kind: "bool"},
	"usage_statistics_enabled": {Path: "/usage-statistics-enabled", Kind: "bool"},
	"request_retry":            {Path: "/request-retry", Kind: "int"},
	"max_retry_interval":       {Path: "/max-retry-interval", Kind: "int"},
	"max_retry_credentials":    {Path: "/max-retry-credentials", Kind: "int"},
	"ws_auth":                  {Path: "/ws-auth", Kind: "bool"},
	"force_model_prefix":       {Path: "/force-model-prefix", Kind: "bool"},
	"routing_strategy":         {Path: "/routing/strategy", Kind: "strategy"},
	"logs_max_total_size_mb":   {Path: "/logs-max-total-size-mb", Kind: "int"},
	"error_logs_max_files":     {Path: "/error-logs-max-files", Kind: "int"},
}

// KnownScalarKeys returns a copy of all supported scalar configuration keys.
func KnownScalarKeys() []string {
	keys := make([]string, 0, len(knownScalarEndpoints))
	for k := range knownScalarEndpoints {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// UpdateConfigScalar updates a single scalar configuration setting on CPA.
func (c *Client) UpdateConfigScalar(ctx context.Context, key string, val any) error {
	def, ok := knownScalarEndpoints[key]
	if !ok {
		return fmt.Errorf("unknown scalar key: %s", key)
	}
	payload := map[string]any{"value": val}
	return c.doJSONBody(ctx, http.MethodPut, def.Path, payload, nil)
}

// ConfigYAML fetches the raw configuration YAML file from CPA.
func (c *Client) ConfigYAML(ctx context.Context) (string, error) {
	if c == nil {
		return "", errors.New("CPA client is not initialized")
	}
	req, err := c.newRequest(ctx, http.MethodGet, "/config.yaml", nil, "")
	if err != nil {
		return "", err
	}
	data, _, err := c.doBytes(req, 2*1024*1024)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// UpdateConfigYAML saves the raw configuration YAML file on CPA.
func (c *Client) UpdateConfigYAML(ctx context.Context, rawYAML string) error {
	if c == nil {
		return errors.New("CPA client is not initialized")
	}
	if len(rawYAML) > 2*1024*1024 {
		return errors.New("configuration YAML exceeds 2MB limit")
	}
	return c.doBody(ctx, http.MethodPut, "/config.yaml", []byte(rawYAML), "application/yaml", nil)
}

// Config returns the raw CPA configuration. The overview layer must project it
// into a non-sensitive DTO before sending anything to a browser.
func (c *Client) Config(ctx context.Context) (map[string]any, ResponseMeta, error) {
	var response map[string]any
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, "/config", &response)
	if err != nil {
		return nil, meta, err
	}
	if response == nil {
		response = map[string]any{}
	}
	return response, meta, nil
}

// APIKeyUsage returns recent request buckets grouped by provider and opaque
// composite key. The overview aggregation only exposes provider-level totals;
// composite keys never leave the Go process.
type APIKeyUsageResponse map[string]map[string]APIKeyUsageEntry

type APIKeyUsageEntry struct {
	Success        int64           `json:"success"`
	Failed         int64           `json:"failed"`
	RecentRequests []RecentRequest `json:"recent_requests"`
}

type RecentRequest struct {
	Time    string `json:"time"`
	Success int64  `json:"success"`
	Failed  int64  `json:"failed"`
}

func (c *Client) APIKeyUsage(ctx context.Context) (APIKeyUsageResponse, ResponseMeta, error) {
	var response APIKeyUsageResponse
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, "/api-key-usage", &response)
	if err != nil {
		return nil, meta, err
	}
	if response == nil {
		response = APIKeyUsageResponse{}
	}
	return response, meta, nil
}

// LatestVersion reads the CPA-managed latest version endpoint. It may itself
// depend on GitHub connectivity, so callers should treat failure as partial.
func (c *Client) LatestVersion(ctx context.Context) (string, ResponseMeta, error) {
	var response struct {
		Version string `json:"latest-version"`
	}
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, "/latest-version", &response)
	return strings.TrimSpace(response.Version), meta, err
}

// DefaultLogsLimit and MaxLogsLimit bound one incremental log read.
//
// CPAMC asks for its whole 10k-line buffer on every poll. That is a
// multi-megabyte first response for a page whose whole value is "the recent
// tail", so the default page is smaller; the cap stays at 10k for a deliberate
// widening of the searchable window.
const (
	DefaultLogsLimit = 2000
	MaxLogsLimit     = 10000
)

// LogsQuery narrows one read of CPA's file log.
//
// CPA has two generations of this endpoint: an opaque server-side cursor, and
// the older `after` measured in unix seconds. The cursor wins when the server
// offers one. With `after`, the boundary is re-sent one second back, because a
// second-granularity cut drops whatever else shares that timestamp — a
// duplicated line is recoverable at render time, a missing one is not.
type LogsQuery struct {
	Cursor string
	After  int64
	Limit  int
}

// LogsPage is one normalised incremental read of the log tail.
type LogsPage struct {
	Lines       []string
	LatestAfter int64
	NextCursor  string
	CursorReset bool
}

// Logs reads the tail of CPA's file log.
func (c *Client) Logs(ctx context.Context, query LogsQuery) (LogsPage, ResponseMeta, error) {
	limit := query.Limit
	if limit <= 0 {
		limit = DefaultLogsLimit
	}
	if limit > MaxLogsLimit {
		limit = MaxLogsLimit
	}
	params := url.Values{}
	params.Set("limit", strconv.Itoa(limit))
	if cursor := strings.TrimSpace(query.Cursor); cursor != "" {
		params.Set("cursor", cursor)
	} else if query.After > 1 {
		params.Set("after", strconv.FormatInt(query.After-1, 10))
	}

	// The two positional fields are typed loosely on purpose: CPA builds vary
	// (numbers vs strings, absent vs false), and a rejected decode would blank
	// the whole log page over a cosmetic difference.
	var response struct {
		Lines       []string `json:"lines"`
		LatestAfter any      `json:"latest-timestamp"`
		NextCursor  string   `json:"next-cursor"`
		CursorReset any      `json:"cursor-reset"`
	}
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, "/logs?"+params.Encode(), &response)
	if err != nil {
		return LogsPage{Lines: []string{}}, meta, err
	}
	page := LogsPage{
		Lines:       make([]string, 0, len(response.Lines)),
		LatestAfter: unixSecondsValue(response.LatestAfter),
		NextCursor:  strings.TrimSpace(response.NextCursor),
		CursorReset: boolValue(response.CursorReset),
	}
	for _, line := range response.Lines {
		if trimmed := strings.TrimRight(line, "\r\n"); trimmed != "" {
			page.Lines = append(page.Lines, trimmed)
		}
	}
	return page, meta, nil
}

// ClearLogs truncates CPA's log file. Destructive, and never reached by a
// poll: only an explicit operator action gets here.
func (c *Client) ClearLogs(ctx context.Context) (ResponseMeta, error) {
	return c.DoJSONWithMeta(ctx, http.MethodDelete, "/logs", nil)
}

// ErrorLogFile is one request-error log file held by CPA.
type ErrorLogFile struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
}

// RequestErrorLogs lists the downloadable request-error log files.
func (c *Client) RequestErrorLogs(ctx context.Context) ([]ErrorLogFile, error) {
	var response struct {
		Files []struct {
			Name     string `json:"name"`
			Size     any    `json:"size"`
			Modified any    `json:"modified"`
		} `json:"files"`
	}
	if err := c.DoJSON(ctx, http.MethodGet, "/request-error-logs", &response); err != nil {
		return nil, err
	}
	files := make([]ErrorLogFile, 0, len(response.Files))
	for _, file := range response.Files {
		name := strings.TrimSpace(file.Name)
		if name == "" {
			continue
		}
		files = append(files, ErrorLogFile{
			Name:     name,
			Size:     int64Value(file.Size),
			Modified: unixSecondsValue(file.Modified),
		})
	}
	return files, nil
}

// DownloadRequestErrorLog returns raw bytes for one named error log file.
//
// The name is validated here rather than by callers: CPA resolves it inside its
// log directory, so an empty value, a traversal or a path separator must never
// reach it.
func (c *Client) DownloadRequestErrorLog(ctx context.Context, name string) ([]byte, ResponseMeta, error) {
	if !ValidLogFileName(name) {
		return nil, ResponseMeta{}, errors.New("invalid log file name")
	}
	request, err := c.newRequest(ctx, http.MethodGet, "/request-error-logs/"+url.PathEscape(name), nil, "")
	if err != nil {
		return nil, ResponseMeta{}, err
	}
	return c.doBytes(request, 16*1024*1024)
}

// ValidLogFileName accepts a bare log filename and nothing else.
func ValidLogFileName(name string) bool {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 128 || strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		return false
	}
	return !strings.HasPrefix(name, ".")
}

// unixSecondsValue reads a timestamp CPA may send as a number, a numeric string
// or a date string.
func unixSecondsValue(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case int64:
		return typed
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0
		}
		if parsed, err := strconv.ParseInt(text, 10, 64); err == nil {
			return parsed
		}
		if parsed, err := time.Parse(time.RFC3339, text); err == nil {
			return parsed.Unix()
		}
	}
	return 0
}

func int64Value(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case int64:
		return typed
	case int:
		return int64(typed)
	case string:
		if parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64); err == nil {
			return parsed
		}
	}
	return 0
}

func stringValue(value any) string {
	if typed, ok := value.(string); ok {
		return strings.TrimSpace(typed)
	}
	return ""
}

func boolValue(value any) bool {
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	}
	return false
}

// ProbeResult records the outcome of a read-only probe against a single CPA endpoint.
type ProbeResult struct {
	Endpoint   string `json:"endpoint"`
	StatusCode int    `json:"http_status"`
	LatencyMs  int64  `json:"latency_ms"`
	Status     string `json:"status"` // "supported", "missing", "offline", "error"
	Error      string `json:"error,omitempty"`
}

// ProbeEndpoint performs a bounded, read-only GET against a management endpoint
// to check if upstream supports it, measuring latency and status code without
// buffering large payloads.
func (c *Client) ProbeEndpoint(ctx context.Context, endpoint string) ProbeResult {
	start := time.Now()
	if c == nil {
		return ProbeResult{
			Endpoint:  endpoint,
			Status:    "offline",
			Error:     "CPA client is not initialized",
			LatencyMs: 0,
		}
	}
	req, err := c.newRequest(ctx, http.MethodGet, endpoint, nil, "")
	if err != nil {
		return ProbeResult{
			Endpoint:  endpoint,
			Status:    "error",
			Error:     err.Error(),
			LatencyMs: time.Since(start).Milliseconds(),
		}
	}
	req.Header.Set("Authorization", "Bearer "+c.management)
	req.Header.Set("Accept", "*/*")

	resp, err := c.httpClient.Do(req)
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return ProbeResult{
			Endpoint:  endpoint,
			Status:    "offline",
			LatencyMs: latency,
			Error:     "connection failed",
		}
	}
	defer resp.Body.Close()
	_, _ = io.CopyN(io.Discard, resp.Body, 16*1024)

	res := ProbeResult{
		Endpoint:   endpoint,
		StatusCode: resp.StatusCode,
		LatencyMs:  latency,
	}
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		res.Status = "supported"
	case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusMethodNotAllowed || resp.StatusCode == http.StatusNotImplemented:
		res.Status = "missing"
	default:
		res.Status = "error"
		res.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	return res
}

func (c *Client) Health(ctx context.Context) error {
	// /auth-files is a documented read-only management endpoint and exercises
	// both CPA reachability and management-key authentication.
	var response AuthFilesResponse
	return c.DoJSON(ctx, http.MethodGet, "/auth-files", &response)
}

func (c *Client) do(request *http.Request, output any) (ResponseMeta, error) {
	request.Header.Set("Authorization", "Bearer "+c.management)
	request.Header.Set("Accept", "application/json")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return ResponseMeta{}, fmt.Errorf("CPA request failed: %w", err)
	}
	defer response.Body.Close()
	meta := ResponseMeta{StatusCode: response.StatusCode, Header: response.Header.Clone()}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 16*1024))
		return meta, &HTTPError{StatusCode: response.StatusCode, Body: redactSecret(strings.TrimSpace(string(body)), c.management)}
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		return meta, nil
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 16*1024*1024))
	if err := decoder.Decode(output); err != nil {
		return meta, fmt.Errorf("decode CPA response: %w", err)
	}
	return meta, nil
}

func (c *Client) doBytes(request *http.Request, maxBytes int64) ([]byte, ResponseMeta, error) {
	request.Header.Set("Authorization", "Bearer "+c.management)
	request.Header.Set("Accept", "application/json, application/octet-stream")
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, ResponseMeta{}, fmt.Errorf("CPA request failed: %w", err)
	}
	defer response.Body.Close()
	meta := ResponseMeta{StatusCode: response.StatusCode, Header: response.Header.Clone()}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 16*1024))
		return nil, meta, &HTTPError{StatusCode: response.StatusCode, Body: redactSecret(strings.TrimSpace(string(body)), c.management)}
	}
	if maxBytes <= 0 {
		maxBytes = 8 * 1024 * 1024
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, meta, fmt.Errorf("read CPA response: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return nil, meta, fmt.Errorf("CPA response exceeds %d bytes", maxBytes)
	}
	return data, meta, nil
}

type HTTPError struct {
	StatusCode int
	Body       string
}

func redactSecret(value, secret string) string {
	if strings.TrimSpace(secret) == "" {
		return value
	}
	return strings.ReplaceAll(value, secret, "[redacted]")
}

func (e *HTTPError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("CPA returned HTTP %d", e.StatusCode)
	}
	return fmt.Sprintf("CPA returned HTTP %d: %s", e.StatusCode, e.Body)
}

type AuthFilesResponse struct {
	Files []AuthFile `json:"files"`
}

type AuthFile struct {
	ID             string                    `json:"id"`
	AuthIndex      string                    `json:"auth_index"`
	Name           string                    `json:"name"`
	Type           string                    `json:"type"`
	Provider       string                    `json:"provider"`
	Label          string                    `json:"label"`
	Status         string                    `json:"status"`
	StatusMessage  string                    `json:"status_message"`
	Disabled       bool                      `json:"disabled"`
	Unavailable    bool                      `json:"unavailable"`
	RuntimeOnly    bool                      `json:"runtime_only"`
	Source         string                    `json:"source"`
	Email          string                    `json:"email"`
	ProjectID      string                    `json:"project_id"`
	AccountType    string                    `json:"account_type"`
	Account        string                    `json:"account"`
	Success        int64                     `json:"success"`
	Failed         int64                     `json:"failed"`
	RecentRequests []RecentRequest           `json:"recent_requests"`
	Quota          map[string]any            `json:"quota"`
	ModelQuotas    map[string]map[string]any `json:"model_quotas"`
	Models         []AuthModel               `json:"models"`
	Priority       int                       `json:"priority"`
	Weight         int64                     `json:"weight"`
	Note           string                    `json:"note"`
	CreatedAt      json.RawMessage           `json:"created_at"`
	UpdatedAt      json.RawMessage           `json:"updated_at"`
	LastRefresh    json.RawMessage           `json:"last_refresh"`
}

type AuthModel struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name"`
}

type CodexAPIKeysResponse struct {
	Entries []CodexAPIKey `json:"codex-api-key"`
}

type CodexAPIKey struct {
	APIKey         string            `json:"api-key"`
	AuthIndex      string            `json:"auth-index,omitempty"`
	BaseURL        string            `json:"base-url,omitempty"`
	ProxyURL       string            `json:"proxy-url,omitempty"`
	Headers        map[string]string `json:"headers,omitempty"`
	Models         []ModelAlias      `json:"models,omitempty"`
	ExcludedModels []string          `json:"excluded-models,omitempty"`
	Priority       *int              `json:"priority,omitempty"`
	Weight         *int              `json:"weight,omitempty"`
	Prefix         string            `json:"prefix,omitempty"`
	DisableCooling *bool             `json:"disable-cooling,omitempty"`
}

type OpenAICompatibilityResponse struct {
	Entries []OpenAICompatibility `json:"openai-compatibility"`
}

type OpenAICompatibility struct {
	Name           string            `json:"name"`
	Disabled       bool              `json:"disabled"`
	Prefix         string            `json:"prefix,omitempty"`
	Priority       *int              `json:"priority,omitempty"`
	DisableCooling bool              `json:"disable-cooling,omitempty"`
	BaseURL        string            `json:"base-url"`
	APIKeyEntries  []APIKeyEntry     `json:"api-key-entries,omitempty"`
	LegacyAPIKeys  []string          `json:"api-keys,omitempty"`
	Models         []ModelAlias      `json:"models,omitempty"`
	Headers        map[string]string `json:"headers,omitempty"`
}

type APIKeyEntry struct {
	APIKey    string `json:"api-key"`
	AuthIndex string `json:"auth-index,omitempty"`
	ProxyURL  string `json:"proxy-url,omitempty"`
	Weight    *int   `json:"weight,omitempty"`
}

type ThinkingSupport struct {
	Min            int      `json:"min,omitempty"`
	Max            int      `json:"max,omitempty"`
	ZeroAllowed    bool     `json:"zero_allowed,omitempty"`
	DynamicAllowed bool     `json:"dynamic_allowed,omitempty"`
	Levels         []string `json:"levels,omitempty"`
}

type ModelAlias struct {
	Name             string           `json:"name"`
	Alias            string           `json:"alias,omitempty"`
	DisplayName      string           `json:"display-name,omitempty"`
	Image            bool             `json:"image,omitempty"`
	MaxContextLength int              `json:"max-context-length,omitempty"`
	ForceMapping     bool             `json:"force-mapping,omitempty"`
	IsCompat         bool             `json:"is-compat,omitempty"`
	Thinking         *ThinkingSupport `json:"thinking,omitempty"`
}

// UsageQueue pops up to count usage records from CPA's redis-backed usage
// queue. Records are single-request accounting events (tokens, latency, model)
// captured when CPA's `usage-statistics-enabled` is on. The queue is
// destructive on CPA side: each successful pop removes the records.
func (c *Client) UsageQueue(ctx context.Context, count int) ([]json.RawMessage, ResponseMeta, error) {
	if count <= 0 {
		count = 1
	}
	endpoint := fmt.Sprintf("/usage-queue?count=%d", count)
	var response []json.RawMessage
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, endpoint, &response)
	if err != nil {
		return nil, meta, err
	}
	if response == nil {
		response = []json.RawMessage{}
	}
	return response, meta, nil
}

type PluginItem struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	Description string         `json:"description,omitempty"`
	Version     string         `json:"version,omitempty"`
	Author      string         `json:"author,omitempty"`
	Enabled     bool           `json:"enabled"`
	Permissions []string       `json:"permissions,omitempty"`
	Config      map[string]any `json:"config,omitempty"`
}

type StorePluginItem struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Version     string   `json:"version,omitempty"`
	Author      string   `json:"author,omitempty"`
	Permissions []string `json:"permissions,omitempty"`
	Installed   bool     `json:"installed"`
}

func (c *Client) Plugins(ctx context.Context) ([]PluginItem, error) {
	var raw json.RawMessage
	if err := c.DoJSON(ctx, http.MethodGet, "/plugins", &raw); err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return []PluginItem{}, nil
	}
	var list []PluginItem
	if err := json.Unmarshal(raw, &list); err == nil {
		return list, nil
	}
	var obj struct {
		Plugins []PluginItem `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil {
		return obj.Plugins, nil
	}
	return []PluginItem{}, nil
}

func (c *Client) SetPluginStatus(ctx context.Context, id string, enabled bool) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("plugin id is required")
	}
	endpoint := fmt.Sprintf("/plugins/%s/status", url.PathEscape(id))
	payload := map[string]any{"enabled": enabled}
	return c.doJSONBody(ctx, http.MethodPost, endpoint, payload, nil)
}

func (c *Client) DeletePlugin(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("plugin id is required")
	}
	endpoint := fmt.Sprintf("/plugins/%s", url.PathEscape(id))
	return c.DoJSON(ctx, http.MethodDelete, endpoint, nil)
}

func (c *Client) SetPluginConfig(ctx context.Context, id string, config map[string]any) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("plugin id is required")
	}
	endpoint := fmt.Sprintf("/plugins/%s/config", url.PathEscape(id))
	return c.doJSONBody(ctx, http.MethodPut, endpoint, config, nil)
}

func (c *Client) PluginStore(ctx context.Context) ([]StorePluginItem, error) {
	var raw json.RawMessage
	if err := c.DoJSON(ctx, http.MethodGet, "/plugin-store", &raw); err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return []StorePluginItem{}, nil
	}
	var list []StorePluginItem
	if err := json.Unmarshal(raw, &list); err == nil {
		return list, nil
	}
	var obj struct {
		Plugins []StorePluginItem `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil {
		return obj.Plugins, nil
	}
	return []StorePluginItem{}, nil
}

func (c *Client) InstallPlugin(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	if id == "" {
		return errors.New("plugin id is required")
	}
	endpoint := fmt.Sprintf("/plugin-store/%s/install", url.PathEscape(id))
	return c.doJSONBody(ctx, http.MethodPost, endpoint, map[string]any{}, nil)
}
