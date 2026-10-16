package quota

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func pluginTestItems() []management.PluginItem {
	return []management.PluginItem{
		{ID: "fixture-limiter", Registered: true, Enabled: true, SupportsQuota: true, QuotaProvider: "codebuddy"},
		{ID: "fixture-meter", Registered: true, Enabled: true, SupportsQuota: true, QuotaProvider: "metered"},
		{ID: "fixture-logger", Registered: true, Enabled: true},
	}
}

// Built-ins win even when a plugin also advertises quota for the same provider:
// a Codex credential carrying CPA's quota advertisement stays on its reader.
func TestIsPluginQuotaFilePrefersBuiltIn(t *testing.T) {
	builtIn := management.AuthFile{Type: "codex", Provider: "codex", SupportsQuota: true, QuotaProvider: "codex"}
	if isPluginQuotaFile(builtIn) {
		t.Fatal("isPluginQuotaFile(codex) = true, want false")
	}
	plugin := management.AuthFile{Type: "codebuddy", Provider: "codebuddy", SupportsQuota: true, QuotaProvider: "codebuddy"}
	if !isPluginQuotaFile(plugin) {
		t.Fatal("isPluginQuotaFile(codebuddy) = false, want true")
	}
	plain := management.AuthFile{Type: "codebuddy", Provider: "codebuddy"}
	if isPluginQuotaFile(plain) {
		t.Fatal("isPluginQuotaFile without advertisement = true, want false")
	}
	probe := management.AuthFile{Type: "codebuddy", QuotaProbe: json.RawMessage(`{"kind":"declarative"}`)}
	if !isPluginQuotaFile(probe) {
		t.Fatal("isPluginQuotaFile(probe) = false, want true")
	}
}

func TestResolvePluginQuotaID(t *testing.T) {
	plugins := pluginTestItems()

	for _, testCase := range []struct {
		name     string
		provider string
		plugins  []management.PluginItem
		want     string
		wantErr  bool
	}{
		{name: "quota provider", provider: "codebuddy", plugins: plugins, want: "fixture-limiter"},
		{name: "plugin id", provider: "fixture-limiter", plugins: plugins, want: "fixture-limiter"},
		{name: "case insensitive", provider: "CodeBuddy", plugins: plugins, want: "fixture-limiter"},
		{
			name:     "oauth provider",
			provider: "codebuddy-oauth",
			plugins:  []management.PluginItem{{ID: "fixture-oauth", Registered: true, SupportsQuota: true, OAuthProvider: "codebuddy-oauth"}},
			want:     "fixture-oauth",
		},
		{
			name:     "unmatched single candidate refused",
			provider: "something-else",
			plugins:  []management.PluginItem{{ID: "only-one", Registered: true, SupportsQuota: true, QuotaProvider: "other"}},
			wantErr:  true,
		},
		{name: "empty provider", provider: "", plugins: plugins, wantErr: true},
		{name: "no match", provider: "unknown-provider", plugins: plugins, wantErr: true},
		{name: "unregistered ignored", provider: "ghost", plugins: []management.PluginItem{{ID: "ghost", SupportsQuota: true, QuotaProvider: "ghost"}}, wantErr: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := resolvePluginQuotaID(testCase.plugins, testCase.provider)
			if testCase.wantErr && err == nil {
				t.Fatalf("resolvePluginQuotaID(%q) succeeded, want an error", testCase.provider)
			}
			if !testCase.wantErr && (err != nil || got != testCase.want) {
				t.Fatalf("resolvePluginQuotaID(%q) = %q, %v; want %q", testCase.provider, got, err, testCase.want)
			}
		})
	}
}

// Declarative quota_probe credentials have no v8 management route: the failure
// names the gap instead of fetching against the wrong endpoint.
func TestPluginQuotaTargetRefusesDeclarativeProbe(t *testing.T) {
	svc := NewService(&mockCPAClient{})
	_, err := svc.pluginQuotaTarget(context.Background(), management.AuthFile{
		AuthIndex:  "auth-probe",
		Type:       "codebuddy",
		QuotaProbe: json.RawMessage(`{"kind":"declarative"}`),
	})
	if err == nil || !strings.Contains(err.Error(), "quota probe") {
		t.Fatalf("pluginQuotaTarget(probe) = %v, want the probe-unsupported error", err)
	}
}

// CPA's quota_plugin_id is the plugin it actually routes quota to. A name match
// would pick fixture-limiter here, which CPA may have fused; the target follows
// CPA without listing plugins at all.
func TestPluginQuotaTargetPrefersCPASelection(t *testing.T) {
	svc := NewService(&mockCPAClient{pluginsFunc: func(context.Context) ([]management.PluginItem, error) {
		t.Fatal("plugins listed although CPA named the quota plugin")
		return nil, nil
	}})
	got, err := svc.pluginQuotaTarget(context.Background(), management.AuthFile{
		AuthIndex:     "auth-selected",
		Type:          "codebuddy",
		SupportsQuota: true,
		QuotaProvider: "codebuddy",
		QuotaPluginID: "fixture-healthy",
	})
	if err != nil || got != "fixture-healthy" {
		t.Fatalf("pluginQuotaTarget = %q, %v; want fixture-healthy", got, err)
	}
}

