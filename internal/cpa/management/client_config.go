package management

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
)

// CONFIG_YAML_LIMIT bounds a whole configuration document in either direction.
const CONFIG_YAML_LIMIT = 2 * 1024 * 1024

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

type scalarDef struct {
	Path []string
	Kind string // "bool", "string", "int", "strategy"
	// Default is what CPA runs with when the stored file omits the setting. The
	// v8 view is the stored document without runtime defaults, so the two that
	// are not a zero value are applied here (measured on CPA v8.0.2).
	Default any
}

var knownScalars = map[string]scalarDef{
	"debug":                    {Path: []string{"observability", "logs", "debug"}, Kind: "bool"},
	"proxy_url":                {Path: []string{"requests", "proxy-url"}, Kind: "string"},
	"request_log":              {Path: []string{"observability", "logs", "request-log"}, Kind: "bool"},
	"logging_to_file":          {Path: []string{"observability", "logs", "logging-to-file"}, Kind: "bool"},
	"usage_statistics_enabled": {Path: []string{"observability", "usage", "usage-statistics-enabled"}, Kind: "bool"},
	"request_retry":            {Path: []string{"routing", "retry", "request-retry"}, Kind: "int"},
	"max_retry_interval":       {Path: []string{"routing", "retry", "max-retry-interval"}, Kind: "int"},
	"max_retry_credentials":    {Path: []string{"routing", "retry", "max-retry-credentials"}, Kind: "int"},
	"ws_auth":                  {Path: []string{"oauth", "providers", "aistudio", "ws-auth"}, Kind: "bool", Default: true},
	"force_model_prefix":       {Path: []string{"routing", "force-model-prefix"}, Kind: "bool"},
	"routing_strategy":         {Path: []string{"routing", "strategy"}, Kind: "strategy", Default: "round-robin"},
	"logs_max_total_size_mb":   {Path: []string{"observability", "logs", "logs-max-total-size-mb"}, Kind: "int"},
	"error_logs_max_files":     {Path: []string{"observability", "logs", "error-logs-max-files"}, Kind: "int", Default: int64(10)},
}

// ConfigScalars reads the scalar settings from the v8 configuration view.
func (c *Client) ConfigScalars(ctx context.Context) (ConfigScalarsDTO, error) {
	view, _, err := c.ConfigView(ctx)
	if err != nil {
		return ConfigScalarsDTO{}, err
	}
	read := func(key string) any {
		def := knownScalars[key]
		if value, ok := ValueAt(view, def.Path); ok && value != nil {
			return value
		}
		return def.Default
	}
	return ConfigScalarsDTO{
		// The proxy URL can carry credentials; a scalar projection never does.
		ProxyURL:               configyaml.SanitizeProxyURL(stringValue(read("proxy_url"))),
		WSAuth:                 boolValue(read("ws_auth")),
		ForceModelPrefix:       boolValue(read("force_model_prefix")),
		Debug:                  boolValue(read("debug")),
		RequestLog:             boolValue(read("request_log")),
		LoggingToFile:          boolValue(read("logging_to_file")),
		LogsMaxTotalSizeMB:     int64Value(read("logs_max_total_size_mb")),
		ErrorLogsMaxFiles:      int64Value(read("error_logs_max_files")),
		RoutingStrategy:        stringValue(read("routing_strategy")),
		RequestRetry:           int64Value(read("request_retry")),
		MaxRetryInterval:       int64Value(read("max_retry_interval")),
		MaxRetryCredentials:    int64Value(read("max_retry_credentials")),
		UsageStatisticsEnabled: boolValue(read("usage_statistics_enabled")),
	}, nil
}

// KnownScalarKeys returns a copy of all supported scalar configuration keys.
func KnownScalarKeys() []string {
	keys := make([]string, 0, len(knownScalars))
	for key := range knownScalars {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// UpdateConfigScalar writes one scalar setting at its v8 path.
func (c *Client) UpdateConfigScalar(ctx context.Context, key string, value any) error {
	def, ok := knownScalars[key]
	if !ok {
		return fmt.Errorf("unknown scalar key: %s", key)
	}
	return c.ApplyConfigChanges(ctx, []ConfigChange{{Path: def.Path, Value: value}})
}

// ValueAt walks a decoded JSON object along a v8 path.
func ValueAt(view map[string]any, path []string) (any, bool) {
	var current any = view
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil, false
		}
		current, ok = object[key]
		if !ok {
			return nil, false
		}
	}
	return current, true
}

