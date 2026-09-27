package configyaml

import (
	"reflect"
	"strings"
	"testing"
)

// A v7 document in the shape CPA v7.3.20's config.example.yaml produces.
const legacyDocument = `host: ""
port: 8317
remote-management:
  allow-remote: false
  secret-key: ""
auth-dir: "~/.cli-proxy-api"
api-keys:
  - "client-key-alpha"
debug: false
request-retry: 3
payload:
  default: []
quota-exceeded:
  switch-project: true
  antigravity-credits: true
routing:
  strategy: round-robin
codex-api-key:
  - api-key: "sk-upstream"
    base-url: "https://codex.example.com/v1"
`

// The same settings after CPA v8.0.2 migrated them on a v8 write.
const v8Document = `config-version: 8
server:
  host: ""
  port: 8317
management:
  allow-remote: false
  secret-key: ""
access:
  api-keys:
    - "client-key-alpha"
routing:
  strategy: round-robin
  retry:
    request-retry: 3
requests:
  payload:
    default: []
oauth:
  auth-dir: "~/.cli-proxy-api"
  providers:
    antigravity:
      antigravity-credits: true
observability:
  logs:
    debug: false
quota-exceeded:
  switch-project: true
api-keys:
  codex:
    - name: codex-1
      base-url: "https://codex.example.com/v1"
      keys:
        - api-key: "sk-upstream"
`

func TestDetectLayout(t *testing.T) {
	cases := []struct {
		name          string
		document      string
		wantLayout    ConfigLayout
		wantProviders bool
	}{
		{"empty document is legacy", "", LayoutLegacy, false},
		{"v7 document", legacyDocument, LayoutLegacy, false},
		{"migrated v8 document", v8Document, LayoutV8, true},
		{"v8 section added by hand to a v7 document", legacyDocument + "observability:\n  logs:\n    debug: true\n", LayoutMixed, false},
		{"legacy key appended to a v8 document", v8Document + "debug: true\n", LayoutMixed, true},
		{"routing.retry alone marks v8", "routing:\n  retry:\n    request-retry: 1\n", LayoutV8, false},
		{"shared sections alone stay legacy", "routing:\n  strategy: fill-first\nplugins:\n  enabled: true\n", LayoutLegacy, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			report, err := DetectLayout(tc.document)
			if err != nil {
				t.Fatalf("DetectLayout: %v", err)
			}
			if report.Layout != tc.wantLayout || report.HasProviderGroups != tc.wantProviders {
				t.Fatalf("got %+v, want layout %s providers %v", report, tc.wantLayout, tc.wantProviders)
			}
		})
	}
	if _, err := DetectLayout("- a\n- b\n"); err == nil {
		t.Fatal("a non-mapping document must be reported")
	}
}

func TestRewriteToV8(t *testing.T) {
	cases := map[string]string{
		"host":                                "server.host",
		"tls.key":                             "server.tls.key",
		"remote-management.secret-key":        "management.secret-key",
		"api-keys":                            "access.api-keys",
		"request-retry":                       "routing.retry.request-retry",
		"disable-cooling":                     "routing.cooldown.disable-cooling",
		"force-model-prefix":                  "routing.force-model-prefix",
		"debug":                               "observability.logs.debug",
		"usage-statistics-enabled":            "observability.usage.usage-statistics-enabled",
		"proxy-url":                           "requests.proxy-url",
		"passthrough-headers":                 "requests.passthrough-headers",
		"nonstream-keepalive-interval":        "requests.nonstream-keepalive-interval",
		"streaming.keepalive-seconds":         "requests.streaming.keepalive-seconds",
		"payload":                             "requests.payload",
		"payload.override-raw":                "requests.payload.override-raw",
		"commercial-mode":                     "server.commercial-mode",
		"auth-dir":                            "oauth.auth-dir",
		"auth-auto-refresh-workers":           "oauth.auth-auto-refresh-workers",
		"ws-auth":                             "oauth.providers.aistudio.ws-auth",
		"codex.disable-codex-cloaking":        "oauth.providers.codex.disable-codex-cloaking",
		"codex-header-defaults.user-agent":    "oauth.providers.codex.header-defaults.user-agent",
		"claude-header-defaults.os":           "oauth.providers.claude.header-defaults.os",
		"quota-exceeded.antigravity-credits":  "oauth.providers.antigravity.antigravity-credits",
		"antigravity-signature-cache-enabled": "oauth.providers.antigravity.signature-cache-enabled",
		"disable-image-generation":            "multimedia.disable-image-generation",
	}
	for legacy, want := range cases {
		got, moved := RewriteToV8(strings.Split(legacy, "."))
		if !moved || strings.Join(got, ".") != want {
			t.Errorf("RewriteToV8(%s) = %v (%v), want %s", legacy, got, moved, want)
		}
	}
	// These keep their spelling in both layouts; the switches below have no v8
	// counterpart at all and stay legacy-only.
	for _, shared := range []string{"routing.strategy", "routing.session-affinity", "plugins.enabled", "quota-exceeded.switch-project", "quota-exceeded.switch-preview-model"} {
		got, moved := RewriteToV8(strings.Split(shared, "."))
		if moved || strings.Join(got, ".") != shared {
			t.Errorf("RewriteToV8(%s) = %v (%v), want unchanged", shared, got, moved)
		}
	}
}

