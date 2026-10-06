package quota

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

type metaQuotaClient struct {
	mockCPAClient
	download func(context.Context, string) ([]byte, management.ResponseMeta, error)
}

func (client *metaQuotaClient) DownloadAuthFile(ctx context.Context, name string) ([]byte, management.ResponseMeta, error) {
	return client.download(ctx, name)
}

func TestParseMetaQuotaProjectsOnlyQuotaFields(t *testing.T) {
	raw := []byte(`{"api_key":"synthetic-llm-key","email":"private@example.invalid","subs_tier_name":"Muse Pro","is_subs_active":false,"subs_usage":{"tier":"ignored","window":{"used_percent":"25","window_duration_mins":300,"resets_at":1800000000},"weekly":{"used_percent":80,"resets_at":1800100000}}}`)
	plan, windows, err := ParseMetaUsage(raw, 1700000000000)
	if err != nil || plan == nil || plan.PlanLabel != "Muse Pro" || plan.IsSubscriptionActive == nil || *plan.IsSubscriptionActive {
		t.Fatalf("plan = %+v, err = %v", plan, err)
	}
	if len(windows) != 2 || windows[0].Kind != "" || *windows[0].UsedPercent != 25 || *windows[0].RemainingPercent != 75 || *windows[0].PeriodHours != 5 || *windows[0].ResetAtMS != 1800000000000 || *windows[1].PeriodHours != 168 {
		t.Fatalf("windows = %+v", windows)
	}
	encoded, _ := json.Marshal(struct {
		Plan    *QuotaPlan
		Windows []QuotaWindow
	}{plan, windows})
	if strings.Contains(string(encoded), "synthetic-llm-key") || strings.Contains(string(encoded), "private@example") {
		t.Fatal("raw Meta fields escaped projection")
	}
}

func TestParseMetaQuotaUnknownIsNotZero(t *testing.T) {
	for _, payload := range []string{`{}`, `{"subs_usage":null}`, `{"subs_usage":{"window":{"used_percent":"NaN","window_duration_mins":-5},"weekly":{"used_percent":null}}}`} {
		_, windows, err := ParseMetaUsage([]byte(payload), 1700000000000)
		if err != nil || len(windows) != 2 {
			t.Fatalf("unknown observation refused: %+v %v", windows, err)
		}
		for _, window := range windows {
			if window.UsedPercent != nil || window.RemainingPercent != nil {
				t.Fatalf("unknown converted to zero: %+v", window)
			}
		}
	}
	for _, payload := range []string{`null`, `[]`, `not-json`} {
		if _, _, err := ParseMetaUsage([]byte(payload), 0); err == nil {
			t.Fatalf("invalid root accepted: %s", payload)
		}
	}
}

func TestMetaQuotaUsesOnlyPersistedDcaAndRedactsFailures(t *testing.T) {
	for _, scenario := range []string{"success", "missing-dca", "invalid-token", "download-error", "request-error", "http-error", "parse-error", "runtime-only", "disabled"} {
		t.Run(scenario, func(t *testing.T) {
			downloadCount, requestCount := 0, 0
			client := &metaQuotaClient{download: func(ctx context.Context, name string) ([]byte, management.ResponseMeta, error) {
				downloadCount++
				if name != "meta-fixture.json" {
					t.Fatalf("unexpected filename: %q", name)
				}
				if scenario == "download-error" {
					return nil, management.ResponseMeta{}, errors.New("synthetic-private-key")
				}
				raw := `{"type":"meta","dca_token":"dca:quota-fixture","access_token":"LLM|synthetic-private-key"}`
				if scenario == "missing-dca" {
					raw = `{"access_token":"dca:wrong-source"}`
				}
				if scenario == "invalid-token" {
					raw = `{"dca_token":"dca:bad token"}`
				}
				return []byte(raw), management.ResponseMeta{}, nil
			}}
			client.apiCallFunc = func(ctx context.Context, request management.ApiCallRequest) (management.ApiCallResponse, error) {
				requestCount++
				if request.URL != MetaUsageURL || request.Method != "POST" || request.Data != "{}" || request.Header["Authorization"] != "Bearer dca:quota-fixture" || request.Header["x-api-version"] != "1.0.0" || request.AuthIndex != "meta-fixture" {
					t.Fatalf("unsafe Meta request: %+v", request)
				}
				if scenario == "request-error" {
					return management.ApiCallResponse{}, errors.New("Bearer dca:quota-fixture synthetic-private-key")
				}
				if scenario == "http-error" {
					return management.ApiCallResponse{StatusCode: 401, Body: json.RawMessage(`{"message":"synthetic-private-key"}`)}, nil
				}
				if scenario == "parse-error" {
					return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{"subs_tier_name":123,"api_key":"synthetic-private-key"}`)}, nil
				}
				return management.ApiCallResponse{StatusCode: 200, Body: json.RawMessage(`{"api_key":"synthetic-private-key","subs_usage":{"window":{"used_percent":10}}}`)}, nil
			}
			file := management.AuthFile{Name: "meta-fixture.json", AuthIndex: "meta-fixture", Type: "meta", RuntimeOnly: scenario == "runtime-only", Disabled: scenario == "disabled"}
			result, err := NewService(client).RefreshCredentialQuota(context.Background(), file, nil)
			if err != nil {
				t.Fatal(err)
			}
			encoded, _ := json.Marshal(result)
			for _, secret := range []string{"dca:quota-fixture", "synthetic-private-key", "wrong-source"} {
				if strings.Contains(string(encoded), secret) {
					t.Fatalf("secret leaked: %s", encoded)
				}
			}
			if scenario == "success" && (len(result.Windows) != 2 || !result.Capabilities.RefreshSupported || result.Error != "") {
				t.Fatalf("Meta observation not supported: %+v", result)
			}
			if scenario != "success" && scenario != "disabled" && result.Error == "" {
				t.Fatalf("failure reported as success: %+v", result)
			}
			if (scenario == "runtime-only" || scenario == "disabled") && downloadCount != 0 {
				t.Fatal("downloaded unavailable or disabled credential")
			}
			if (scenario == "missing-dca" || scenario == "invalid-token" || scenario == "download-error" || scenario == "runtime-only" || scenario == "disabled") && requestCount != 0 {
				t.Fatal("called Meta without verified DCA")
			}
		})
	}
}
