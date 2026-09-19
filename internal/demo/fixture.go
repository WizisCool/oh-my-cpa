package demo

import (
	"fmt"
	"time"
)

// fixtureInstanceName is the CPA instance the fixture impersonates. The console
// shows it in the header, so it reads like an operator's own gateway rather than
// like a test harness.
const fixtureInstanceName = "Default CPA"

// credential describes one OAuth credential the fixture publishes. The real
// account behind such a row would be a token; here it is a description, and the
// fixture never emits anything shaped like a secret.
type credential struct {
	name        string
	authIndex   string
	kind        string
	provider    string
	label       string
	email       string
	accountType string
	plan        string
	projectID   string
	models      []string
	success     int64
	failed      int64
	priority    int
	weight      int64
	note        string
	disabled    bool
}

// credentialCatalog is deliberately recognisable: the providers a real gateway
// holds after a few months of use, each with plausible traffic behind it.
func credentialCatalog() []credential {
	return []credential{
		{
			name: "codex-team-primary.json", authIndex: "auth-codex-01", kind: "codex", provider: "codex",
			label: "Codex · team primary", email: "ops@acme-labs.example", accountType: "oauth", plan: "pro",
			models:  []string{"gpt-5-codex", "gpt-5.1-codex", "gpt-5"},
			success: 4821, failed: 63, priority: 10, weight: 5, note: "primary ChatGPT workspace seat",
		},
		{
			name: "codex-team-secondary.json", authIndex: "auth-codex-02", kind: "codex", provider: "codex",
			label: "Codex · overflow seat", email: "eng@acme-labs.example", accountType: "oauth", plan: "plus",
			models:  []string{"gpt-5-codex", "gpt-5"},
			success: 1733, failed: 28, priority: 5, weight: 3, note: "used when the primary seat cools down",
		},
		{
			name: "claude-work.json", authIndex: "auth-claude-01", kind: "claude", provider: "claude",
			label: "Claude · work", email: "ops@acme-labs.example", accountType: "oauth", plan: "max",
			models:  []string{"claude-sonnet-4-5-20250929", "claude-opus-4-1", "claude-haiku-4-5"},
			success: 2960, failed: 41, priority: 10, weight: 5, note: "drives the review and refactor workloads",
		},
		{
			name: "gemini-personal.json", authIndex: "auth-gemini-01", kind: "gemini", provider: "gemini",
			label: "Gemini · long context", email: "vision@acme-labs.example", accountType: "oauth", plan: "pro",
			models:  []string{"gemini-2.5-pro", "gemini-2.5-flash"},
			success: 1284, failed: 12, priority: 8, weight: 4, note: "repository-wide context, million-token windows",
		},
		{
			name: "kimi-coding.json", authIndex: "auth-kimi-01", kind: "kimi", provider: "kimi",
			label: "Kimi · coding plan", email: "ops@acme-labs.example", accountType: "oauth",
			models:  []string{"kimi-k2-0905"},
			success: 640, failed: 9, priority: 6, weight: 2,
		},
		{
			name: "xai-grok.json", authIndex: "auth-xai-01", kind: "xai", provider: "xai",
			label: "xAI · Grok", email: "research@acme-labs.example", accountType: "oauth",
			models:  []string{"grok-4"},
			success: 415, failed: 7, priority: 4, weight: 2,
		},
		{
			name: "antigravity-studio.json", authIndex: "auth-antigravity-01", kind: "antigravity", provider: "antigravity",
			label: "Antigravity · studio", accountType: "oauth", projectID: "acme-labs-studio",
			models:  []string{"gemini-3-pro-preview"},
			success: 288, failed: 4, priority: 4, weight: 2,
		},
		{
			name: "codex-standby.json", authIndex: "auth-codex-03", kind: "codex", provider: "codex",
			label: "Codex · standby", email: "backup@acme-labs.example", accountType: "oauth", plan: "free",
			models:  []string{"gpt-5"},
			success: 96, failed: 2, priority: 1, weight: 1, note: "kept for failover drills", disabled: true,
		},
	}
}

// compatibilityProvider is one OpenAI-compatible relay the gateway is configured
// to route through, with the credentials it holds.
type compatibilityProvider struct {
	name     string
	baseURL  string
	prefix   string
	priority int
	models   []modelRoute
	keys     []string
}

type modelRoute struct {
	name        string
	alias       string
	displayName string
}

