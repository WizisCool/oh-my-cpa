package quota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"unicode"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// builtInQuotaProviders are the credentials with a dedicated quota reader in
// RefreshCredentialQuota. A plugin card is generic by definition: built-ins win
// even when a plugin also advertises quota for the same provider.
var builtInQuotaProviders = map[string]bool{
	"codex": true, "claude": true, "antigravity": true, "kimi": true,
	"xai": true, "meta": true, "devin": true,
}

// pluginQuotaCapabilities is what a plugin-provided credential supports: live
// refresh and cooldown clearing, but no reset credit and no probe of its own.
func pluginQuotaCapabilities() QuotaCapabilities {
	return QuotaCapabilities{
		RefreshSupported:       true,
		ClearCooldownSupported: true,
		ResetCreditSupported:   false,
	}
}

// isPluginQuotaFile reports a credential whose quota comes from a plugin: a
// non-built-in provider carrying CPA's quota advertisement (`supports_quota` /
// `quota_provider`, or a declarative `quota_probe` that resolves to an explicit
// unsupported message instead of a fetch).
func isPluginQuotaFile(file management.AuthFile) bool {
	if builtInQuotaProviders[DetectProvider(file.Type, file.Provider)] {
		return false
	}
	if len(nonNullJSON(file.QuotaProbe)) > 0 {
		return true
	}
	return file.SupportsQuota || strings.TrimSpace(file.QuotaProvider) != ""
}

func nonNullJSON(raw json.RawMessage) json.RawMessage {
	if len(strings.TrimSpace(string(raw))) == 0 || strings.TrimSpace(string(raw)) == "null" {
		return nil
	}
	return raw
}

// resolvePluginQuotaID maps a credential's advertised quota provider to the
// installed plugin that serves it (quota identifier, plugin id, then auth
// provider). An unmatched credential must not be sent to an unrelated plugin,
// even when it is the only registered quota plugin.
func resolvePluginQuotaID(plugins []management.PluginItem, provider string) (string, error) {
	target := strings.ToLower(strings.TrimSpace(provider))
	if target == "" {
		return "", errors.New("credential does not advertise a quota provider")
	}
	candidates := make([]management.PluginItem, 0)
	for _, plugin := range plugins {
		if plugin.Registered && plugin.SupportsQuota {
			candidates = append(candidates, plugin)
		}
	}
	matchID := func(want func(management.PluginItem) string) string {
		for _, plugin := range candidates {
			if strings.ToLower(strings.TrimSpace(want(plugin))) == target {
				return plugin.ID
			}
		}
		return ""
	}
	if id := matchID(func(plugin management.PluginItem) string { return plugin.QuotaProvider }); id != "" {
		return id, nil
	}
	if id := matchID(func(plugin management.PluginItem) string { return plugin.ID }); id != "" {
		return id, nil
	}
	if id := matchID(func(plugin management.PluginItem) string { return plugin.OAuthProvider }); id != "" {
		return id, nil
	}
	return "", fmt.Errorf("no enabled plugin provides quota for %q", provider)
}

// pluginQuotaTarget resolves the plugin id serving a plugin-quota credential.
// CPA's own selection wins when the gateway reports it: matching names here
// cannot see which plugin CPA has fused, so it could pick one CPA bypasses.
// Gateways older than v8.0.25 report no selection and fall back to the match.
// Declarative quota_probe credentials have no v8 management route and report an
// explicit unsupported message instead of failing a fetch.
func (s *Service) pluginQuotaTarget(ctx context.Context, file management.AuthFile) (string, error) {
	if pluginID := strings.TrimSpace(file.QuotaPluginID); pluginID != "" {
		return pluginID, nil
	}
	if s.client == nil {
		return "", errors.New("CPA client is not configured")
	}
	if len(nonNullJSON(file.QuotaProbe)) > 0 && strings.TrimSpace(file.QuotaProvider) == "" {
		return "", errors.New("declarative quota probes are not available through the v8 management API")
	}
	plugins, err := s.client.Plugins(ctx)
	if err != nil {
		return "", err
	}
	return resolvePluginQuotaID(plugins, file.QuotaProvider)
}