// ConfigView returns CPA's v8 view of the stored configuration as JSON. It is
// the stored document, not the runtime configuration: omitted settings stay
// omitted. The overview layer must project it into a non-sensitive DTO before
// sending anything to a browser.
func (c *Client) ConfigView(ctx context.Context) (map[string]any, ResponseMeta, error) {
	if c == nil {
		return nil, ResponseMeta{}, errors.New("CPA client is not initialized")
	}
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

// ConfigYAML returns CPA's v8 view of the stored configuration as YAML: the
// document every v8 write is based on, with secrets included. Reading it never
// migrates the stored file.
func (c *Client) ConfigYAML(ctx context.Context) (string, error) {
	if c == nil {
		return "", errors.New("CPA client is not initialized")
	}
	request, err := c.newRequest(ctx, http.MethodGet, "/config.yaml", nil, "")
	if err != nil {
		return "", err
	}
	data, _, err := c.doBytes(request, CONFIG_YAML_LIMIT)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// UpdateConfigYAML replaces the whole configuration with a v8 document. CPA
// rejects legacy field names, so a document it accepts is fully effective.
func (c *Client) UpdateConfigYAML(ctx context.Context, rawYAML string) error {
	if c == nil {
		return errors.New("CPA client is not initialized")
	}
	if len(rawYAML) > CONFIG_YAML_LIMIT {
		return errors.New("configuration YAML exceeds 2MB limit")
	}
	if err := c.keepLegacyConfig(ctx); err != nil {
		return err
	}
	return c.doBody(ctx, http.MethodPut, "/config.yaml", []byte(rawYAML), "application/yaml", nil)
}

// ConfigChange is one entry of a sparse configuration write: a value for a v8
// path, or the removal of that path.
type ConfigChange struct {
	Path   []string `json:"path"`
	Value  any      `json:"value,omitempty"`
	Remove bool     `json:"remove,omitempty"`
}

// ErrInvalidConfigChange reports a change set that cannot be sent as written.
var ErrInvalidConfigChange = errors.New("invalid configuration change")

// ErrConfigPartiallyApplied reports a change set that CPA stopped partway
// through: at least one request landed before one failed, so the stored file is
// neither the old document nor the requested one. It wraps the failure.
var ErrConfigPartiallyApplied = errors.New("configuration change set partially applied")

// ApplyConfigChanges writes only the settings that changed.
//
// Values are merged in one PATCH, so CPA validates them together and applies
// all or none. PATCH merges objects, so a mapping value would keep keys the
// operator removed; each one is replaced with PUT on its own path instead.
// Removals are DELETEs, because a PATCH with null writes the zero value rather
// than dropping the key (measured on CPA v8.0.2); a path that is already absent
// is not an error. CPA has no transaction across these requests, so a failure
// after the first one landed is returned wrapped in ErrConfigPartiallyApplied.
func (c *Client) ApplyConfigChanges(ctx context.Context, changes []ConfigChange) error {
	if c == nil {
		return errors.New("CPA client is not initialized")
	}
	if err := validateConfigChanges(changes); err != nil {
		return err
	}
	if len(changes) == 0 {
		return nil
	}
	if err := c.keepLegacyConfig(ctx); err != nil {
		return err
	}

	merge := map[string]any{}
	var replacements, removals []ConfigChange
	for _, change := range changes {
		switch {
		case change.Remove:
			removals = append(removals, change)
		case isObject(change.Value):
			replacements = append(replacements, change)
		default:
			setAt(merge, change.Path, change.Value)
		}
	}
	hasLanded := false
	failed := func(err error) error {
		if hasLanded {
			return fmt.Errorf("%w: %w", ErrConfigPartiallyApplied, err)
		}
		return err
	}
	if len(merge) > 0 {
		if err := c.doJSONBody(ctx, http.MethodPatch, "/config", merge, nil); err != nil {
			return err
		}
		hasLanded = true
	}
	for _, change := range replacements {
		if err := c.doJSONBody(ctx, http.MethodPut, configPathEndpoint(change.Path), change.Value, nil); err != nil {
			return failed(err)
		}
		hasLanded = true
	}
	for _, change := range removals {
		request, err := c.newRequest(ctx, http.MethodDelete, configPathEndpoint(change.Path), nil, "")
		if err != nil {
			return failed(err)
		}
		if _, err := c.do(request, nil); err != nil {
			var httpErr *HTTPError
			if errors.As(err, &httpErr) && httpErr.StatusCode == http.StatusNotFound && strings.Contains(httpErr.Body, "not_found") {
				continue
			}
			return failed(err)
		}
		hasLanded = true
	}
	return nil
}

func validateConfigChanges(changes []ConfigChange) error {
	seen := make([][]string, 0, len(changes))
	for _, change := range changes {
		if len(change.Path) == 0 {
			return fmt.Errorf("%w: empty path", ErrInvalidConfigChange)
		}
		for _, key := range change.Path {
			if strings.TrimSpace(key) == "" || strings.ContainsAny(key, "/\\") {
				return fmt.Errorf("%w: %q is not a configuration key", ErrInvalidConfigChange, key)
			}
		}
		label := strings.Join(change.Path, ".")
		// A change with neither a value nor a removal would be sent as null,
		// which CPA stores as the zero value instead of leaving the key alone.
		if !change.Remove && change.Value == nil {
			return fmt.Errorf("%w: %s has no value", ErrInvalidConfigChange, label)
		}
		// Two changes on one path, or on a path and a key below it, would depend
		// on the order CPA applies them in. Keys are compared one by one because
		// a mapping key may itself contain a dot.
		for _, other := range seen {
			if isPathPrefix(other, change.Path) || isPathPrefix(change.Path, other) {
				return fmt.Errorf("%w: %s overlaps %s", ErrInvalidConfigChange, label, strings.Join(other, "."))
			}
		}
		seen = append(seen, change.Path)
	}
	return nil
}

func isPathPrefix(prefix, path []string) bool {
	if len(prefix) > len(path) {
		return false
	}
	for i, key := range prefix {
		if path[i] != key {
			return false
		}
	}
	return true
}

func configPathEndpoint(path []string) string {
	escaped := make([]string, len(path))
	for i, key := range path {
		escaped[i] = url.PathEscape(key)
	}
	return "/config/" + strings.Join(escaped, "/")
}

func isObject(value any) bool {
	_, ok := value.(map[string]any)
	return ok
}

func setAt(target map[string]any, path []string, value any) {
	for _, key := range path[:len(path)-1] {
		next, ok := target[key].(map[string]any)
		if !ok {
			next = map[string]any{}
			target[key] = next
		}
		target = next
	}
	target[path[len(path)-1]] = value
}

// IsConfigRejected reports CPA refusing a configuration write as invalid, and
// returns CPA's own explanation (a legacy field name, a wrong type, an unknown
// section). It can quote the offending value, which is the value the operator
// just submitted.
func IsConfigRejected(err error) (string, bool) {
	// Part of a partially applied change set landed, so it is not the refusal
	// that leaves the file unchanged, whatever CPA said about the failing part.
	if errors.Is(err, ErrConfigPartiallyApplied) {
		return "", false
	}
	var httpErr *HTTPError
	// CPA answers 400 for a name it does not accept and 422 for a value of the
	// wrong type; both carry the same body.
	if !errors.As(err, &httpErr) || (httpErr.StatusCode != http.StatusBadRequest && httpErr.StatusCode != http.StatusUnprocessableEntity) {
		return "", false
	}
	var body struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.NewDecoder(bytes.NewReader([]byte(httpErr.Body))).Decode(&body) != nil || body.Error != "invalid_config" {
		return "", false
	}
	return body.Message, true
}