// compatibilityCatalog covers the two shapes a real deployment mixes: a large
// first-party API and a self-hosted relay.
func compatibilityCatalog() []compatibilityProvider {
	return []compatibilityProvider{
		{
			name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", prefix: "ds", priority: 3,
			models: []modelRoute{
				{name: "deepseek-chat", displayName: "DeepSeek Chat"},
				{name: "deepseek-reasoner", displayName: "DeepSeek Reasoner"},
			},
			keys: []string{"relay-deepseek-primary", "relay-deepseek-secondary"},
		},
		{
			name: "DashScope (Qwen)", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", prefix: "qwen", priority: 2,
			models: []modelRoute{
				{name: "qwen3-max", displayName: "Qwen3 Max"},
				{name: "qwen3-coder-plus", displayName: "Qwen3 Coder Plus"},
			},
			keys: []string{"relay-dashscope-primary"},
		},
	}
}

// apiKeyFamily is one of CPA's `{family}-api-key` credential lists.
type apiKeyFamily struct {
	family string
	keys   []familyKey
}

type familyKey struct {
	apiKey    string
	authIndex string
	baseURL   string
	models    []modelRoute
	priority  int
	weight    int
}

// familyCatalog holds the first-party credentials CPA stores as its own lists.
// The values are shaped like provider keys because the console masks them before
// they are rendered; none of them is usable, and nothing in the demo contacts
// the hosts they point at.
func familyCatalog() []apiKeyFamily {
	return []apiKeyFamily{
		{
			family: "claude",
			keys: []familyKey{{
				apiKey: "sk-ant-demo-claude-0001", authIndex: "key-claude-01",
				models:   []modelRoute{{name: "claude-sonnet-4-5-20250929", alias: "sonnet"}, {name: "claude-haiku-4-5", alias: "haiku"}},
				priority: 5, weight: 3,
			}},
		},
		{
			family: "gemini",
			keys: []familyKey{{
				apiKey: "AIza-demo-gemini-0001", authIndex: "key-gemini-01",
				models:   []modelRoute{{name: "gemini-2.5-pro"}, {name: "gemini-2.5-flash"}},
				priority: 5, weight: 3,
			}},
		},
		{
			family: "codex",
			keys: []familyKey{{
				apiKey: "sk-demo-codex-0001", authIndex: "key-codex-01", baseURL: "https://api.openai.com/v1",
				models:   []modelRoute{{name: "gpt-5", alias: "gpt-5"}, {name: "gpt-5-mini", alias: "gpt-5-mini"}},
				priority: 5, weight: 2,
			}},
		},
	}
}

// gatewayKey is one client key through which callers reach the gateway. The
// alias is Oh My CPA's own metadata, which is what the request list renders.
type gatewayKey struct {
	value string
	alias string
	// usageWeight decides how much of the fabricated traffic this key carries.
	usageWeight int
}

func gatewayKeyCatalog() []gatewayKey {
	return []gatewayKey{
		{value: "omc-demo-key-platform", alias: "platform-services", usageWeight: 5},
		{value: "omc-demo-key-ci", alias: "ci-pipelines", usageWeight: 3},
		{value: "omc-demo-key-laptop", alias: "junze · laptop", usageWeight: 2},
		{value: "omc-demo-key-eval", alias: "eval-harness", usageWeight: 1},
	}
}

// modelProfile describes how one model behaves: which provider answers it, how
// large its traffic is, and what its requests look like. The shapes matter more
// than the exact numbers - a reasoning model that emits thousands of reasoning
// tokens and a flash model that answers in a few hundred are what make the
// dashboard read as a real instance.
type modelProfile struct {
	name     string
	provider string
	// weight is the share of requests this model carries relative to its peers.
	weight int
	// authType is what CPA records for the credential that answered.
	authType   string
	endpoint   string
	inputMean  int64
	outputMean int64
	// reasonShare is the part of the answer the model spends thinking. It is a
	// share of the output rather than a count of its own, because that is how
	// every provider reports it: reasoning tokens are a subset of the completion.
	reasonShare float64
	cacheRead   float64
	cacheCreate float64
	// latencyMS is the mean end-to-end time; ttftRatio is the share of it before
	// the first token.
	latencyMS int64
	ttftRatio float64
	// failureRate is the share of requests this model refuses, before the global
	// failure floor is applied.
	failureRate float64
}

