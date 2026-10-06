package quota

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func ParseAntigravitySubscription(raw []byte) *QuotaPlan {
	type tier struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	var payload struct {
		Current    *tier `json:"currentTier"`
		CurrentAlt *tier `json:"current_tier"`
		Paid       *tier `json:"paidTier"`
		PaidAlt    *tier `json:"paid_tier"`
	}
	if json.Unmarshal(raw, &payload) != nil {
		return nil
	}
	current, paid := payload.Current, payload.Paid
	if current == nil {
		current = payload.CurrentAlt
	}
	if paid == nil {
		paid = payload.PaidAlt
	}
	selected := current
	if paid != nil && strings.TrimSpace(paid.ID) != "" {
		selected = paid
	}
	if selected == nil || (strings.TrimSpace(selected.ID) == "" && strings.TrimSpace(selected.Name) == "") {
		return nil
	}
	planType := map[string]string{"free-tier": "free", "g1-pro-tier": "pro", "g1-ultra-tier": "ultra", "g1-ultra-lite-tier": "ultra-lite"}[strings.TrimSpace(selected.ID)]
	if planType != "" {
		return ResolveAntigravityPlan(planType)
	}
	label := strings.TrimSpace(selected.Name)
	if label == "" {
		label = strings.TrimSpace(selected.ID)
	}
	return &QuotaPlan{PlanType: "unknown", PlanLabel: label, Tier: "unknown"}
}

func ParseXaiSubscription(userRaw, settingsRaw []byte) *QuotaPlan {
	var user struct {
		Tier    string `json:"subscriptionTier"`
		TierAlt string `json:"subscription_tier"`
	}
	var settings struct {
		Display    string `json:"subscription_tier_display"`
		DisplayAlt string `json:"subscriptionTierDisplay"`
	}
	if json.Unmarshal(userRaw, &user) != nil {
		user.Tier = ""
		user.TierAlt = ""
	}
	if json.Unmarshal(settingsRaw, &settings) != nil {
		settings.Display = ""
		settings.DisplayAlt = ""
	}
	tier := strings.TrimSpace(user.Tier)
	if tier == "" {
		tier = strings.TrimSpace(user.TierAlt)
	}
	display := strings.TrimSpace(settings.Display)
	if display == "" {
		display = strings.TrimSpace(settings.DisplayAlt)
	}
	label := display
	if label == "" {
		label = tier
	}
	if label == "" {
		return nil
	}
	grade := "standard"
	key := strings.ToLower(tier + " " + display)
	if strings.Contains(key, "heavy") {
		grade = "elite"
	} else if strings.Contains(key, "supergrok") || strings.Contains(key, "premium") {
		grade = "premium"
	}
	return &QuotaPlan{PlanType: "paid", PlanLabel: label, Tier: grade}
}

// Subscription reads enrich a successful quota observation. An unavailable or
// malformed tier must not discard independent usage readings or billing details.
func (s *Service) readSubscriptionBody(ctx context.Context, authIndex, method, targetURL string, headers map[string]string, data string) []byte {
	response, err := s.SafeApiCall(ctx, authIndex, method, targetURL, headers, data)
	if err != nil || response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil
	}
	body, err := response.NormalizedBody()
	if err != nil {
		return nil
	}
	return body
}

func (s *Service) fetchAntigravitySubscription(ctx context.Context, file management.AuthFile) *QuotaPlan {
	headers := management.WithQuotaCredential(map[string]string{"Content-Type": "application/json", "Accept": "application/json", "User-Agent": AntigravityUserAgent})
	raw := s.readSubscriptionBody(ctx, file.AuthIndex, http.MethodPost, AntigravitySubscriptionURL, headers, `{"metadata":{"ideType":"ANTIGRAVITY"}}`)
	plan := ParseAntigravitySubscription(raw)
	if plan != nil {
		return plan
	}
	return &QuotaPlan{PlanType: "unknown", PlanLabel: "Antigravity", Tier: "unknown"}
}

func (s *Service) applyXaiSubscription(ctx context.Context, file management.AuthFile, headers map[string]string, plan *QuotaPlan) {
	user := s.readSubscriptionBody(ctx, file.AuthIndex, http.MethodGet, XaiSubscriptionURL, headers, "")
	settings := s.readSubscriptionBody(ctx, file.AuthIndex, http.MethodGet, XaiSettingsURL, headers, "")
	if subscription := ParseXaiSubscription(user, settings); subscription != nil {
		plan.PlanLabel = subscription.PlanLabel
		plan.Tier = subscription.Tier
	}
}
