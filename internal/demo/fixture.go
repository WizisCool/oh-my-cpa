package demo

import (
	_ "embed"
	"encoding/base64"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
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
	isDisabled  bool
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
			name: "codex-billing-target.json", authIndex: "auth-codex-04", kind: "codex", provider: "codex",
			label: "Codex · billing target", email: "billing@acme-labs.example", accountType: "oauth", plan: "pro",
			models:  []string{"gpt-5-codex", "gpt-5"},
			success: 611, failed: 9, priority: 3, weight: 2, note: "seat the team is migrating onto",
		},
		{
			name: "codex-standby.json", authIndex: "auth-codex-03", kind: "codex", provider: "codex",
			label: "Codex · standby", email: "backup@acme-labs.example", accountType: "oauth", plan: "free",
			models:  []string{"gpt-5"},
			success: 96, failed: 2, priority: 1, weight: 1, note: "kept for failover drills", isDisabled: true,
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
	// A request served through this list is attributed by the auth index its key carries,
	// so a provider named here has to declare the keys that will answer for it. The models
	// are the ones the fixture carries traffic for - a record naming a provider whose key
	// list is empty would render as an unattributed request.
	return []compatibilityProvider{
		{
			name: "DeepSeek", baseURL: "https://api.deepseek.com/v1", prefix: "ds", priority: 3,
			models: []modelRoute{
				{name: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash"},
				{name: "deepseek-pro-latest", displayName: "DeepSeek Pro Latest"},
			},
			keys: []string{"relay-deepseek-primary", "relay-deepseek-secondary"},
		},
		{
			name: "DashScope (Qwen)", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", prefix: "qwen", priority: 2,
			models: []modelRoute{
				{name: "qwen3.8-omni-flash", displayName: "Qwen3.8 Omni Flash"},
				{name: "qwen3.8-max", displayName: "Qwen3.8 Max"},
			},
			keys: []string{"relay-dashscope-primary"},
		},
		{
			name: "MiniMax", baseURL: "https://api.minimax.io/v1", prefix: "minimax", priority: 4,
			models: []modelRoute{
				{name: "minimax-m3", displayName: "MiniMax M3"},
			},
			keys: []string{"relay-minimax-primary"},
		},
		{
			name: "Xiaomi MiMo", baseURL: "https://api.mimo.xiaomi.com/v1", prefix: "mimo", priority: 5,
			models: []modelRoute{
				{name: "mimo-v2.5", displayName: "MiMo V2.5"},
				{name: "mimo-v2.5-pro", displayName: "MiMo V2.5 Pro"},
			},
			keys: []string{"relay-mimo-primary"},
		},
	}
}

// compatibilityRecordLabel is the provider label CPA writes on a request served
// through the openai-compatibility list, derived from the provider's own name the
// way the gateway derives it. The fixture builds its records with this rather than
// with a literal, so the demonstration's provider labels cannot drift from what a
// real gateway writes - and the request list's resolution therefore has something
// real to match.
func compatibilityRecordLabel(providerName string) string {
	return management.OpenAICompatibilityLabelPrefix + strings.ToLower(providerName)
}

// compatibilityAuthIndex is the runtime auth index the fixture's credentials carry
// for the position-th key of a compatibility provider. The provider list the console
// reads and the request records it seeds both derive it here, so the two sides cannot
// disagree about which key answered a request.
func compatibilityAuthIndex(prefix string, position int) string {
	return fmt.Sprintf("auth-%s-%02d", prefix, position)
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
// The values are deliberately not shaped like any provider's keys: the demo's
// configuration source view shows the file unmasked, as the product's does, and
// the dataset's privacy check refuses anything that looks like a real credential.
// Nothing in the demo contacts the hosts they point at.
func familyCatalog() []apiKeyFamily {
	return []apiKeyFamily{
		{
			family: "claude",
			keys: []familyKey{{
				apiKey: "demo-claude-upstream-0001", authIndex: "key-claude-01",
				models:   []modelRoute{{name: "claude-sonnet-4-5-20250929", alias: "sonnet"}, {name: "claude-haiku-4-5", alias: "haiku"}},
				priority: 5, weight: 3,
			}},
		},
		{
			family: "gemini",
			keys: []familyKey{{
				apiKey: "demo-gemini-upstream-0001", authIndex: "key-gemini-01",
				models:   []modelRoute{{name: "gemini-2.5-pro"}, {name: "gemini-2.5-flash"}},
				priority: 5, weight: 3,
			}},
		},
		{
			family: "codex",
			keys: []familyKey{{
				apiKey: "demo-codex-upstream-0001", authIndex: "key-codex-01", baseURL: "https://api.openai.com/v1",
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
		// The alias is rendered in the request list, and the demonstration is public, so
		// it names a role rather than a person: an operator's own device name here would
		// put their identity on a page anyone can open.
		{value: "omc-demo-key-laptop", alias: "personal-laptop", usageWeight: 2},
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
	// servedAs is the model this one's upstream occasionally answers with
	// instead, so the request list has substitutions to show: a subscription
	// routing a frontier model to a cheaper sibling, and a canary build answering
	// under its own name. Empty for a model that is always served as requested.
	servedAs string
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
		// The catalogue is drawn from what carries the most traffic today, checked against
		// OpenRouter's published ranking and OpenCode Go's list of curated coding models
		// rather than from memory. A demonstration whose "frontier" names are two
		// generations old undermines the thing it is showing: an operator reading the
		// model breakdown is reading a claim about what people run now.
		//
		// The weights are the ranking's order of magnitude, so the busiest line is the
		// busiest model rather than whichever name happens to sit first.
		{name: "glm-5.3-flash", provider: "zai", weight: 22, authType: "oauth", endpoint: "/v1/chat/completions",
			inputMean: 15900, outputMean: 2140, reasonShare: 0.5, cacheRead: 0.6, cacheCreate: 0.07,
			latencyMS: 3200, ttftRatio: 0.18, failureRate: 0.011},
		{name: "gpt-5.6-luna", provider: "codex", weight: 20, authType: "oauth", endpoint: "/v1/responses",
			inputMean: 14600, outputMean: 1820, reasonShare: 0.45, cacheRead: 0.63, cacheCreate: 0.08,
			latencyMS: 7800, ttftRatio: 0.17, failureRate: 0.012},
		{name: "deepseek-v4-flash", provider: compatibilityRecordLabel("DeepSeek"), weight: 17, authType: "api_key", endpoint: "/v1/chat/completions",
			inputMean: 9400, outputMean: 1260, reasonShare: 0.25, cacheRead: 0.58, cacheCreate: 0.02,
			latencyMS: 2900, ttftRatio: 0.31, failureRate: 0.008},
		{name: "mimo-v2.5", provider: compatibilityRecordLabel("Xiaomi MiMo"), weight: 12, authType: "api_key", endpoint: "/v1/chat/completions",
			inputMean: 11800, outputMean: 1540, reasonShare: 0.35, cacheRead: 0.52, cacheCreate: 0.02,
			latencyMS: 3600, ttftRatio: 0.28, failureRate: 0.01},
		{name: "kimi-k3", provider: "kimi", weight: 9, authType: "oauth", endpoint: "/v1/chat/completions",
			inputMean: 12600, outputMean: 1780, reasonShare: 0.4, cacheRead: 0.44, cacheCreate: 0.03,
			latencyMS: 5200, ttftRatio: 0.26, failureRate: 0.011},
		{name: "claude-opus-5.5", provider: "claude", weight: 7, authType: "oauth", endpoint: "/v1/messages",
			inputMean: 18600, outputMean: 3120, reasonShare: 0.4, cacheRead: 0.54, cacheCreate: 0.15,
			latencyMS: 11800, ttftRatio: 0.23, failureRate: 0.018},
		{name: "claude-sonnet-5", provider: "claude", weight: 6, authType: "oauth", endpoint: "/v1/messages",
			inputMean: 13100, outputMean: 2380, reasonShare: 0.3, cacheRead: 0.59, cacheCreate: 0.13,
			latencyMS: 6900, ttftRatio: 0.21, failureRate: 0.014},
		{name: "gpt-6-sol", provider: "codex", weight: 5, authType: "oauth", endpoint: "/v1/responses",
			inputMean: 16200, outputMean: 2060, reasonShare: 0.55, cacheRead: 0.61, cacheCreate: 0.09,
			latencyMS: 8900, ttftRatio: 0.16, failureRate: 0.013},
		{name: "grok-4.7", provider: "xai", weight: 4, authType: "oauth", endpoint: "/v1/chat/completions",
			inputMean: 12400, outputMean: 1690, reasonShare: 0.45, cacheRead: 0.38, cacheCreate: 0.02,
			latencyMS: 6400, ttftRatio: 0.27, failureRate: 0.015},
		{name: "minimax-m3", provider: compatibilityRecordLabel("MiniMax"), weight: 3, authType: "api_key", endpoint: "/v1/chat/completions",
			inputMean: 10200, outputMean: 1430, reasonShare: 0.3, cacheRead: 0.46, cacheCreate: 0.02,
			latencyMS: 4100, ttftRatio: 0.29, failureRate: 0.009},
		{name: "qwen3.8-omni-flash", provider: compatibilityRecordLabel("DashScope (Qwen)"), weight: 3, authType: "api_key", endpoint: "/v1/chat/completions",
			inputMean: 8100, outputMean: 1120, reasonShare: 0.25, cacheRead: 0.4, cacheCreate: 0.02,
			latencyMS: 2600, ttftRatio: 0.32, failureRate: 0.008},
		// The two Gemini rows keep a credential-based provider because the OAuth surfaces -
		// the quota panel and the sign-in list - need credentials of their own to render,
		// and a catalogue of API keys alone would leave those pages empty.
		{name: "gemini-3.8-flash-high", servedAs: "gemini-3.8-flash-n", provider: "antigravity", weight: 3, authType: "oauth", endpoint: "/v1beta/models",
			inputMean: 14200, outputMean: 1380, reasonShare: 0.3, cacheRead: 0.49, cacheCreate: 0.04,
			latencyMS: 2700, ttftRatio: 0.28, failureRate: 0.009},
		{name: "gemini-3.7-flash", provider: "gemini", weight: 2, authType: "oauth", endpoint: "/v1beta/models",
			inputMean: 6800, outputMean: 840, reasonShare: 0.15, cacheRead: 0.45, cacheCreate: 0.03,
			latencyMS: 1800, ttftRatio: 0.33, failureRate: 0.007},
		// A reasoning model on a subscription, so the request list shows a long-thinking
		// row beside the fast ones and the cost column has a high-priced entry to report.
		{name: "gpt-6-astra", servedAs: "gpt-6-luna", provider: "codex", weight: 1, authType: "oauth", endpoint: "/v1/responses",
			inputMean: 21400, outputMean: 3860, reasonShare: 0.7, cacheRead: 0.57, cacheCreate: 0.11,
			latencyMS: 16400, ttftRatio: 0.2, failureRate: 0.016},
	}
}

// openRouterSnapshot is a trimmed copy of OpenRouter's real model list, the one the
// demo's price book, model picker and automatic matches are read from. It is data
// captured from the live source rather than rates written by hand, so the demo's
// automatic prices are what a synced deployment would show, and it is decoded by the
// same decoder a sync uses.
//
//go:embed openrouter_snapshot.json
var openRouterSnapshot []byte

// linkedModels are served models an operator pinned to a chosen OpenRouter model.
// DeepSeek's endpoint serves the July snapshot, which the automatic match would not
// pick over the undated id, so the price follows the pin. Antigravity names a
// reasoning tier in the model id, which no OpenRouter entry carries.
var linkedModels = map[string]string{
	"deepseek-v4-flash":     "deepseek/deepseek-v4-flash-0731",
	"gemini-3.8-flash-high": "google/gemini-3.8-flash",
}

// unpricedCatalogModels are models the gateway offers that no price covers yet. They
// carry no traffic, which is the case the attention inbox exists for: a model an
// operator just configured, whose name only resembles an OpenRouter entry, so it is
// offered as a suggestion rather than matched.
var unpricedCatalogModels = []string{"gpt-5.4-mini-high"}

// priceRow is one hand-set price, in USD per million tokens.
type priceRow struct {
	model      string
	prompt     float64
	completion float64
	cacheRead  float64
	cacheWrite float64
}

// customPriceCatalog is the rates an operator set by hand: the relay and
// self-hosted models whose operator decides their own price. Every other served
// model is priced from the OpenRouter snapshot.
func customPriceCatalog() []priceRow {
	return []priceRow{
		{model: "mimo-v2.5", prompt: 0.14, completion: 0.28, cacheRead: 0.0028, cacheWrite: 0.14},
		{model: "minimax-m3", prompt: 0.3, completion: 1.2, cacheRead: 0.06, cacheWrite: 0.3},
		{model: "qwen3.8-omni-flash", prompt: 0.15, completion: 0.47, cacheRead: 0.016, cacheWrite: 0.15},
	}
}

// channelCatalog is the channel multipliers the fixture configures: the Qwen
// endpoint is billed under a coding-plan discount, so every request it answers
// costs half its list price.
func channelCatalog() []channelRow {
	return []channelRow{
		{channel: compatibilityRecordLabel("DashScope (Qwen)"), multiplier: 0.5, note: "Coding-plan discount on the Qwen endpoint"},
	}
}

type channelRow struct {
	channel    string
	multiplier float64
	note       string
}

// PricingCatalogModels names every model the demo's price book lists, priced or
// not, in order. The dataset export captures one editor read per model.
func PricingCatalogModels() []string {
	targets := pricingCatalogTargets()
	models := make([]string, 0, len(targets))
	for model := range targets {
		models = append(models, model)
	}
	sort.Strings(models)
	return models
}

// pluginEntry is one installed CPA plugin, in the shape CPA's plugin host reports it.
//
// A fixture logo is inline artwork, never a URL: the console inlines plugin-declared
// logos by fetching them, and a public demo must not fetch anything a plugin names.
type pluginEntry struct {
	id           string
	name         string
	version      string
	author       string
	repository   string
	logo         string
	isEnabled    bool
	isConfigured bool
	isRegistered bool
	configFields []map[string]any
	config       map[string]any
}

// storePluginEntry is one plugin a store registry offers.
type storePluginEntry struct {
	id               string
	name             string
	version          string
	author           string
	description      string
	repository       string
	license          string
	tags             []string
	logo             string
	sourceID         string
	installedVersion string
}

// fixtureLogo draws a plugin mark as an inline SVG, so the demo shows plugin artwork
// without anything to fetch.
func fixtureLogo(initials, color string) string {
	svg := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" rx="12" fill="` + color +
		`"/><text x="24" y="30" font-family="sans-serif" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">` + initials + `</text></svg>`
	return "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(svg))
}

func configField(name, fieldType, description string, enumValues ...string) map[string]any {
	field := map[string]any{"name": name, "type": fieldType, "description": description, "enum_values": []string{}}
	if len(enumValues) > 0 {
		field["enum_values"] = enumValues
	}
	return field
}

func pluginCatalog() []pluginEntry {
	return []pluginEntry{
		{
			id: "usage-exporter", name: "Usage exporter", version: "1.4.2", author: "router-for-me",
			repository: "router-for-me/cpa-plugin-usage-exporter", logo: fixtureLogo("UE", "#0F766E"),
			isEnabled: true, isConfigured: true, isRegistered: true,
			configFields: []map[string]any{
				configField("bucket", "string", "Destination bucket name."),
				configField("region", "enum", "Bucket region.", "us-east-1", "eu-west-1", "ap-southeast-1"),
				configField("flush-interval-seconds", "integer", "How often buffered records are uploaded."),
				configField("compress", "boolean", "Gzip each uploaded batch."),
				configField("include-models", "array", "Only export records for these models; empty exports all."),
			},
			config: map[string]any{
				"enabled": true, "priority": 10, "bucket": "cpa-usage-archive", "region": "eu-west-1",
				"flush-interval-seconds": 60, "compress": true, "include-models": []any{},
			},
		},
		{
			id: "prompt-redactor", name: "Prompt redactor", version: "0.9.0", author: "community",
			repository: "cpa-community/prompt-redactor",
			isEnabled:  true, isConfigured: false, isRegistered: true,
			configFields: []map[string]any{
				configField("mode", "enum", "What happens to a matched span.", "mask", "drop"),
				configField("patterns", "array", "Regular expressions whose matches are redacted."),
				configField("replacement", "string", "Text a masked span is replaced with."),
			},
			config: map[string]any{},
		},
		{
			id: "quota-notifier", name: "Quota notifier", version: "2.1.0", author: "community",
			repository: "cpa-community/quota-notifier", logo: fixtureLogo("QN", "#B45309"),
			isEnabled: false, isConfigured: true, isRegistered: true,
			configFields: []map[string]any{
				configField("webhook-url", "string", "Where the notification is posted."),
				configField("threshold-percent", "number", "Remaining quota that triggers a notification."),
				configField("labels", "object", "Extra labels attached to every notification."),
			},
			config: map[string]any{
				"enabled": false, "webhook-url": "https://hooks.example.net/cpa-quota",
				"threshold-percent": 15, "labels": map[string]any{"team": "platform"},
			},
		},
	}
}

func pluginStoreCatalog() []storePluginEntry {
	return []storePluginEntry{
		{id: "usage-exporter", name: "Usage exporter", version: "1.5.0", author: "router-for-me",
			description: "Streams every captured request record to an S3-compatible bucket.",
			repository:  "router-for-me/cpa-plugin-usage-exporter", license: "MIT",
			tags: []string{"observability", "export"}, logo: fixtureLogo("UE", "#0F766E"),
			sourceID: "official", installedVersion: "1.4.2"},
		{id: "otel-bridge", name: "OpenTelemetry bridge", version: "1.0.3", author: "router-for-me",
			description: "Exports request traces to an OTLP collector, one span per upstream attempt, with the model, credential index and latency as attributes.",
			repository:  "router-for-me/cpa-plugin-otel-bridge", license: "Apache-2.0",
			tags: []string{"observability", "tracing"}, logo: fixtureLogo("OT", "#4F46E5"), sourceID: "official"},
		{id: "cost-anomaly", name: "Cost anomaly detector", version: "0.4.1", author: "router-for-me",
			description: "Flags a model whose spend leaves its trailing baseline.",
			repository:  "router-for-me/cpa-plugin-cost-anomaly", license: "MIT",
			tags: []string{"cost", "alerting"}, sourceID: "official"},
		{id: "quota-notifier", name: "Quota notifier", version: "2.1.0", author: "community",
			description: "Posts a webhook when a credential's quota window crosses a threshold.",
			repository:  "cpa-community/quota-notifier", license: "MIT",
			tags: []string{"quota", "alerting"}, logo: fixtureLogo("QN", "#B45309"),
			sourceID: "community", installedVersion: "2.1.0"},
		{id: "team-router", name: "Team router", version: "1.2.0", author: "community",
			description: "Routes a caller key to a credential pool by team.",
			repository:  "cpa-community/team-router", license: "BSD-3-Clause",
			tags: []string{"routing"}, logo: fixtureLogo("TR", "#BE185D"), sourceID: "community"},
	}
}

// pluginStoreSources are the registries the fixture's store lists, keyed by source id.
func pluginStoreSources() []map[string]any {
	return []map[string]any{
		{"id": "official", "name": "official", "url": "https://plugins.router-for-me.example/registry.json"},
		{"id": "community", "name": "plugins.cpa-community.example", "url": "https://plugins.cpa-community.example/registry.json"},
	}
}

// pluginsSection is the `plugins` block of the fixture's configuration document.
func pluginsSection() map[string]any {
	configs := map[string]any{}
	for _, plugin := range pluginCatalog() {
		if plugin.isConfigured {
			configs[plugin.id] = plugin.config
		}
	}
	return map[string]any{
		"enabled":       true,
		"dir":           "plugins",
		"store-sources": []string{"https://plugins.cpa-community.example/registry.json"},
		"store-auth": []map[string]any{{
			"match": "https://plugins.cpa-community.example/", "apply-to": []string{"registry", "artifact"},
			"type": "bearer", "token-env": "CPA_COMMUNITY_PLUGIN_TOKEN",
		}},
		"configs": configs,
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
	// The request lines are in the gin access-log shape CPA writes, which is what
	// the log page reads a method, a path and a status from.
	requests := []struct {
		ago                                     time.Duration
		requestID, status, latency, method, url string
	}{
		{90 * time.Second, "9f2c41aa", "200", "8.127s", "POST", "/v1/responses"},
		{3 * time.Minute, "5b7e0c13", "200", "6.904s", "POST", "/v1/messages"},
		{6 * time.Minute, "c81d77f0", "429", "412ms", "POST", "/v1/responses"},
		{8 * time.Minute, "2a6b93de", "200", "9.043s", "POST", "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"},
		{12 * time.Minute, "e04f5a67", "200", "3ms", "GET", "/v1/models"},
		{14 * time.Minute, "71c3d2b8", "200", "1.983s", "POST", "/v1/messages"},
		{21 * time.Minute, "0d9a6e42", "401", "1ms", "GET", "/v1/models"},
		{24 * time.Minute, "b3f81c55", "200", "11.24s", "POST", "/v1/responses"},
	}
	type datedLine struct {
		ago  time.Duration
		text string
	}
	dated := make([]datedLine, 0, len(entries)+len(requests))
	stamp := func(ago time.Duration) string { return now.Add(-ago).UTC().Format("2006-01-02T15:04:05.000Z") }
	for _, entry := range entries {
		dated = append(dated, datedLine{entry.ago, fmt.Sprintf("%s %s", stamp(entry.ago), entry.message)})
	}
	for _, request := range requests {
		dated = append(dated, datedLine{request.ago, fmt.Sprintf(`[%s] [%s] [info ] [gin_logger.go:101] %s | %s | 203.0.113.24 | %s "%s"`,
			stamp(request.ago), request.requestID, request.status, request.latency, request.method, request.url)})
	}
	// Newest first, as the entries above are written; a request line follows the
	// gateway message it shares a moment with.
	sort.SliceStable(dated, func(left, right int) bool { return dated[left].ago < dated[right].ago })
	lines := make([]string, 0, len(dated))
	for _, line := range dated {
		lines = append(lines, line.text)
	}
	return lines
}

// configDocument is the gateway's configuration in the v8 layout, as CPA's v8
// view renders a migrated file: the stored document without runtime fields, so
// upstream groups carry no auth index. It describes a working gateway without
// carrying a live secret, and the same document answers the JSON view, each
// path of it and the YAML view, so they cannot drift.
func configDocument() map[string]any {
	upstreamGroups := map[string]any{"openai-compatibility": v8Groups("openai-compatibility", compatibilitySection())}
	for _, family := range []string{"claude", "gemini", "codex"} {
		upstreamGroups[family] = v8Groups(family, familySection(family))
	}
	return map[string]any{
		"config-version": 8,
		"server":         map[string]any{"host": "0.0.0.0", "port": 8317},
		"management":     map[string]any{"allow-remote": false, "disable-control-panel": false},
		"access":         map[string]any{"api-keys": gatewayKeyValues()},
		"requests":       map[string]any{"proxy-url": ""},
		"routing": map[string]any{
			"strategy":           "round-robin",
			"force-model-prefix": false,
			"retry":              map[string]any{"request-retry": 2, "max-retry-interval": 30, "max-retry-credentials": 3},
		},
		"observability": map[string]any{
			"logs": map[string]any{
				"debug": false, "logging-to-file": true, "request-log": true,
				"logs-max-total-size-mb": 128, "error-logs-max-files": 20,
			},
			"usage": map[string]any{"usage-statistics-enabled": true},
		},
		"oauth": map[string]any{
			"providers":       map[string]any{"aistudio": map[string]any{"ws-auth": false}},
			"model-alias":     oauthModelAliases(),
			"excluded-models": oauthExcludedModels(),
		},
		"api-keys": upstreamGroups,
		"plugins":  pluginsSection(),
	}
}

// v8Groups turns the v0 per-family entries into v8 provider groups the way CPA's
// migration does: one group per entry, its key material under `keys`, and no
// runtime auth index.
func v8Groups(family string, entries []map[string]any) []map[string]any {
	groups := make([]map[string]any, 0, len(entries))
	for index, entry := range entries {
		group := map[string]any{}
		for key, value := range entry {
			switch key {
			case "api-key", "auth-index", "api-key-entries":
			default:
				group[key] = value
			}
		}
		if _, named := group["name"]; !named {
			group["name"] = fmt.Sprintf("%s-%d", family, index+1)
		}
		keys := []map[string]any{}
		if apiKey, ok := entry["api-key"].(string); ok {
			keys = append(keys, map[string]any{"api-key": apiKey})
		}
		if nested, ok := entry["api-key-entries"].([]map[string]any); ok {
			for _, key := range nested {
				keys = append(keys, map[string]any{"api-key": key["api-key"]})
			}
		}
		group["keys"] = keys
		groups = append(groups, group)
	}
	return groups
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
	weeklyResetInstant := now.Add(4*24*time.Hour + 6*time.Hour)
	weeklyReset := weeklyResetInstant.UTC().Format(time.RFC3339)
	// The credits document states the span its percentage covers, and the service reads the window's
	// length from it rather than assuming one, so the fixture states a whole week.
	creditsPeriodStart := weeklyResetInstant.Add(-7 * 24 * time.Hour).UTC().Format(time.RFC3339)
	return map[string]any{
		codexUsageURL: map[string]any{
			"plan_type": "pro",
			"rate_limit": map[string]any{
				"allowed": true,
				"primary_window": map[string]any{
					"used_percent": 42.5, "limit_window_seconds": 18000,
					"reset_after_seconds": 8040, "reset_at": now.Add(2*time.Hour + 14*time.Minute).Unix(),
				},
				"secondary_window": map[string]any{
					"used_percent": 61.2, "limit_window_seconds": 604800,
					"reset_after_seconds": 367200, "reset_at": now.Add(4*24*time.Hour + 6*time.Hour).Unix(),
				},
			},
			"credits": map[string]any{"has_credits": true, "unlimited": false, "balance": "48.25"},
		},
		codexResetCreditsURL: map[string]any{
			"available_count": 2,
			"credits": []map[string]any{
				{"id": "credit-01", "status": "available", "reset_type": "monthly", "granted_at": now.Add(-9 * 24 * time.Hour).Format(time.RFC3339), "expires_at": now.Add(21 * 24 * time.Hour).Format(time.RFC3339)},
				{"id": "credit-02", "status": "available", "reset_type": "promotional", "granted_at": now.Add(-2 * 24 * time.Hour).Format(time.RFC3339), "expires_at": now.Add(28 * 24 * time.Hour).Format(time.RFC3339)},
			},
		},
		codexSubscriptionURL: map[string]any{
			"plan_type":     "pro",
			"active_start":  now.Add(-21 * 24 * time.Hour).UTC().Format(time.RFC3339),
			"active_until":  now.Add(21 * 24 * time.Hour).UTC().Format(time.RFC3339),
			"will_renew":    true,
			"is_delinquent": false,
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
		// The credits document is the subscription's own window and the ledger beside it is the
		// account's metered spending. They are two reads on one path, and only the credits one
		// publishes a percentage for a subscription account.
		xaiCreditsURL: map[string]any{
			"config": map[string]any{
				"creditUsagePercent": 28.5,
				"currentPeriod":      map[string]any{"type": "USAGE_PERIOD_TYPE_WEEKLY", "start": creditsPeriodStart, "end": weeklyReset},
				"productUsage": []map[string]any{
					{"product": "grok-4", "usagePercent": 31.2},
					{"product": "grok-4-fast", "usagePercent": 14.8},
				},
			},
		},
		xaiUsageURL: map[string]any{
			"config": map[string]any{
				"monthlyLimit": map[string]any{"val": 20000},
				"used":         map[string]any{"val": 5700},
			},
		},
		xaiSubscriptionURL:         map[string]any{"subscriptionTier": "SUPERGROK"},
		xaiSettingsURL:             map[string]any{"subscription_tier_display": "SuperGrok"},
		antigravitySubscriptionURL: map[string]any{"currentTier": map[string]any{"id": "free-tier"}, "paidTier": map[string]any{"id": "g1-pro-tier"}},
		metaUsageURL:               map[string]any{"subs_tier_name": "Muse Pro", "is_subs_active": true, "subs_usage": map[string]any{"window": map[string]any{"used_percent": 28, "window_duration_mins": 300, "resets_at": now.Add(3 * time.Hour).Unix()}, "weekly": map[string]any{"used_percent": 46, "resets_at": now.Add(4 * 24 * time.Hour).Unix()}}},
		antigravityUsageURL: map[string]any{
			"groups": []map[string]any{{
				"displayName": "Gemini models",
				"buckets": []map[string]any{{
					"bucketId": "gemini-shared", "displayName": "Five Hour Limit",
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
		codexUsageURL, codexResetCreditsURL, codexSubscriptionURL, claudeUsageURL, claudeProfileURL,
		kimiUsageURL, xaiUsageURL, xaiCreditsURL, antigravityUsageURL, devinUsageURL,
		xaiSubscriptionURL, xaiSettingsURL, antigravitySubscriptionURL, metaUsageURL,
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
	codexSubscriptionURL = "https://chatgpt.com/backend-api/subscriptions"
	claudeUsageURL       = "https://api.anthropic.com/api/oauth/usage"
	claudeProfileURL     = "https://api.anthropic.com/api/oauth/profile"
	kimiUsageURL         = "https://api.kimi.com/coding/v1/usages"
	// The monthly billing read is the first one the quota service tries for xAI, so
	// it is the one that has to answer; the paid-account probe behind it is never
	// reached once this succeeds.
	xaiSubscriptionURL         = "https://cli-chat-proxy.grok.com/v1/user"
	xaiSettingsURL             = "https://cli-chat-proxy.grok.com/v1/settings"
	antigravitySubscriptionURL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
	metaUsageURL               = "https://api.meta.ai/muse-code/key"
	xaiUsageURL                = "https://cli-chat-proxy.grok.com/v1/billing"
	// The credits document shares the ledger's path and is told apart by its query, which is why the
	// catalogue may name an endpoint with one.
	xaiCreditsURL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits"
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
				"auth-index": compatibilityAuthIndex(provider.prefix, index+1),
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

// channelModelDefinitions is the catalog an OAuth channel is served from: every
// model its credentials list, and the ones the channel's exclusion rules name,
// because an excluded model is in the catalog and absent from the credentials.
func channelModelDefinitions(channel string) []map[string]any {
	models := []map[string]any{}
	seen := map[string]bool{}
	add := func(model string) {
		if seen[model] || strings.Contains(model, "*") {
			return
		}
		seen[model] = true
		models = append(models, map[string]any{"id": model, "display_name": displayNameForModel(model)})
	}
	for _, item := range credentialCatalog() {
		if item.provider != channel || item.accountType != "oauth" {
			continue
		}
		for _, model := range item.models {
			add(model)
		}
	}
	if len(models) == 0 {
		return models
	}
	if rules, ok := oauthExcludedModels()[channel].([]string); ok {
		for _, rule := range rules {
			add(rule)
		}
	}
	return models
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
