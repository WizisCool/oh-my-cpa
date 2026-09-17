package quota

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func TestBuildDevinQuotaRequestBodyCarriesTheCredentialMarker(t *testing.T) {
	body, err := BuildDevinQuotaRequestBody()
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]map[string]any
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatalf("request body is not JSON: %v", err)
	}
	metadata := decoded["metadata"]
	if metadata == nil {
		t.Fatalf("request body has no metadata: %s", body)
	}
	// The seat API reads the token from this field, so the marker has to be in
	// the body: CPA substitutes it there, and a missing marker authenticates
	// nothing.
	if metadata["apiKey"] != "$TOKEN$" {
		t.Fatalf("apiKey = %v, want the CPA credential marker", metadata["apiKey"])
	}
	for _, field := range []string{"ideName", "ideVersion", "clientName", "os", "locale", "extensionVersion"} {
		if value, ok := metadata[field].(string); !ok || value == "" {
			t.Fatalf("%s is missing from the request body: %s", field, body)
		}
	}
}

func TestParseDevinSeatStatusNormalizesBothWindows(t *testing.T) {
	const nowMS = int64(1_700_000_000_000)
	raw := []byte(`{
		"userStatus": {
			"planStatus": {
				"planInfo": {"planName": "Devin Pro"},
				"dailyQuotaRemainingPercent": 62.5,
				"dailyQuotaResetAtUnix": 1700003600,
				"weeklyQuotaRemainingPercent": "10",
				"weeklyQuotaResetAtUnix": "1700600000",
				"planStart": "2023-11-01T00:00:00Z",
				"planEnd": "2023-12-01T00:00:00Z"
			}
		}
	}`)

	plan, windows, err := ParseDevinSeatStatus(raw, nowMS)
	if err != nil {
		t.Fatal(err)
	}
	if len(windows) != 2 {
		t.Fatalf("windows = %d, want 2", len(windows))
	}

	daily := windows[0]
	if daily.ID != "devin_daily" || daily.Kind != "daily" || daily.Scope != "standard" {
		t.Fatalf("unexpected daily window: %#v", daily)
	}
	if daily.RemainingPercent == nil || *daily.RemainingPercent != 62.5 {
		t.Fatalf("daily remaining = %v", daily.RemainingPercent)
	}
	if daily.UsedPercent == nil || *daily.UsedPercent != 37.5 {
		t.Fatalf("daily used = %v", daily.UsedPercent)
	}
	if daily.ResetAtMS == nil || *daily.ResetAtMS != 1_700_003_600_000 {
		t.Fatalf("daily reset = %v", daily.ResetAtMS)
	}
	if daily.PeriodHours == nil || *daily.PeriodHours != 24 {
		t.Fatalf("daily period = %v", daily.PeriodHours)
	}

	weekly := windows[1]
	// Both windows are delivered as JSON numbers and as numeric strings by
	// different Devin builds, so a string reading has to normalize the same way.
	if weekly.RemainingPercent == nil || *weekly.RemainingPercent != 10 {
		t.Fatalf("weekly remaining = %v", weekly.RemainingPercent)
	}
	if weekly.ResetAtMS == nil || *weekly.ResetAtMS != 1_700_600_000_000 {
		t.Fatalf("weekly reset = %v", weekly.ResetAtMS)
	}
	if weekly.PeriodHours == nil || *weekly.PeriodHours != 168 {
		t.Fatalf("weekly period = %v", weekly.PeriodHours)
	}

	if plan == nil || plan.PlanLabel != "Devin Pro" || plan.Tier != "standard" {
		t.Fatalf("unexpected plan: %#v", plan)
	}
	if plan.ExpiresAtMS == nil || plan.ExpiresLabel == "" {
		t.Fatalf("plan expiry was not normalized: %#v", plan)
	}
}

func TestParseDevinSeatStatusReadsSnakeCaseAndToleratesMissingReadings(t *testing.T) {
	// An account with no quota reading at all still has the two windows: the
	// limits exist, the numbers just did not arrive, and the card has to be able
	// to say that instead of showing nothing.
	raw := []byte(`{"user_status": {"plan_status": {}}}`)
	plan, windows, err := ParseDevinSeatStatus(raw, 1_700_000_000_000)
	if err != nil {
		t.Fatal(err)
	}
	if plan != nil {
		t.Fatalf("plan = %#v, want nil when nothing describes one", plan)
	}
	if len(windows) != 2 {
		t.Fatalf("windows = %d, want 2", len(windows))
	}
	for _, window := range windows {
		if window.RemainingPercent != nil || window.ResetAtMS != nil {
			t.Fatalf("window %s invented a reading: %#v", window.ID, window)
		}
	}
}