// fetchPluginQuota reads a plugin quota payload and projects it onto the
// shared windows/plan shape. Plugin quotas reuse the Antigravity summary
// shape (groups of buckets) with a plan/tier subscription beside it.
func (s *Service) fetchPluginQuota(ctx context.Context, pluginID, authIndex string, nowMS int64) ([]QuotaWindow, *QuotaPlan, error) {
	if s.client == nil {
		return nil, nil, errors.New("CPA client is not configured")
	}
	raw, err := s.client.FetchPluginQuota(ctx, pluginID, authIndex)
	if err != nil {
		return nil, nil, err
	}
	windows, err := parseGroupedQuota(raw, nowMS, 0, true)
	if err != nil {
		return nil, nil, err
	}
	return windows, parsePluginQuotaPlan(raw), nil
}

// Bounds on what a plugin's quota payload can put in front of an operator: the
// text is the plugin's, so it is cut to a line's worth and stripped of control
// characters rather than trusted.
const (
	maxPluginDescriptionRunes = 160
	maxPluginMetricLabelRunes = 48
	maxPluginMetricTokenRunes = 24
	maxPluginMetrics          = 8
)

// pluginDisplayText is plugin-supplied text made fit for one line: control
// characters become spaces, runs of space collapse, and it is cut at limit.
func pluginDisplayText(value string, limit int) string {
	cleaned := strings.Join(strings.FieldsFunc(value, func(r rune) bool {
		return unicode.IsSpace(r) || unicode.IsControl(r)
	}), " ")
	if runes := []rune(cleaned); len(runes) > limit {
		return strings.TrimSpace(string(runes[:limit-1])) + "…"
	}
	return cleaned
}

// pluginCurrencyCode keeps an ISO 4217 code and drops anything else: a cut or
// guessed code would print an amount in the wrong money.
func pluginCurrencyCode(value string) string {
	code := strings.ToUpper(strings.TrimSpace(value))
	if len(code) != 3 {
		return ""
	}
	for _, r := range code {
		if r < 'A' || r > 'Z' {
			return ""
		}
	}
	return code
}

// parsePluginQuotaPlan projects a plugin quota subscription and summary onto a
// plan. The subscription carries display strings only (no active flag, no
// windows), so tier stays unknown rather than guessing elite/premium from a
// name. A payload with neither a subscription label nor a usable metric has no
// plan.
func parsePluginQuotaPlan(raw []byte) *QuotaPlan {
	var payload struct {
		Subscription *struct {
			Plan     string `json:"plan"`
			TierName string `json:"tierName"`
			TierID   string `json:"tierId"`
		} `json:"subscription"`
		Summary []struct {
			Key      string `json:"key"`
			Label    string `json:"label"`
			Value    any    `json:"value"`
			Unit     string `json:"unit"`
			Format   string `json:"format"`
			Currency string `json:"currency"`
		} `json:"summary"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return nil
	}
	label := ""
	if subscription := payload.Subscription; subscription != nil {
		for _, candidate := range []string{subscription.Plan, subscription.TierName, subscription.TierID} {
			if label = pluginDisplayText(candidate, maxPluginMetricLabelRunes); label != "" {
				break
			}
		}
	}
	metrics := make([]QuotaMetric, 0, len(payload.Summary))
	for _, entry := range payload.Summary {
		if len(metrics) == maxPluginMetrics {
			break
		}
		value, ok := toFloat(entry.Value)
		if !ok || math.IsNaN(value) || math.IsInf(value, 0) {
			continue
		}
		key := pluginDisplayText(entry.Key, maxPluginMetricTokenRunes)
		metricLabel := pluginDisplayText(entry.Label, maxPluginMetricLabelRunes)
		if metricLabel == "" {
			metricLabel = key
		}
		if metricLabel == "" {
			continue
		}
		metrics = append(metrics, QuotaMetric{
			Key:      key,
			Label:    metricLabel,
			Value:    value,
			Unit:     pluginDisplayText(entry.Unit, maxPluginMetricTokenRunes),
			Format:   strings.ToLower(pluginDisplayText(entry.Format, maxPluginMetricTokenRunes)),
			Currency: pluginCurrencyCode(entry.Currency),
		})
	}
	if label == "" && len(metrics) == 0 {
		return nil
	}
	plan := &QuotaPlan{PlanType: "unknown", PlanLabel: label, Tier: "unknown"}
	if len(metrics) > 0 {
		plan.Metrics = metrics
	}
	return plan
}
