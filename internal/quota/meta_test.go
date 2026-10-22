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