func TestParseDevinSeatStatusRejectsOutOfRangeShares(t *testing.T) {
	// Devin has never returned an out-of-range share, so one means the field is
	// not what it is believed to be. Showing "0% remaining" for it would be a
	// fabricated exhaustion the operator would act on.
	raw := []byte(`{"userStatus":{"planStatus":{"dailyQuotaRemainingPercent":-5,"weeklyQuotaRemainingPercent":250}}}`)
	_, windows, err := ParseDevinSeatStatus(raw, 1_700_000_000_000)
	if err != nil {
		t.Fatal(err)
	}
	for _, window := range windows {
		if window.RemainingPercent != nil {
			t.Fatalf("window %s accepted an out-of-range share: %v", window.ID, *window.RemainingPercent)
		}
	}
}

func TestParseDevinSeatStatusRejectsAMisleadingResetEncoding(t *testing.T) {
	// A date string in a field that means unix seconds would be read as a number
	// three orders of magnitude off, producing a reset time that never happens.
	raw := []byte(`{"userStatus":{"planStatus":{"dailyQuotaResetAtUnix":"2024-01-05T00:00:00Z"}}}`)
	_, windows, err := ParseDevinSeatStatus(raw, 1_700_000_000_000)
	if err != nil {
		t.Fatal(err)
	}
	if windows[0].ResetAtMS != nil {
		t.Fatalf("daily reset = %v, want none for a non-numeric encoding", windows[0].ResetAtMS)
	}
}

func TestParseDevinSeatStatusReportsMissingStructure(t *testing.T) {
	for name, raw := range map[string]string{
		"no user status": `{}`,
		"no plan status": `{"userStatus":{}}`,
		"not json":       `not-json`,
	} {
		if _, _, err := ParseDevinSeatStatus([]byte(raw), 1_700_000_000_000); err == nil {
			t.Fatalf("%s: expected an error", name)
		}
	}
}

func TestDevinQuotaTargetIsAllowlisted(t *testing.T) {
	if !IsAllowedQuotaURL(DevinSeatStatusURL) {
		t.Fatalf("Devin seat status URL must be in the quota allowlist: %s", DevinSeatStatusURL)
	}
	// The allowlist is a prefix match, so a lookalike host must not slip through.
	if IsAllowedQuotaURL("https://server.codeium.com.attacker.test/exa.seat_management_pb.SeatManagementService/GetUserStatus") {
		t.Fatal("a lookalike host must not be allowlisted")
	}
}

func TestDetectProviderRecognizesDevin(t *testing.T) {
	for _, tc := range []struct{ fileType, provider string }{
		{"devin", ""},
		{"", "devin"},
		{"Devin", "Devin"},
	} {
		if got := DetectProvider(tc.fileType, tc.provider); got != "devin" {
			t.Fatalf("DetectProvider(%q, %q) = %q, want devin", tc.fileType, tc.provider, got)
		}
	}
	if caps := CapabilitiesForProvider("devin"); !caps.RefreshSupported || caps.ResetCreditSupported {
		t.Fatalf("unexpected devin capabilities: %#v", caps)
	}
}

// fetchDevinQuota is exercised through the service so the request CPA receives is
// asserted, not just the payload builder.
func TestFetchDevinQuotaSendsTheSeatStatusRequest(t *testing.T) {
	var received management.ApiCallRequest
	client := &mockCPAClient{
		apiCallFunc: func(_ context.Context, req management.ApiCallRequest) (management.ApiCallResponse, error) {
			received = req
			return management.ApiCallResponse{
				StatusCode: 200,
				Body:       []byte(`{"userStatus":{"planStatus":{"dailyQuotaRemainingPercent":80,"weeklyQuotaRemainingPercent":50}}}`),
			}, nil
		},
	}
	service := NewService(client)

	plan, windows, err := service.fetchDevinQuota(context.Background(), management.AuthFile{AuthIndex: "devin-1"}, 1_700_000_000_000)
	if err != nil {
		t.Fatal(err)
	}
	if plan != nil {
		t.Fatalf("plan = %#v, want nil when Devin names none", plan)
	}
	if len(windows) != 2 {
		t.Fatalf("windows = %d, want 2", len(windows))
	}
	if received.URL != DevinSeatStatusURL || received.Method != "POST" {
		t.Fatalf("unexpected request: %s %s", received.Method, received.URL)
	}
	if received.AuthIndex != "devin-1" {
		t.Fatalf("auth index = %q", received.AuthIndex)
	}
	if !strings.Contains(received.Data, "$TOKEN$") {
		t.Fatalf("request body must carry the CPA credential marker: %s", received.Data)
	}
	if received.Header["Connect-Protocol-Version"] == "" {
		t.Fatalf("Connect-RPC version header missing: %#v", received.Header)
	}
}

func TestFetchDevinQuotaSurfacesUpstreamFailures(t *testing.T) {
	client := &mockCPAClient{
		apiCallFunc: func(_ context.Context, _ management.ApiCallRequest) (management.ApiCallResponse, error) {
			return management.ApiCallResponse{StatusCode: 401, Body: []byte(`{"message":"invalid credentials"}`)}, nil
		},
	}
	service := NewService(client)
	if _, _, err := service.fetchDevinQuota(context.Background(), management.AuthFile{AuthIndex: "devin-1"}, 0); err == nil {
		t.Fatal("expected an error for a non-2xx seat status response")
	}
}
