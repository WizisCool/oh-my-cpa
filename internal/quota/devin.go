package quota

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// DevinSeatStatusURL is Devin's Connect-RPC seat-management endpoint. It is the
// only source of a Devin credential's daily and weekly remaining share: the
// auth file CPA writes carries tokens, not quota.
const DevinSeatStatusURL = "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus"

// DevinConnectProtocolVersion is the Connect-RPC protocol version header the
// seat endpoint requires.
const DevinConnectProtocolVersion = "1"

// devinSeatTokenPlaceholder is CPA's in-body credential marker. The seat API
// takes the token as a request field rather than a header, so CPA substitutes it
// inside the payload; it never enters this process.
const devinSeatTokenPlaceholder = "$TOKEN$"

// The remaining constants impersonate the Devin CLI. The seat endpoint is a
// Connect-RPC handler behind the CLI's own client, and it answers a request that
// does not look like one with an error rather than a status document.
const (
	devinIDEName            = "chisel"
	devinIDEVersion         = "3000.10.21"
	devinClientName         = "chisel"
	devinQuotaRequestLocale = "en"
	devinQuotaRequestOS     = "darwin"
)

// DevinQuotaRequest is the Connect-RPC body Devin's CLI sends. The token is
// substituted by CPA inside the body, so it never enters this process.
//
// The field order is fixed by the struct: Connect-RPC handlers validate the
// request shape, and an encoding difference is a support-burden change with no
// upside for readability.
type DevinQuotaRequest struct {
	Metadata DevinQuotaRequestMetadata `json:"metadata"`
}

type DevinQuotaRequestMetadata struct {
	IDEName          string `json:"ideName"`
	IDEVersion       string `json:"ideVersion"`
	APIKey           string `json:"apiKey"`
	Locale           string `json:"locale"`
	OS               string `json:"os"`
	ExtensionVersion string `json:"extensionVersion"`
	ClientName       string `json:"clientName"`
}

// BuildDevinQuotaRequestBody renders the seat-status request payload.
func BuildDevinQuotaRequestBody() (string, error) {
	payload := DevinQuotaRequest{
		Metadata: DevinQuotaRequestMetadata{
			IDEName:          devinIDEName,
			IDEVersion:       devinIDEVersion,
			APIKey:           devinSeatTokenPlaceholder,
			Locale:           devinQuotaRequestLocale,
			OS:               devinQuotaRequestOS,
			ExtensionVersion: devinIDEVersion,
			ClientName:       devinClientName,
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("encode devin quota request: %w", err)
	}
	return string(encoded), nil
}

type RawDevinPlanInfo struct {
	PlanName    string `json:"planName"`
	PlanNameAlt string `json:"plan_name"`
}

type RawDevinPlanStatus struct {
	PlanInfo *RawDevinPlanInfo `json:"planInfo"`

	DailyQuotaRemainingPercent  any `json:"dailyQuotaRemainingPercent"`
	DailyQuotaResetAtUnix       any `json:"dailyQuotaResetAtUnix"`
	WeeklyQuotaRemainingPercent any `json:"weeklyQuotaRemainingPercent"`
	WeeklyQuotaResetAtUnix      any `json:"weeklyQuotaResetAtUnix"`

	PlanStart    string `json:"planStart"`
	PlanEnd      string `json:"planEnd"`
	PlanStartAlt string `json:"plan_start"`
	PlanEndAlt   string `json:"plan_end"`
}

type RawDevinUserStatus struct {
	PlanStatus *RawDevinPlanStatus `json:"planStatus"`
	// PlanStatusAlt covers the snake_case encoding, which some Devin CLI
	// versions send for the same document.
	PlanStatusAlt *RawDevinPlanStatus `json:"plan_status"`
}

type RawDevinSeatStatus struct {
	UserStatus *RawDevinUserStatus `json:"userStatus"`
	// UserStatusAlt is the snake_case spelling of the same field.
	UserStatusAlt *RawDevinUserStatus `json:"user_status"`
}

// devinPercent reads a remaining share, accepting the number and numeric-string
// encodings Connect-RPC produces for a proto float.
//
// A value outside 0..100 is rejected rather than clamped: Devin has never
// returned one, so an out-of-range reading means the field is not the share it
// is believed to be, and showing "0% remaining" for it would be a fabricated
// exhaustion.
func devinPercent(value any) *float64 {
	parsed, ok := toFloat(value)
	if !ok || parsed < 0 || parsed > 100 {
		return nil
	}
	return &parsed
}

// devinUnixMS reads a reset instant expressed in unix seconds.
//
// Only numeric encodings are accepted. A generic number-or-timestamp parse would
// read a human date as seconds and shift the reset by three orders of magnitude,
// which the card would then present as a real reset time.
func devinUnixMS(value any) *int64 {
	var seconds int64
	switch v := value.(type) {
	case float64:
		seconds = int64(v)
	case int:
		seconds = int64(v)
	case int64:
		seconds = v
	case json.Number:
		parsed, err := v.Int64()
		if err != nil {
			return nil
		}
		seconds = parsed
	case string:
		parsed, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		if err != nil {
			return nil
		}
		seconds = parsed
	default:
		return nil
	}
	if seconds <= 0 {
		return nil
	}
	ms := seconds * 1000
	return &ms
}

// devinInstantMS reads an ISO-8601 instant such as the plan's start and end.
func devinInstantMS(value string) *int64 {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05"} {
		if instant, err := time.Parse(layout, trimmed); err == nil {
			ms := instant.UnixMilli()
			return &ms
		}
	}
	return nil
}