func modelCatalog() []modelProfile {
	return []modelProfile{
		{name: "gpt-5-codex", provider: "codex", weight: 26, authType: "oauth", endpoint: "/v1/responses",
			inputMean: 14200, outputMean: 1850, reasonShare: 0.55, cacheRead: 0.62, cacheCreate: 0.08,
			latencyMS: 8400, ttftRatio: 0.16, failureRate: 0.012},
		{name: "gpt-5.1-codex", provider: "codex", weight: 14, authType: "oauth", endpoint: "/v1/responses",
			inputMean: 16800, outputMean: 2140, reasonShare: 0.6, cacheRead: 0.66, cacheCreate: 0.09,
			latencyMS: 9600, ttftRatio: 0.15, failureRate: 0.014},
		{name: "gpt-5", provider: "codex", weight: 9, authType: "oauth", endpoint: "/v1/responses",
			inputMean: 7400, outputMean: 1250, reasonShare: 0.4, cacheRead: 0.41, cacheCreate: 0.05,
			latencyMS: 6100, ttftRatio: 0.2, failureRate: 0.01},
		{name: "claude-sonnet-4-5-20250929", provider: "claude", weight: 17, authType: "oauth", endpoint: "/v1/messages",
			inputMean: 12600, outputMean: 2320, reasonShare: 0.3, cacheRead: 0.58, cacheCreate: 0.14,
			latencyMS: 7200, ttftRatio: 0.22, failureRate: 0.016},
		{name: "claude-opus-4-1", provider: "claude", weight: 4, authType: "oauth", endpoint: "/v1/messages",
			inputMean: 18400, outputMean: 3050, reasonShare: 0.35, cacheRead: 0.52, cacheCreate: 0.16,
			latencyMS: 12400, ttftRatio: 0.24, failureRate: 0.02},
		{name: "claude-haiku-4-5", provider: "claude", weight: 6, authType: "oauth", endpoint: "/v1/messages",
			inputMean: 4200, outputMean: 830, reasonShare: 0.15, cacheRead: 0.47, cacheCreate: 0.06,
			latencyMS: 2100, ttftRatio: 0.28, failureRate: 0.008},
		{name: "gemini-2.5-pro", provider: "gemini", weight: 7, authType: "oauth", endpoint: "/v1beta/models",
			inputMean: 22400, outputMean: 1680, reasonShare: 0.4, cacheRead: 0.5, cacheCreate: 0.04,
			latencyMS: 9100, ttftRatio: 0.26, failureRate: 0.013},
		{name: "gemini-2.5-flash", provider: "gemini", weight: 5, authType: "oauth", endpoint: "/v1beta/models",
			inputMean: 5600, outputMean: 690, reasonShare: 0.1, cacheRead: 0.44, cacheCreate: 0.03,
			latencyMS: 1500, ttftRatio: 0.34, failureRate: 0.006},
		{name: "gemini-3-pro-preview", provider: "antigravity", weight: 2, authType: "oauth", endpoint: "/v1beta/models",
			inputMean: 19800, outputMean: 1540, reasonShare: 0.45, cacheRead: 0.48, cacheCreate: 0.04,
			latencyMS: 10200, ttftRatio: 0.24, failureRate: 0.018},
		{name: "kimi-k2-0905", provider: "kimi", weight: 3, authType: "oauth", endpoint: "/v1/chat/completions",
			inputMean: 9800, outputMean: 1420, reasonShare: 0.35, cacheRead: 0.36, cacheCreate: 0.02,
			latencyMS: 4600, ttftRatio: 0.3, failureRate: 0.011},
		{name: "grok-4", provider: "xai", weight: 2, authType: "oauth", endpoint: "/v1/chat/completions",
			inputMean: 11200, outputMean: 1760, reasonShare: 0.4, cacheRead: 0.33, cacheCreate: 0.02,
			latencyMS: 6800, ttftRatio: 0.27, failureRate: 0.015},
		{name: "deepseek-chat", provider: "deepseek", weight: 3, authType: "api_key", endpoint: "/v1/chat/completions",
			inputMean: 8800, outputMean: 1180, reasonShare: 0.2, cacheRead: 0.55, cacheCreate: 0.02,
			latencyMS: 3400, ttftRatio: 0.32, failureRate: 0.009},
		{name: "deepseek-reasoner", provider: "deepseek", weight: 1, authType: "api_key", endpoint: "/v1/chat/completions",
			inputMean: 10400, outputMean: 1980, reasonShare: 0.85, cacheRead: 0.5, cacheCreate: 0.02,
			latencyMS: 15800, ttftRatio: 0.4, failureRate: 0.017},
		{name: "qwen3-max", provider: "qwen", weight: 1, authType: "api_key", endpoint: "/v1/chat/completions",
			inputMean: 7200, outputMean: 1080, reasonShare: 0.25, cacheRead: 0.3, cacheCreate: 0.02,
			latencyMS: 4100, ttftRatio: 0.31, failureRate: 0.01},
	}
}

