package management

import (
	"context"
	"sort"
)

// RoutingSettings are the gateway-wide settings that decide how CPA spreads a
// request over the credentials able to serve it: the strategy inside a
// priority tier, session pinning, and how far a failing request travels.
//
// Absent settings read as what CPA runs with, as ConfigScalars does: the v8
// view is the stored document without runtime defaults.
type RoutingSettings struct {
	Strategy                      string `json:"strategy"`
	SessionAffinity               bool   `json:"session_affinity"`
	SessionAffinityTTL            string `json:"session_affinity_ttl"`
	RequestRetry                  int64  `json:"request_retry"`
	MaxRetryCredentials           int64  `json:"max_retry_credentials"`
	MaxRetryInterval              int64  `json:"max_retry_interval"`
	DisableCooling                bool   `json:"disable_cooling"`
	TransientErrorCooldownSeconds int64  `json:"transient_error_cooldown_seconds"`
	ForceModelPrefix              bool   `json:"force_model_prefix"`
}

// ROUTING_SETTING_PATHS maps each editable routing setting, by its JSON name in
// RoutingSettings, to its v8 path. force_model_prefix is read for model
// eligibility but is a naming rule, not a scheduling one, so it is not here.
var ROUTING_SETTING_PATHS = map[string][]string{
	"strategy":                         {"routing", "strategy"},
	"session_affinity":                 {"routing", "session-affinity"},
	"session_affinity_ttl":             {"routing", "session-affinity-ttl"},
	"request_retry":                    {"routing", "retry", "request-retry"},
	"max_retry_credentials":            {"routing", "retry", "max-retry-credentials"},
	"max_retry_interval":               {"routing", "retry", "max-retry-interval"},
	"disable_cooling":                  {"routing", "cooldown", "disable-cooling"},
	"transient_error_cooldown_seconds": {"routing", "cooldown", "transient-error-cooldown-seconds"},
}

// RoutingSettingKeys returns the editable routing setting names in a stable order.
func RoutingSettingKeys() []string {
	keys := make([]string, 0, len(ROUTING_SETTING_PATHS))
	for key := range ROUTING_SETTING_PATHS {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// RoutingSettings reads the routing settings from the v8 configuration view.
func (c *Client) RoutingSettings(ctx context.Context) (RoutingSettings, error) {
	view, _, err := c.ConfigView(ctx)
	if err != nil {
		return RoutingSettings{}, err
	}
	read := func(path []string) any {
		value, _ := ValueAt(view, path)
		return value
	}
	settings := RoutingSettings{
		Strategy:                      stringValue(read(ROUTING_SETTING_PATHS["strategy"])),
		SessionAffinity:               boolValue(read(ROUTING_SETTING_PATHS["session_affinity"])),
		SessionAffinityTTL:            stringValue(read(ROUTING_SETTING_PATHS["session_affinity_ttl"])),
		RequestRetry:                  int64Value(read(ROUTING_SETTING_PATHS["request_retry"])),
		MaxRetryCredentials:           int64Value(read(ROUTING_SETTING_PATHS["max_retry_credentials"])),
		MaxRetryInterval:              int64Value(read(ROUTING_SETTING_PATHS["max_retry_interval"])),
		DisableCooling:                boolValue(read(ROUTING_SETTING_PATHS["disable_cooling"])),
		TransientErrorCooldownSeconds: int64Value(read(ROUTING_SETTING_PATHS["transient_error_cooldown_seconds"])),
		ForceModelPrefix:              boolValue(read(knownScalars["force_model_prefix"].Path)),
	}
	if settings.Strategy == "" {
		settings.Strategy = knownScalars["routing_strategy"].Default.(string)
	}
	return settings, nil
}
