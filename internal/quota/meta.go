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

// Meta's key endpoint reports quota beside minted key material. Decode only the
// observation; neither the key nor account identity belongs in a quota snapshot.
type rawMetaWindow struct {
	UsedPercent     any `json:"used_percent"`
	ResetsAt        any `json:"resets_at"`
	DurationMinutes any `json:"window_duration_mins"`
}
type rawMetaUsage struct {
	Tier   string        `json:"tier"`
	Window rawMetaWindow `json:"window"`
	Weekly rawMetaWindow `json:"weekly"`
}

func ParseMetaUsage(raw []byte, nowMS int64) (*QuotaPlan, []QuotaWindow, error) {
	var payload struct {
		PlanName string       `json:"subs_tier_name"`
		IsActive *bool        `json:"is_subs_active"`
		Usage    rawMetaUsage `json:"subs_usage"`
	}
	if !strings.HasPrefix(strings.TrimSpace(string(raw)), "{") || json.Unmarshal(raw, &payload) != nil {
		return nil, nil, errors.New("invalid Meta quota response")
	}
	label := strings.TrimSpace(payload.PlanName)
	if label == "" {
		label = strings.TrimSpace(payload.Usage.Tier)
	}
	if label == "" {
		label = "Meta Muse"
	}
	plan := &QuotaPlan{PlanType: "meta", PlanLabel: label, Tier: "unknown", IsSubscriptionActive: payload.IsActive}
	// The provider reports a variable duration, not a fixed kind. Let the
	// presentation derive a named period only when that duration supports it.
	primary := buildMetaWindow("meta_window", "Usage window", "", payload.Usage.Window, nowMS)
	if minutes, ok := toFloat(payload.Usage.Window.DurationMinutes); ok && minutes > 0 && !math.IsInf(minutes, 0) && !math.IsNaN(minutes) {
		hours := minutes / 60
		primary.PeriodHours = &hours
	}
	weekly := buildMetaWindow("meta_weekly", "Weekly", "weekly", payload.Usage.Weekly, nowMS)
	weeklyHours := 168.0
	weekly.PeriodHours = &weeklyHours
	return plan, []QuotaWindow{primary, weekly}, nil
}

func buildMetaWindow(id, label, kind string, raw rawMetaWindow, nowMS int64) QuotaWindow {
	window := QuotaWindow{ID: id, Label: label, Kind: kind, Scope: "standard"}
	if percent, ok := toFloat(raw.UsedPercent); ok && !math.IsInf(percent, 0) && !math.IsNaN(percent) {
		used := clamp(percent, 0, 100)
		remaining := 100 - used
		window.UsedPercent = &used
		window.RemainingPercent = &remaining
	}
	if seconds, ok := toFloat(raw.ResetsAt); ok && seconds > 0 && seconds < float64(math.MaxInt64)/1000 && !math.IsNaN(seconds) {
		resetAtMS := int64(seconds * 1000)
		window.ResetAtMS = &resetAtMS
		window.ResetLabel = formatResetInstant(resetAtMS, nowMS)
		window.ResetAccuracy = "exact"
	}
	return window
}

// Meta's OAuth access_token can be a minted LLM key. The quota endpoint needs the
// persisted DCA token instead; never fall back to another credential field.
type metaCredentialDownloader interface {
	DownloadAuthFile(context.Context, string) ([]byte, management.ResponseMeta, error)
}

func (s *Service) fetchMetaQuota(ctx context.Context, file management.AuthFile, nowMS int64) (*QuotaPlan, []QuotaWindow, error) {
	if file.RuntimeOnly || strings.TrimSpace(file.Name) == "" || strings.TrimSpace(file.AuthIndex) == "" {
		return nil, nil, errors.New("Meta quota requires a stored credential file and auth index")
	}
	downloader, ok := s.client.(metaCredentialDownloader)
	if !ok {
		return nil, nil, errors.New("Meta quota credential download is unavailable")
	}
	raw, _, err := downloader.DownloadAuthFile(ctx, file.Name)
	if err != nil {
		return nil, nil, errors.New("Meta quota credential download failed")
	}
	defer clear(raw)
	var credential struct {
		Type     string `json:"type"`
		DcaToken string `json:"dca_token"`
	}
	if json.Unmarshal(raw, &credential) != nil {
		return nil, nil, errors.New("invalid Meta quota credential file")
	}
	token := strings.TrimSpace(credential.DcaToken)
	if (credential.Type != "" && DetectProvider(credential.Type, "") != "meta") || !strings.HasPrefix(token, "dca:") || len(token) <= 4 || strings.ContainsFunc(token, func(character rune) bool { return unicode.IsSpace(character) || unicode.IsControl(character) }) {
		return nil, nil, errors.New("Meta quota credential is missing a valid DCA token")
	}
	headers := map[string]string{"Accept": "application/json", "Content-Type": "application/json", "Authorization": "Bearer " + token, "x-api-version": "1.0.0"}
	response, err := s.SafeApiCall(ctx, file.AuthIndex, "POST", MetaUsageURL, headers, "{}")
	// Transport and HTTP failures can echo either the DCA token or a minted key.
	// Their bodies and underlying error strings must not enter the public result.
	if err != nil {
		return nil, nil, errors.New("Meta quota request failed")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, nil, fmt.Errorf("Meta quota request failed (HTTP %d)", response.StatusCode)
	}
	body, err := response.NormalizedBody()
	if err != nil {
		return nil, nil, errors.New("invalid Meta quota response")
	}
	return ParseMetaUsage(body, nowMS)
}