// modelsDevCanonical maps a model the gateway serves to the identity the public
// price catalogue lists it under. A model that is absent is priced by hand: the
// relay and self-hosted models whose operator sets their own rate, and the ones
// whose name here is already its catalogue identity.
var modelsDevCanonical = map[string]string{
	"gpt-5-codex":                "gpt-5-codex",
	"gpt-5.1-codex":              "gpt-5.1-codex",
	"gpt-5":                      "gpt-5",
	"gpt-5-mini":                 "gpt-5-mini",
	"claude-sonnet-4-5-20250929": "claude-sonnet-4-5",
	"claude-opus-4-1":            "claude-opus-4-1",
	"claude-haiku-4-5":           "claude-haiku-4-5",
	"gemini-2.5-pro":             "gemini-2.5-pro",
	"gemini-2.5-flash":           "gemini-2.5-flash",
	"gemini-3-pro-preview":       "gemini-3-pro-preview",
	"kimi-k2-0905":               "kimi-k2",
	"grok-4":                     "grok-4",
}

// priceRow is one model's price, in USD per million tokens.
type priceRow struct {
	model      string
	prompt     float64
	completion float64
	cacheRead  float64
	cacheWrite float64
}

// priceCatalog is published as manual rows: the demo has no models.dev sync, so
// these are the prices the dashboard's cost column is computed from.
func priceCatalog() []priceRow {
	return []priceRow{
		{model: "gpt-5-codex", prompt: 1.25, completion: 10, cacheRead: 0.125, cacheWrite: 1.25},
		{model: "gpt-5.1-codex", prompt: 1.25, completion: 10, cacheRead: 0.125, cacheWrite: 1.25},
		{model: "gpt-5", prompt: 1.25, completion: 10, cacheRead: 0.125, cacheWrite: 1.25},
		{model: "gpt-5-mini", prompt: 0.25, completion: 2, cacheRead: 0.025, cacheWrite: 0.25},
		{model: "claude-sonnet-4-5-20250929", prompt: 3, completion: 15, cacheRead: 0.3, cacheWrite: 3.75},
		{model: "claude-opus-4-1", prompt: 15, completion: 75, cacheRead: 1.5, cacheWrite: 18.75},
		{model: "claude-haiku-4-5", prompt: 1, completion: 5, cacheRead: 0.1, cacheWrite: 1.25},
		{model: "gemini-2.5-pro", prompt: 1.25, completion: 10, cacheRead: 0.31, cacheWrite: 4.5},
		{model: "gemini-2.5-flash", prompt: 0.3, completion: 2.5, cacheRead: 0.075, cacheWrite: 1},
		{model: "gemini-3-pro-preview", prompt: 2, completion: 12, cacheRead: 0.5, cacheWrite: 4.5},
		{model: "kimi-k2-0905", prompt: 0.6, completion: 2.5, cacheRead: 0.15, cacheWrite: 0.6},
		{model: "grok-4", prompt: 3, completion: 15, cacheRead: 0.75, cacheWrite: 3},
		{model: "deepseek-chat", prompt: 0.28, completion: 0.42, cacheRead: 0.028, cacheWrite: 0.28},
		{model: "deepseek-reasoner", prompt: 0.28, completion: 0.42, cacheRead: 0.028, cacheWrite: 0.28},
		{model: "qwen3-max", prompt: 1.2, completion: 6, cacheRead: 0.24, cacheWrite: 1.2},
		{model: "qwen3-coder-plus", prompt: 1, completion: 5, cacheRead: 0.2, cacheWrite: 1},
	}
}

// pluginEntry is one installed CPA plugin.
type pluginEntry struct {
	id          string
	name        string
	version     string
	author      string
	description string
	enabled     bool
	configured  bool
	registered  bool
	permissions []string
	// No fixture plugin declares a logo URL on purpose: the console inlines
	// plugin-declared logos by fetching them, and a public demo must not fetch
	// anything a plugin names. See internal/demo/README-less doc comment on the
	// upstream, and internal/api's pluginLogoFetcher.
}

