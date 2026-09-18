package management

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
)

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
func (c *Client) UpdateConfigScalar(ctx context.Context, key string, value any) error {
	def, ok := knownScalarEndpoints[key]
	if !ok {
		return fmt.Errorf("unknown scalar key: %s", key)
	}
	payload := map[string]any{"value": value}
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
