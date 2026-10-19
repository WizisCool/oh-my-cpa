package operations

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func TestScalarIntegersRejectTruncation(t *testing.T) {
	for _, value := range []float64{1.5, -1, math.NaN(), math.Inf(1), 1e30} {
		if _, err := ValidateScalarValue("request_retry", value); err == nil {
			t.Fatalf("accepted %v", value)
		}
	}
}
func TestRoutingStrategyAcceptsOnlyWhatCPARuns(t *testing.T) {
	for input, want := range map[string]string{"round-robin": "round-robin", "WRR": "weighted-round-robin", "fill-first": "fill-first", " ff ": "fill-first"} {
		got, err := ValidateScalarValue("routing_strategy", input)
		if err != nil || got != want {
			t.Fatalf("%q: got %v %v, want %q", input, got, err, want)
		}
	}
	for _, input := range []string{"least-load", "random", ""} {
		if _, err := ValidateScalarValue("routing_strategy", input); err == nil {
			t.Fatalf("accepted %q, which CPA does not run", input)
		}
	}
}
func TestAnalysisUsesFixedHalfOpenWindow(t *testing.T) {
	ctx := capability.WithAnchor(context.Background(), 1000000000)
	first, err := (UsageInput{}).filter(ctx)
	if err != nil {
		t.Fatal(err)
	}
	second, err := (UsageInput{}).filter(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if first.ToMS != 999999999 || first.ToMS != second.ToMS {
		t.Fatal("analysis drifted")
	}
	boundary, err := (UsageInput{FromMS: 100, ToMS: 101}).filter(ctx)
	if err != nil || boundary.ToMS != 100 {
		t.Fatalf("millisecond window %+v %v", boundary, err)
	}
	if _, err = (UsageInput{FromMS: 200, ToMS: 100}).filter(ctx); err == nil {
		t.Fatal("negative window")
	}
}
func TestUsageInputCarriesPatternAndSearchIntoTheFilter(t *testing.T) {
	ctx := capability.WithAnchor(context.Background(), 1000000000)
	filter, err := (UsageInput{Search: "codex", RegexField: "model", Regex: "^claude-", MinLatency: 5000}).filter(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if filter.Search != "codex" || filter.RegexField != "model" || filter.RegexPattern != "^claude-" ||
		filter.MinLatencyMS == nil || *filter.MinLatencyMS != 5000 {
		t.Fatalf("filter = %+v", filter)
	}
	for name, input := range map[string]UsageInput{
		"pattern without a field": {Regex: "x"},
		"unknown field":           {RegexField: "client_ip", Regex: "x"},
		"not RE2":                 {RegexField: "model", Regex: "(?<=a)b"},
	} {
		if _, err := input.filter(ctx); err == nil || !strings.HasPrefix(err.Error(), "invalid_regex: ") {
			t.Fatalf("%s: want invalid_regex, got %v", name, err)
		}
	}
	if _, err := (UsageInput{MinLatency: -1}).filter(ctx); err == nil {
		t.Fatal("a negative latency bound was accepted")
	}
}
func TestProviderEndpointCannotCarryCredentials(t *testing.T) {
	name := "test"
	for _, address := range []string{"file:///etc/passwd", "https://user:pass@example.org", "https://example.org?api_key=secret", "//example.org"} {
		input := ProviderMutation{Name: &name, BaseURL: &address}
		if input.Validate(true) == nil {
			t.Fatalf("accepted %s", address)
		}
	}
}

func TestOAuthModelAliasCapabilityUsesSharedNormalizationAndRevision(t *testing.T) {
	registry := capability.NewRegistry()
	aliases := map[string][]OAuthModelAlias{}
	revision := "r1"
	service := &Service{
		OAuthModelAliases: func(context.Context) (map[string][]OAuthModelAlias, string, error) { return aliases, revision, nil },
		NormalizeOAuthModelAliases: func(provider string, entries []OAuthModelAlias) (string, []OAuthModelAlias, error) {
			if provider == "unknown provider" {
				return "", nil, errors.New("invalid_parameters")
			}
			return provider, entries, nil
		},
		SetOAuthModelAliases: func(_ context.Context, provider string, entries []OAuthModelAlias, expected string) error {
			if expected != revision {
				return errors.New("resource_conflict")
			}
			aliases = map[string][]OAuthModelAlias{provider: entries}
			revision = "r2"
			return nil
		},
	}
	if err := service.registerOAuth(registry); err != nil {
		t.Fatal(err)
	}
	definition, err := registry.Lookup("oauth_set_model_aliases", capability.Principal{Adapter: "agent", IsAdmin: true})
	if err != nil || definition.Permission != "write" || definition.Risk != "high" || definition.Prepare == nil {
		t.Fatalf("definition: %+v %v", definition, err)
	}
	arguments := json.RawMessage(`{"provider":"codex","aliases":[{"name":"gpt-5","alias":"fast"}]}`)
	preview, err := definition.Prepare(context.Background(), arguments)
	if err != nil || preview.Target != "codex" || preview.Revision != "r1" {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	if _, err := definition.Execute(context.Background(), arguments, "stale", ""); err == nil || err.Error() != "resource_conflict" {
		t.Fatalf("stale revision accepted: %v", err)
	}
	if _, err := definition.Execute(context.Background(), arguments, preview.Revision, ""); err != nil {
		t.Fatal(err)
	}
	if len(aliases["codex"]) != 1 || aliases["codex"][0].Alias != "fast" {
		t.Fatalf("aliases: %+v", aliases)
	}
}

func TestOAuthExcludedModelsCapabilityIsConfirmedAndRevisioned(t *testing.T) {
	registry := capability.NewRegistry()
	excluded := map[string][]string{"codex": {"gpt-5-mini"}}
	revision := "r1"
	service := &Service{
		OAuthExcludedModels: func(context.Context) (map[string][]string, string, error) {
			return excluded, revision, nil
		},
		NormalizeOAuthExclusions: func(provider string, rules []string) (string, []string, error) {
			if provider == "" {
				return "", nil, errors.New("invalid")
			}
			return provider, rules, nil
		},
		SetOAuthExcludedModels: func(_ context.Context, provider string, rules []string, expected string) error {
			if expected != revision {
				return errors.New("resource_conflict")
			}
			excluded = map[string][]string{provider: rules}
			revision = "r2"
			return nil
		},
	}
	if err := service.registerOAuth(registry); err != nil {
		t.Fatal(err)
	}
	principal := capability.Principal{Adapter: "agent", IsAdmin: true}
	if definition, err := registry.Lookup("oauth_excluded_models_list", principal); err != nil || definition.Permission != "read" {
		t.Fatalf("list definition: %+v %v", definition, err)
	}
	definition, err := registry.Lookup("oauth_set_excluded_models", principal)
	if err != nil || definition.Permission != "write" || definition.Risk != "high" || definition.Prepare == nil {
		t.Fatalf("definition: %+v %v", definition, err)
	}
	arguments := json.RawMessage(`{"provider":"codex","models":["gpt-5-*"]}`)
	preview, err := definition.Prepare(context.Background(), arguments)
	if err != nil || preview.Target != "codex" || preview.Revision != "r1" {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	if _, err := definition.Prepare(context.Background(), json.RawMessage(`{"provider":"","models":[]}`)); err == nil || err.Error() != "invalid_parameters" {
		t.Fatalf("invalid provider accepted: %v", err)
	}
	if _, err := definition.Execute(context.Background(), arguments, "stale", ""); err == nil || err.Error() != "resource_conflict" {
		t.Fatalf("stale revision accepted: %v", err)
	}
	if _, err := definition.Execute(context.Background(), arguments, preview.Revision, ""); err != nil {
		t.Fatal(err)
	}
	if len(excluded["codex"]) != 1 || excluded["codex"][0] != "gpt-5-*" {
		t.Fatalf("excluded: %+v", excluded)
	}
}

func TestOAuthExclusionCapabilityGuidanceExplainsCredentialPrecedence(t *testing.T) {
	registry := capability.NewRegistry()
	if err := (&Service{}).registerOAuth(registry); err != nil {
		t.Fatal(err)
	}
	for _, adapter := range []string{"agent", "mcp"} {
		for _, name := range []string{"oauth_excluded_models_list", "oauth_set_excluded_models", "oauth_set_credential_fields"} {
			definition, err := registry.Lookup(name, capability.Principal{Adapter: adapter, IsAdmin: true})
			if err != nil {
				t.Fatal(err)
			}
			guidance := []string{"non-empty", "replaces", "missing, empty or null list inherits the current provider rules", "CPA v8.0.33 or later", "upgrade older gateways before relying on", "CPA determines availability"}
			if name == "oauth_set_credential_fields" {
				guidance = append(guidance, "replaces provider exclusions, including *", "clearing restores inheritance")
			} else {
				guidance = append(guidance, "* blocks all models only for inheriting credentials")
				if name == "oauth_set_excluded_models" {
					guidance = append(guidance, "leaving non-empty credential overrides unchanged", "Clearing a credential list restores inheritance, not unrestricted access")
				}
			}
			for _, fragment := range guidance {
				if !strings.Contains(definition.Description, fragment) {
					t.Errorf("%s/%s omits %q from guidance: %s", adapter, name, fragment, definition.Description)
				}
			}
		}
	}
}

func TestAgentCredentialFieldsRefuseSecretBearingKeys(t *testing.T) {
	registry := capability.NewRegistry()
	service := &Service{NormalizeCredentialFields: func(fields map[string]any) (map[string]any, error) { return fields, nil }}
	if err := service.registerOAuth(registry); err != nil {
		t.Fatal(err)
	}
	definition, err := registry.Lookup("oauth_set_credential_fields", capability.Principal{ID: "administrator", Adapter: "agent", IsAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		`{"name":"a.json","auth_index":"0","fields":{"headers":{"Authorization":"Bearer secret-value"}}}`,
		`{"name":"a.json","auth_index":"0","fields":{"proxy_url":"http://user:pass@example.org"}}`,
		`{"name":"a.json","auth_index":"0","fields":{}}`,
	} {
		if _, err := definition.Prepare(context.Background(), json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	if _, err := service.normalizeAgentCredentialFields(map[string]any{"priority": 3, "note": "primary"}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.normalizeAgentCredentialFields(map[string]any{"headers": map[string]any{"Authorization": "Bearer secret-value"}}); err == nil {
		t.Fatal("headers reached the agent-facing allowlist")
	}
}

func TestAgentVertexOpenAPIFieldsPreviewOnlyForVertexServiceAccounts(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/v8/management"+management.MANAGEMENT_V8_PROBE_ENDPOINT {
			_, _ = writer.Write([]byte("8"))
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"files":[{"name":"vertex.json","auth_index":"v","provider":"vertex","type":"vertex"},{"name":"codex.json","auth_index":"c","provider":"codex","type":"codex"}]}`))
	}))
	defer server.Close()
	client, err := management.NewClient(server.URL, "management-key", 5*time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	service := &Service{
		Client:                    func(context.Context) (*management.Client, error) { return client, nil },
		NormalizeCredentialFields: func(fields map[string]any) (map[string]any, error) { return fields, nil },
	}
	registry := capability.NewRegistry()
	if err := service.registerOAuth(registry); err != nil {
		t.Fatal(err)
	}
	definition, err := registry.Lookup("oauth_set_credential_fields", capability.Principal{ID: "administrator", Adapter: "agent", IsAdmin: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := definition.Prepare(context.Background(), json.RawMessage(`{"name":"vertex.json","auth_index":"v","fields":{"openapi":true,"openapi_location":"global","openapi_models":["meta/llama-3.3-70b-instruct-maas"]}}`)); err != nil {
		t.Fatalf("vertex overrides refused: %v", err)
	}
	if _, err := definition.Prepare(context.Background(), json.RawMessage(`{"name":"codex.json","auth_index":"c","fields":{"openapi":true}}`)); err == nil || !strings.Contains(err.Error(), "invalid_parameters") {
		t.Fatalf("codex override preview = %v, want invalid_parameters", err)
	}
}