func pluginCatalog() []pluginEntry {
	return []pluginEntry{
		{
			id: "usage-exporter", name: "Usage exporter", version: "1.4.2", author: "oh-my-cpa",
			description: "Streams every captured request record to an S3-compatible bucket.",
			enabled:     true, configured: true, registered: true,
			permissions: []string{"usage:read", "network:egress"},
		},
		{
			id: "prompt-redactor", name: "Prompt redactor", version: "0.9.0", author: "community",
			description: "Rewrites prompt bodies before they reach an upstream provider.",
			enabled:     true, configured: false, registered: true,
			permissions: []string{"request:mutate"},
		},
		{
			id: "quota-notifier", name: "Quota notifier", version: "2.1.0", author: "community",
			description: "Posts a webhook when a credential's quota window crosses a threshold.",
			enabled:     false, configured: true, registered: true,
			permissions: []string{"quota:read", "network:egress"},
		},
	}
}

func pluginStoreCatalog() []pluginEntry {
	return []pluginEntry{
		{id: "otel-bridge", name: "OpenTelemetry bridge", version: "1.0.3", author: "oh-my-cpa",
			description: "Exports request traces to an OTLP collector.", permissions: []string{"usage:read", "network:egress"}},
		{id: "cost-anomaly", name: "Cost anomaly detector", version: "0.4.1", author: "community",
			description: "Flags a model whose spend leaves its trailing baseline.", permissions: []string{"usage:read"}},
		{id: "team-router", name: "Team router", version: "1.2.0", author: "community",
			description: "Routes a caller key to a credential pool by team.", permissions: []string{"request:mutate", "config:read"}},
	}
}

// errorLogFiles are the request-error logs the log page lists.
//
// The names are the log's own convention - it stamps each file with the moment it
// opened - so they are derived from the same instant their `modified` time is, rather
// than written out. A fixed name beside a moving timestamp ages: within a week the
// list would be offering files dated months ago, which is exactly the "obviously a
// fixture" look the demo has to avoid.
//
// Downloading one is refused in demo mode: the file behind it would be a raw request log.
func errorLogFiles(now time.Time) []map[string]any {
	entries := []struct {
		ago  time.Duration
		size int64
	}{
		{2 * time.Hour, 18_442},
		{8 * time.Hour, 7_930},
		{26 * time.Hour, 31_205},
	}
	files := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		openedAt := now.Add(-entry.ago)
		files = append(files, map[string]any{
			"name":     "request-error-" + openedAt.UTC().Format("2006-01-02T15-04-05Z") + ".log",
			"size":     entry.size,
			"modified": openedAt.Unix(),
		})
	}
	return files
}

// logTail is the CPA file log the log page tails. It reads like a gateway that
// has been running: routing decisions, retries, a cooldown.
func logTail(now time.Time) []string {
	entries := []struct {
		ago     time.Duration
		message string
	}{
		{90 * time.Second, `level=info msg="request completed" model=gpt-5-codex provider=codex auth_index=auth-codex-01 status=200 latency_ms=8127 stream=true`},
		{3 * time.Minute, `level=info msg="request completed" model=claude-sonnet-4-5-20250929 provider=claude auth_index=auth-claude-01 status=200 latency_ms=6904 stream=true`},
		{5 * time.Minute, `level=warn msg="credential cooling down" auth_index=auth-codex-02 reason=rate_limited cooldown_seconds=52`},
		{6 * time.Minute, `level=error msg="upstream returned an error" model=gpt-5 provider=codex auth_index=auth-codex-02 status=429 body="rate limit reached"`},
		{6 * time.Minute, `level=info msg="retrying with the next credential" model=gpt-5 auth_index=auth-codex-01 attempt=2`},
		{8 * time.Minute, `level=info msg="request completed" model=gemini-2.5-pro provider=gemini auth_index=auth-gemini-01 status=200 latency_ms=9043 stream=true`},
		{11 * time.Minute, `level=info msg="routing decision" strategy=round-robin model=deepseek-chat candidates=2 selected=auth-key-deepseek-01`},
		{14 * time.Minute, `level=info msg="request completed" model=claude-haiku-4-5 provider=claude auth_index=auth-claude-01 status=200 latency_ms=1983 stream=true`},
		{19 * time.Minute, `level=info msg="usage record queued" channel=usage records=1`},
		{24 * time.Minute, `level=info msg="request completed" model=gpt-5.1-codex provider=codex auth_index=auth-codex-01 status=200 latency_ms=11240 stream=true`},
	}
	lines := make([]string, 0, len(entries))
	for _, entry := range entries {
		lines = append(lines, fmt.Sprintf("%s %s", now.Add(-entry.ago).UTC().Format("2006-01-02T15:04:05.000Z"), entry.message))
	}
	return lines
}

