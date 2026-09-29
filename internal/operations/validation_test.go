package operations

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"math"
	"testing"
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