func TestLayoutRulesAreConsistent(t *testing.T) {
	seen := map[string]bool{}
	allowedRoots := map[string]bool{"routing": true}
	for _, section := range V8_ONLY_SECTIONS {
		allowedRoots[section] = true
	}
	for _, rule := range LayoutRules() {
		if seen[rule.Legacy] {
			t.Errorf("duplicate legacy path %s", rule.Legacy)
		}
		seen[rule.Legacy] = true
		root, _, _ := strings.Cut(rule.Current, ".")
		if !allowedRoots[root] {
			t.Errorf("%s moves to %s, outside the v8 sections", rule.Legacy, rule.Current)
		}
	}
	for _, family := range PROVIDER_KEY_FAMILY_RULES {
		if !strings.HasPrefix(family.Current, "api-keys.") {
			t.Errorf("provider family %s must move under api-keys, got %s", family.Legacy, family.Current)
		}
	}
}

func TestShadowedLegacyPaths(t *testing.T) {
	if shadowed, err := ShadowedLegacyPaths(legacyDocument); err != nil || len(shadowed) != 0 {
		t.Fatalf("a v7 document shadows nothing, got %v %v", shadowed, err)
	}
	if shadowed, err := ShadowedLegacyPaths(v8Document); err != nil || len(shadowed) != 0 {
		t.Fatalf("a clean v8 document shadows nothing, got %v %v", shadowed, err)
	}

	// What a layout-unaware editor produces when it writes legacy keys into the
	// migrated document: every one of these is discarded by CPA v8.
	edited := v8Document + "debug: true\nrequest-retry: 9\npayload:\n  filter: []\ncodex-api-key:\n  - api-key: other\n"
	shadowed, err := ShadowedLegacyPaths(edited)
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, rule := range shadowed {
		got = append(got, rule.Legacy)
	}
	want := []string{"codex-api-key", "debug", "request-retry"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("shadowed = %v, want %v", got, want)
	}

	// A legacy leaf whose v8 leaf is absent is still honoured by CPA, even when
	// its v8 section exists: precedence is per leaf, not per section.
	partial := v8Document + "logging-to-file: true\n"
	if shadowed, _ := ShadowedLegacyPaths(partial); len(shadowed) != 0 {
		t.Fatalf("logging-to-file has no v8 twin here and must not be reported: %v", shadowed)
	}

	// The root api-keys mapping is the v8 provider groups, never a legacy
	// client-key list, so it cannot shadow access.api-keys.
	for _, rule := range shadowed {
		if rule.Legacy == "api-keys" {
			t.Fatal("provider groups must not be read as a legacy client-key list")
		}
	}
	listAndAccess := "access:\n  api-keys: [a]\napi-keys: [b]\n"
	if shadowed, _ := ShadowedLegacyPaths(listAndAccess); len(shadowed) != 1 || shadowed[0].Current != "access.api-keys" {
		t.Fatalf("a legacy client-key list beside access.api-keys is shadowed, got %v", shadowed)
	}
}

func TestReplacesProviderGroups(t *testing.T) {
	withList := strings.Replace(v8Document, "api-keys:\n  codex:\n    - name: codex-1\n      base-url: \"https://codex.example.com/v1\"\n      keys:\n        - api-key: \"sk-upstream\"\n", "api-keys:\n  - \"legacy-client-key\"\n", 1)
	if withList == v8Document {
		t.Fatal("fixture replacement did not apply")
	}
	cases := []struct {
		name      string
		stored    string
		submitted string
		want      bool
	}{
		{"v8 groups replaced by a client-key list", v8Document, withList, true},
		{"v8 groups kept", v8Document, v8Document + "# comment\n", false},
		{"v8 groups removed entirely is an explicit deletion", v8Document, "config-version: 8\n", false},
		{"legacy list edited in a legacy document", legacyDocument, legacyDocument + "debug: true\n", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ReplacesProviderGroups(tc.stored, tc.submitted)
			if err != nil || got != tc.want {
				t.Fatalf("got %v %v, want %v", got, err, tc.want)
			}
		})
	}
}

// The safe view masks by path suffix, so the v8 spellings of the management key
// and the TLS private key are hidden the same way their legacy spellings are,
// and a save restores them from the stored document.
func TestSanitizeMasksV8SecretLocations(t *testing.T) {
	stored := "management:\n  secret-key: \"mgmt-secret\"\nserver:\n  tls:\n    key: \"/etc/tls/private.pem\"\n"
	safe, err := SanitizeSafeYAML(stored)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(safe, "mgmt-secret") || strings.Contains(safe, "private.pem") {
		t.Fatalf("v8 secret locations leaked into the safe view:\n%s", safe)
	}
	restored, err := RestoreSentinels(safe, stored)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(restored, "mgmt-secret") || !strings.Contains(restored, "private.pem") {
		t.Fatalf("a save must restore the hidden v8 values:\n%s", restored)
	}
}