// configDocument is the CPA configuration the config page renders. It is a plain
// document: it describes a working gateway without carrying a live secret, and
// the same document is served as JSON and as YAML so the two views cannot drift.
func configDocument() map[string]any {
	return map[string]any{
		"host":                     "0.0.0.0",
		"port":                     8317,
		"debug":                    false,
		"logging-to-file":          true,
		"request-log":              true,
		"usage-statistics-enabled": true,
		"request-retry":            2,
		"max-retry-interval":       30,
		"max-retry-credentials":    3,
		"ws-auth":                  false,
		"force-model-prefix":       false,
		"logs-max-total-size-mb":   128,
		"error-logs-max-files":     20,
		"proxy-url":                "",
		"api-keys":                 gatewayKeyValues(),
		"routing":                  map[string]any{"strategy": "round-robin"},
		"claude-api-key":           familySection("claude"),
		"gemini-api-key":           familySection("gemini"),
		"codex-api-key":            familySection("codex"),
		"openai-compatibility":     compatibilitySection(),
		"oauth-model-alias":        oauthModelAliases(),
		"oauth-excluded-models":    oauthExcludedModels(),
		"remote-management":        map[string]any{"allow-remote": false, "disable-control-panel": false},
	}
}

func gatewayKeyValues() []string {
	keys := gatewayKeyCatalog()
	values := make([]string, 0, len(keys))
	for _, key := range keys {
		values = append(values, key.value)
	}
	return values
}

func oauthModelAliases() map[string]any {
	return map[string]any{
		"codex": []map[string]any{
			{"name": "gpt-5-codex", "alias": "gpt-5-codex-high", "display-name": "GPT-5 Codex (high effort)", "fork": false},
			{"name": "gpt-5.1-codex", "alias": "codex-latest", "display-name": "GPT-5.1 Codex"},
		},
		"claude": []map[string]any{
			{"name": "claude-sonnet-4-5-20250929", "alias": "sonnet", "display-name": "Claude Sonnet 4.5"},
			{"name": "claude-haiku-4-5", "alias": "haiku"},
		},
	}
}

func oauthExcludedModels() map[string]any {
	return map[string]any{
		"codex":  []string{"gpt-5-mini"},
		"claude": []string{"claude-3-5-sonnet-20240620"},
	}
}

// usageBucketsPerProvider feeds the overview panel: a rolling history of
// successes and failures per credential pool.
func usageBucketsPerProvider(now time.Time) map[string]map[string]map[string]any {
	series := func(successPerHour, failedPerHour int64) map[string]any {
		buckets := make([]map[string]any, 0, 12)
		var success, failed int64
		for hour := 11; hour >= 0; hour-- {
			bucket := map[string]any{
				"time":    now.Add(-time.Duration(hour) * time.Hour).UTC().Format("2006-01-02T15:04:05Z"),
				"success": successPerHour,
				"failed":  failedPerHour,
			}
			buckets = append(buckets, bucket)
			success += successPerHour
			failed += failedPerHour
		}
		return map[string]any{"success": success, "failed": failed, "recent_requests": buckets}
	}
	return map[string]map[string]map[string]any{
		"codex":  {"auth-codex-01": series(38, 1), "auth-codex-02": series(14, 1)},
		"claude": {"auth-claude-01": series(26, 1)},
		"gemini": {"auth-gemini-01": series(11, 0)},
		"kimi":   {"auth-kimi-01": series(5, 0)},
		"xai":    {"auth-xai-01": series(3, 0)},
		"deepseek": {
			"auth-key-deepseek-01": series(9, 0),
			"auth-key-deepseek-02": series(4, 0),
		},
		"qwen": {"auth-key-dashscope-01": series(2, 0)},
	}
}

