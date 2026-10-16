package quota

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

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
	windows, err := ParseAntigravityUsage(raw, nowMS, 0)
	if err != nil {
		return nil, nil, err
	}
	return windows, parsePluginQuotaPlan(raw), nil
}

// parsePluginQuotaPlan projects a plugin quota subscription onto a plan. The
// payload carries display strings only (no active flag, no windows), so tier
// stays unknown rather than guessing elite/premium from a name.
func parsePluginQuotaPlan(raw []byte) *QuotaPlan {
	var payload struct {
		Subscription *struct {
			Plan     string `json:"plan"`
			TierName string `json:"tierName"`
			TierID   string `json:"tierId"`
		} `json:"subscription"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.Subscription == nil {
		return nil
	}
	plan := strings.TrimSpace(payload.Subscription.Plan)
	tierName := strings.TrimSpace(payload.Subscription.TierName)
	tierID := strings.TrimSpace(payload.Subscription.TierID)
	label := plan
	if label == "" {
		label = tierName
	}
	if label == "" {
		label = tierID
	}
	if label == "" {
		return nil
	}
	return &QuotaPlan{PlanType: "unknown", PlanLabel: label, Tier: "unknown"}
}