func firstNonEmptyDevin(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// ParseDevinSeatStatus normalizes Devin's seat-status document into the console's
// quota windows and plan.
//
// Both windows are reported as *remaining* shares, matching Devin's own naming.
// A window with neither a share nor a reset instant is still returned, so the
// card can say "no reading" instead of silently omitting a limit the account has.
func ParseDevinSeatStatus(raw []byte, nowMS int64) (*QuotaPlan, []QuotaWindow, error) {
	var payload RawDevinSeatStatus
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, nil, fmt.Errorf("invalid devin seat status payload: %w", err)
	}

	userStatus := payload.UserStatus
	if userStatus == nil {
		userStatus = payload.UserStatusAlt
	}
	if userStatus == nil {
		return nil, nil, fmt.Errorf("devin seat status is missing userStatus")
	}
	status := userStatus.PlanStatus
	if status == nil {
		status = userStatus.PlanStatusAlt
	}
	if status == nil {
		return nil, nil, fmt.Errorf("devin seat status is missing planStatus")
	}

	windows := []QuotaWindow{
		buildDevinWindow("devin_daily", "daily", 24, devinPercent(status.DailyQuotaRemainingPercent), devinUnixMS(status.DailyQuotaResetAtUnix)),
		buildDevinWindow("devin_weekly", "weekly", 168, devinPercent(status.WeeklyQuotaRemainingPercent), devinUnixMS(status.WeeklyQuotaResetAtUnix)),
	}

	planName := ""
	if status.PlanInfo != nil {
		planName = firstNonEmptyDevin(status.PlanInfo.PlanName, status.PlanInfo.PlanNameAlt)
	}
	if planName == "" && status.PlanStart == "" && status.PlanStartAlt == "" && status.PlanEnd == "" && status.PlanEndAlt == "" {
		return nil, windows, nil
	}

	plan := &QuotaPlan{
		PlanType:  "devin",
		PlanLabel: firstNonEmptyDevin(planName, "Devin"),
		Tier:      "standard",
	}
	if endMS := devinInstantMS(firstNonEmptyDevin(status.PlanEnd, status.PlanEndAlt)); endMS != nil {
		plan.ExpiresAtMS = endMS
		plan.ExpiresLabel = formatResetInstant(*endMS, nowMS)
	}
	return plan, windows, nil
}

func buildDevinWindow(id, kind string, periodHours float64, remaining *float64, resetAtMS *int64) QuotaWindow {
	window := QuotaWindow{
		ID:               id,
		Label:            kind,
		Kind:             kind,
		Scope:            "standard",
		RemainingPercent: remaining,
		ResetAtMS:        resetAtMS,
		PeriodHours:      &periodHours,
		ResetAccuracy:    "exact",
	}
	if remaining != nil {
		used := 100 - *remaining
		window.UsedPercent = &used
	}
	return window
}