// quotaPayloads answers the quota page's upstream reads. The quota service calls
// these provider URLs through CPA's api-call proxy; the fixture answers them
// locally, which is what keeps a deployed demo from reaching chatgpt.com or
// api.anthropic.com.
func quotaPayloads(now time.Time) map[string]any {
	resetAt := now.Add(2*time.Hour + 14*time.Minute).UTC().Format(time.RFC3339)
	weeklyReset := now.Add(4*24*time.Hour + 6*time.Hour).UTC().Format(time.RFC3339)
	return map[string]any{
		codexUsageURL: map[string]any{
			"plan_type": "pro",
			"rate_limit": map[string]any{
				"allowed": true,
				"primary_window": map[string]any{
					"used_percent": 42.5, "limit_window_seconds": 18000,
					"reset_after_seconds": 8064, "reset_at": resetAt,
				},
				"secondary_window": map[string]any{
					"used_percent": 61.2, "limit_window_seconds": 604800,
					"reset_after_seconds": 356400, "reset_at": weeklyReset,
				},
			},
			"credits": map[string]any{"has_credits": true, "unlimited": false},
		},
		codexResetCreditsURL: map[string]any{
			"available_count": 2,
			"credits": []map[string]any{
				{"id": "credit-01", "status": "available", "reset_type": "monthly", "granted_at": now.Add(-9 * 24 * time.Hour).Format(time.RFC3339), "expires_at": now.Add(21 * 24 * time.Hour).Format(time.RFC3339)},
				{"id": "credit-02", "status": "available", "reset_type": "promotional", "granted_at": now.Add(-2 * 24 * time.Hour).Format(time.RFC3339), "expires_at": now.Add(28 * 24 * time.Hour).Format(time.RFC3339)},
			},
		},
		claudeUsageURL: map[string]any{
			"five_hour":        map[string]any{"utilization": 36.4, "resets_at": resetAt},
			"seven_day":        map[string]any{"utilization": 58.1, "resets_at": weeklyReset},
			"seven_day_opus":   map[string]any{"utilization": 22.9, "resets_at": weeklyReset},
			"seven_day_sonnet": map[string]any{"utilization": 64.7, "resets_at": weeklyReset},
			"extra_usage":      map[string]any{"is_enabled": false, "monthly_limit": 0, "used_credits": 0},
			"limits":           []map[string]any{{"kind": "session", "group": "five_hour", "percent": 36.4, "resets_at": resetAt, "is_active": true}},
		},
		claudeProfileURL: map[string]any{
			"account":        map[string]any{"email": "ops@acme-labs.example"},
			"organization":   map[string]any{"name": "Acme Labs", "rate_limit_tier": "default_claude_max_20x"},
			"has_claude_max": true, "has_claude_pro": false,
			"has_extra_usage_enabled": false, "subscription_status": "active",
		},
		kimiUsageURL: map[string]any{
			"data": map[string]any{
				"limits": []map[string]any{{
					"window": map[string]any{"duration": 300, "timeUnit": "TIME_UNIT_MINUTE"},
					"detail": map[string]any{"limit": 1000, "remaining": 682, "resetTime": resetAt},
				}},
			},
		},
		xaiUsageURL: map[string]any{
			"config": map[string]any{
				"creditUsagePercent": 28.5,
				"monthlyLimit":       map[string]any{"val": 20000},
				"used":               map[string]any{"val": 5700},
				"currentPeriod":      map[string]any{"type": "monthly", "start": now.Add(-18 * 24 * time.Hour).Format(time.RFC3339), "end": weeklyReset},
				"productUsage": []map[string]any{
					{"product": "grok-4", "usagePercent": 31.2},
					{"product": "grok-4-fast", "usagePercent": 14.8},
				},
			},
		},
		antigravityUsageURL: map[string]any{
			"groups": []map[string]any{{
				"displayName": "Gemini 3 Pro",
				"buckets": []map[string]any{{
					"bucketId": "gemini-3-pro", "displayName": "Gemini 3 Pro",
					"window": "5h", "resetTime": resetAt, "remainingFraction": 0.71,
				}},
			}},
		},
		devinUsageURL: map[string]any{
			"planStatus": map[string]any{
				"planInfo":                    map[string]any{"planName": "Team"},
				"dailyQuotaRemainingPercent":  74.0,
				"dailyQuotaResetAtUnix":       now.Add(6 * time.Hour).Unix(),
				"weeklyQuotaRemainingPercent": 61.5,
				"weeklyQuotaResetAtUnix":      now.Add(3 * 24 * time.Hour).Unix(),
			},
		},
	}
}

// quotaPayloadKeys is the URL list quotaPayloads answers, exported through a
// helper so the upstream and its test agree on what is covered.
func quotaPayloadKeys() []string {
	return []string{
		codexUsageURL, codexResetCreditsURL, claudeUsageURL, claudeProfileURL,
		kimiUsageURL, xaiUsageURL, antigravityUsageURL, devinUsageURL,
	}
}

