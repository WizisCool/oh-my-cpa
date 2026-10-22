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