const pluginQuotaFixture = `{
	"groups": [{
		"displayName": "Code models",
		"buckets": [{"bucketId": "5h", "displayName": "5 hour", "window": "5h", "remainingFraction": 0.4}]
	}],
	"subscription": {"plan": "Team", "tierName": "team-tier", "tierId": "team"}
}`

// A full refresh through the plugin branch projects groups onto windows and the
// subscription onto a plan, and advertises refresh support.
func TestRefreshCredentialQuotaPluginBranch(t *testing.T) {
	var calledPlugin, calledIndex string
	client := &mockCPAClient{
		pluginsFunc: func(ctx context.Context) ([]management.PluginItem, error) {
			return pluginTestItems(), nil
		},
		pluginQuotaFn: func(ctx context.Context, pluginID, authIndex string) (json.RawMessage, error) {
			calledPlugin, calledIndex = pluginID, authIndex
			return json.RawMessage(pluginQuotaFixture), nil
		},
	}

	result, err := NewService(client).RefreshCredentialQuota(context.Background(), management.AuthFile{
		AuthIndex:     "auth-plugin-1",
		Name:          "codebuddy.json",
		Type:          "codebuddy",
		Provider:      "codebuddy",
		SupportsQuota: true,
		QuotaProvider: "codebuddy",
	}, nil)
	if err != nil {
		t.Fatalf("RefreshCredentialQuota error: %v", err)
	}
	if calledPlugin != "fixture-limiter" || calledIndex != "auth-plugin-1" {
		t.Fatalf("fetch = (%q, %q), want (fixture-limiter, auth-plugin-1)", calledPlugin, calledIndex)
	}
	if !result.Capabilities.RefreshSupported || result.Capabilities.ResetCreditSupported {
		t.Fatalf("capabilities = %+v, want refresh without reset credit", result.Capabilities)
	}
	if len(result.Windows) != 1 || result.Windows[0].UsedPercent == nil || *result.Windows[0].UsedPercent != 60 {
		t.Fatalf("windows = %+v, want one window at 60%% used", result.Windows)
	}
	if result.Plan == nil || result.Plan.PlanLabel != "Team" {
		t.Fatalf("plan = %+v, want the Team label", result.Plan)
	}
	if result.Status != "healthy" && result.Status != "warning" {
		t.Fatalf("status = %q, want a successful reading", result.Status)
	}
}

// An unresolvable plugin reads as an error, never as an empty success.
func TestRefreshCredentialQuotaPluginUnresolvable(t *testing.T) {
	client := &mockCPAClient{
		pluginsFunc: func(ctx context.Context) ([]management.PluginItem, error) {
			return nil, nil
		},
	}
	result, err := NewService(client).RefreshCredentialQuota(context.Background(), management.AuthFile{
		AuthIndex:     "auth-plugin-9",
		Type:          "codebuddy",
		SupportsQuota: true,
		QuotaProvider: "codebuddy",
	}, nil)
	if err != nil {
		t.Fatalf("RefreshCredentialQuota error: %v", err)
	}
	if result.Status != "error" || result.Error == "" {
		t.Fatalf("result = %+v, want an error reading", result)
	}
}

func TestCapabilitiesForFileFollowsTheQuotaReader(t *testing.T) {
	plugin := management.AuthFile{Type: "codebuddy", Provider: "codebuddy", SupportsQuota: true, QuotaProvider: "codebuddy"}
	if caps := CapabilitiesForFile(plugin); !caps.RefreshSupported {
		t.Fatalf("plugin capabilities = %+v, want refresh supported", caps)
	}
	builtIn := management.AuthFile{Type: "codex", Provider: "codex"}
	if caps := CapabilitiesForFile(builtIn); !caps.RefreshSupported || !caps.ResetCreditSupported {
		t.Fatalf("codex capabilities = %+v, want refresh and reset credit", caps)
	}
	plain := management.AuthFile{Type: "codebuddy", Provider: "codebuddy"}
	if caps := CapabilitiesForFile(plain); caps.RefreshSupported {
		t.Fatalf("unadvertised capabilities = %+v, want no refresh", caps)
	}
}

func TestRefreshCredentialQuotaRejectsUnrelatedPlugin(t *testing.T) {
	hasCalledQuotaPlugin := false
	client := &mockCPAClient{
		pluginsFunc: func(ctx context.Context) ([]management.PluginItem, error) {
			return []management.PluginItem{{ID: "unrelated", Registered: true, SupportsQuota: true, QuotaProvider: "other"}}, nil
		},
		pluginQuotaFn: func(ctx context.Context, pluginID, authIndex string) (json.RawMessage, error) {
			hasCalledQuotaPlugin = true
			return json.RawMessage(pluginQuotaFixture), nil
		},
	}
	result, err := NewService(client).RefreshCredentialQuota(context.Background(), management.AuthFile{
		AuthIndex: "auth-plugin-unmatched", Type: "codebuddy", SupportsQuota: true, QuotaProvider: "codebuddy",
	}, nil)
	if err != nil {
		t.Fatalf("RefreshCredentialQuota error: %v", err)
	}
	if hasCalledQuotaPlugin {
		t.Fatal("unrelated plugin received the credential auth index")
	}
	if result.Status != "error" || result.Error == "" || len(result.Windows) != 0 || result.Plan != nil {
		t.Fatalf("result = %+v, want an error without unrelated windows or plan", result)
	}
}