// Provider URLs the quota service is allowed to call.
//
// They are duplicated rather than imported because internal/quota already owns the
// list and importing it would let a change there silently change what the fixture
// answers. The demo test asserts every one of them is still inside the quota
// allowlist, so the duplication cannot drift into answering a URL the console would
// never ask for - which would leave the quota page empty with no visible reason.
const (
	codexUsageURL        = "https://chatgpt.com/backend-api/wham/usage"
	codexResetCreditsURL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
	claudeUsageURL       = "https://api.anthropic.com/api/oauth/usage"
	claudeProfileURL     = "https://api.anthropic.com/api/oauth/profile"
	kimiUsageURL         = "https://api.kimi.com/coding/v1/usages"
	// The monthly billing read is the first one the quota service tries for xAI, so
	// it is the one that has to answer; the paid-account probe behind it is never
	// reached once this succeeds.
	xaiUsageURL = "https://cli-chat-proxy.grok.com/v1/billing"
	// Antigravity is queried through a list of regional hosts and the first is used,
	// which is what makes this one the fixture's answer.
	antigravityUsageURL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
	devinUsageURL       = "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus"
)

func compatibilitySection() []map[string]any {
	catalog := compatibilityCatalog()
	entries := make([]map[string]any, 0, len(catalog))
	for _, provider := range catalog {
		models := make([]map[string]any, 0, len(provider.models))
		for _, model := range provider.models {
			entry := map[string]any{"name": model.name}
			if model.alias != "" {
				entry["alias"] = model.alias
			}
			if model.displayName != "" {
				entry["display-name"] = model.displayName
			}
			models = append(models, entry)
		}
		keys := make([]map[string]any, 0, len(provider.keys))
		for index, key := range provider.keys {
			keys = append(keys, map[string]any{
				"api-key":    key,
				"auth-index": fmt.Sprintf("auth-%s-%02d", provider.prefix, index+1),
			})
		}
		entries = append(entries, map[string]any{
			"name":            provider.name,
			"disabled":        false,
			"prefix":          provider.prefix,
			"priority":        provider.priority,
			"base-url":        provider.baseURL,
			"api-key-entries": keys,
			"models":          models,
		})
	}
	return entries
}

func familySection(family string) []map[string]any {
	for _, catalog := range familyCatalog() {
		if catalog.family != family {
			continue
		}
		entries := make([]map[string]any, 0, len(catalog.keys))
		for _, key := range catalog.keys {
			entry := map[string]any{
				"api-key":    key.apiKey,
				"auth-index": key.authIndex,
				"priority":   key.priority,
				"weight":     key.weight,
			}
			if key.baseURL != "" {
				entry["base-url"] = key.baseURL
			}
			if len(key.models) > 0 {
				models := make([]map[string]any, 0, len(key.models))
				for _, model := range key.models {
					route := map[string]any{"name": model.name}
					if model.alias != "" {
						route["alias"] = model.alias
					}
					models = append(models, route)
				}
				entry["models"] = models
			}
			entries = append(entries, entry)
		}
		return entries
	}
	return nil
}

// authFileModels answers the per-credential model list the credential page
// expands, keyed by credential name.
func authFileModels(name string) []map[string]any {
	for _, item := range credentialCatalog() {
		if item.name != name {
			continue
		}
		models := make([]map[string]any, 0, len(item.models))
		for _, model := range item.models {
			models = append(models, map[string]any{"id": model, "display_name": displayNameForModel(model)})
		}
		return models
	}
	return []map[string]any{}
}

// displayNameForModel is the presentation name the credential page shows beside
// each model id.
func displayNameForModel(model string) string {
	for _, profile := range modelCatalog() {
		if profile.name == model {
			if profile.provider == "" {
				return model
			}
		}
	}
	switch model {
	case "gpt-5-codex":
		return "GPT-5 Codex"
	case "gpt-5.1-codex":
		return "GPT-5.1 Codex"
	case "gpt-5":
		return "GPT-5"
	case "gpt-5-mini":
		return "GPT-5 mini"
	case "claude-sonnet-4-5-20250929":
		return "Claude Sonnet 4.5"
	case "claude-opus-4-1":
		return "Claude Opus 4.1"
	case "claude-haiku-4-5":
		return "Claude Haiku 4.5"
	case "gemini-2.5-pro":
		return "Gemini 2.5 Pro"
	case "gemini-2.5-flash":
		return "Gemini 2.5 Flash"
	case "gemini-3-pro-preview":
		return "Gemini 3 Pro (preview)"
	case "kimi-k2-0905":
		return "Kimi K2"
	case "grok-4":
		return "Grok 4"
	case "deepseek-chat":
		return "DeepSeek Chat"
	case "deepseek-reasoner":
		return "DeepSeek Reasoner"
	case "qwen3-max":
		return "Qwen3 Max"
	case "qwen3-coder-plus":
		return "Qwen3 Coder Plus"
	default:
		return model
	}
}
