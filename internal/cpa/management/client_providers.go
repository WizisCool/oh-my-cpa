package management

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
)

func (c *Client) OpenAICompatibility(ctx context.Context) (OpenAICompatibilityResponse, error) {
	var response OpenAICompatibilityResponse
	if _, err := c.getV0JSON(ctx, "/openai-compatibility", &response); err != nil {
		return OpenAICompatibilityResponse{}, err
	}
	return response, nil
}

// CLIENT_KEYS_PATH is where v8 keeps the client authentication keys.
var CLIENT_KEYS_PATH = []string{"access", "api-keys"}

// ClientAPIKeys reads the client authentication keys from the v8 view.
func (c *Client) ClientAPIKeys(ctx context.Context) ([]string, error) {
	view, _, err := c.ConfigView(ctx)
	if err != nil {
		return nil, err
	}
	value, _ := ValueAt(view, CLIENT_KEYS_PATH)
	items, _ := value.([]any)
	keys := make([]string, 0, len(items))
	for _, item := range items {
		if key, ok := item.(string); ok {
			keys = append(keys, key)
		}
	}
	return keys, nil
}

// UpdateClientAPIKeys replaces the client authentication keys.
func (c *Client) UpdateClientAPIKeys(ctx context.Context, keys []string) error {
	if keys == nil {
		keys = []string{}
	}
	return c.ApplyConfigChanges(WithBackupReason(ctx, BackupReasonClientKeys), []ConfigChange{{Path: CLIENT_KEYS_PATH, Value: keys}})
}

type OpenAICompatibilityResponse struct {
	Entries []OpenAICompatibility `json:"openai-compatibility"`
}

type OpenAICompatibility struct {
	Name           string            `json:"name"`
	Disabled       bool              `json:"disabled"`
	Prefix         string            `json:"prefix,omitempty"`
	Priority       *int              `json:"priority,omitempty"`
	DisableCooling *bool             `json:"disable-cooling,omitempty"`
	BaseURL        string            `json:"base-url"`
	APIKeyEntries  []APIKeyEntry     `json:"api-key-entries,omitempty"`
	LegacyAPIKeys  []string          `json:"api-keys,omitempty"`
	Models         []ModelAlias      `json:"models,omitempty"`
	Headers        map[string]string `json:"headers,omitempty"`
	// RequestRetry overrides the global retry count. CPA reads nil or a negative
	// value as "use the global setting" and 0 as "no additional retry rounds".
	RequestRetry          *int                     `json:"request-retry,omitempty"`
	RequestScopedErrors   []RequestScopedErrorRule `json:"request-scoped-errors,omitempty"`
	SupportPromptCacheKey bool                     `json:"support-prompt-cache-key,omitempty"`

	// extra keeps the settings the console does not model through a whole-list
	// write.
	extra wireExtras
}

// RequestScopedErrorRule tells CPA how to treat one class of upstream error for
// the request that hit it. A rule applies only when its status is positive, at
// least one of its patterns is non-empty and its action is one CPA knows; CPA
// skips any other rule without reporting it.
type RequestScopedErrorRule struct {
	Status int      `json:"status,omitempty"`
	Match  []string `json:"match,omitempty"`
	// The wire name is CPA's own spelling.
	MatchRegex []string `json:"match-regexr,omitempty"`
	Action     string   `json:"action,omitempty"`

	extra wireExtras
}

type requestScopedErrorRuleFields RequestScopedErrorRule

var requestScopedErrorRuleModelledFields = modelledWireFields(reflect.TypeOf(requestScopedErrorRuleFields{}))

func (r *RequestScopedErrorRule) UnmarshalJSON(data []byte) error {
	var fields requestScopedErrorRuleFields
	extra, err := decodeWithExtras(data, &fields, requestScopedErrorRuleModelledFields)
	if err != nil {
		return err
	}
	*r = RequestScopedErrorRule(fields)
	r.extra = extra
	return nil
}

func (r RequestScopedErrorRule) MarshalJSON() ([]byte, error) {
	return encodeWithExtras(requestScopedErrorRuleFields(r), r.extra)
}

// IsSameRule reports whether two rules agree on every setting the console
// edits, so an unchanged rule can keep the settings it does not.
func (r RequestScopedErrorRule) IsSameRule(other RequestScopedErrorRule) bool {
	return r.Status == other.Status && r.Action == other.Action &&
		slices.Equal(r.Match, other.Match) && slices.Equal(r.MatchRegex, other.MatchRegex)
}

type openAICompatibilityFields OpenAICompatibility

var openAICompatibilityModelledFields = modelledWireFields(reflect.TypeOf(openAICompatibilityFields{}))

func (o *OpenAICompatibility) UnmarshalJSON(data []byte) error {
	var fields openAICompatibilityFields
	extra, err := decodeWithExtras(data, &fields, openAICompatibilityModelledFields)
	if err != nil {
		return err
	}
	*o = OpenAICompatibility(fields)
	o.extra = extra
	return nil
}

func (o OpenAICompatibility) MarshalJSON() ([]byte, error) {
	return encodeWithExtras(openAICompatibilityFields(o), o.extra)
}

// OpenAICompatibilityLabelPrefix is what CPA puts in front of a compatibility
// provider's own name when it labels a usage record that provider served, so a
// provider called "Cline Pass" labels its requests `openai-compatible-cline pass`.
//
// It is declared here, beside the configuration it is derived from, because several
// layers have to agree on it: the dashboard's provider grouping, the request list's
// resolution of which key answered, and any fixture that stands in for a gateway.
// A divergence between them would not fail loudly - it would silently stop matching.
const OpenAICompatibilityLabelPrefix = "openai-compatible-"

type APIKeyEntry struct {
	APIKey    string `json:"api-key"`
	AuthIndex string `json:"auth-index,omitempty"`
	ProxyURL  string `json:"proxy-url,omitempty"`
	Weight    *int   `json:"weight,omitempty"`

	extra wireExtras
}

type apiKeyEntryFields APIKeyEntry

var apiKeyEntryModelledFields = modelledWireFields(reflect.TypeOf(apiKeyEntryFields{}))

func (e *APIKeyEntry) UnmarshalJSON(data []byte) error {
	var fields apiKeyEntryFields
	extra, err := decodeWithExtras(data, &fields, apiKeyEntryModelledFields)
	if err != nil {
		return err
	}
	*e = APIKeyEntry(fields)
	e.extra = extra
	return nil
}

func (e APIKeyEntry) MarshalJSON() ([]byte, error) {
	return encodeWithExtras(apiKeyEntryFields(e), e.extra)
}

type ThinkingSupport struct {
	Min            int      `json:"min,omitempty"`
	Max            int      `json:"max,omitempty"`
	ZeroAllowed    bool     `json:"zero_allowed,omitempty"`
	DynamicAllowed bool     `json:"dynamic_allowed,omitempty"`
	Levels         []string `json:"levels,omitempty"`
}

type ModelAlias struct {
	Name             string           `json:"name"`
	Alias            string           `json:"alias,omitempty"`
	DisplayName      string           `json:"display-name,omitempty"`
	Image            bool             `json:"image,omitempty"`
	MaxContextLength int              `json:"max-context-length,omitempty"`
	ForceMapping     bool             `json:"force-mapping,omitempty"`
	IsCompat         bool             `json:"is-compat,omitempty"`
	Thinking         *ThinkingSupport `json:"thinking,omitempty"`
	// The settings below exist on some families' entries only (the first on
	// Codex-shaped ones, the rest on OpenAI-compatible ones); CPA refuses a
	// configuration that states one elsewhere.
	SupportConfigurationUpdate bool     `json:"support-configuration-update,omitempty"`
	InputModalities            []string `json:"input-modalities,omitempty"`
	OutputModalities           []string `json:"output-modalities,omitempty"`
	UseMaxCompletionTokens     bool     `json:"use-max-completion-tokens,omitempty"`

	// extra keeps the settings of a model this struct does not declare, which
	// every provider write sends back for every model of the family.
	extra wireExtras
}

type modelAliasFields ModelAlias

var modelAliasModelledFields = modelledWireFields(reflect.TypeOf(modelAliasFields{}))

func (m *ModelAlias) UnmarshalJSON(data []byte) error {
	var fields modelAliasFields
	extra, err := decodeWithExtras(data, &fields, modelAliasModelledFields)
	if err != nil {
		return err
	}
	*m = ModelAlias(fields)
	m.extra = extra
	return nil
}

func (m ModelAlias) MarshalJSON() ([]byte, error) {
	return encodeWithExtras(modelAliasFields(m), m.extra)
}

// WithUnmodelledFieldsOf returns the model carrying another's unmodelled
// settings, for an edit that restates every modelled field of a stored model.
func (m ModelAlias) WithUnmodelledFieldsOf(stored ModelAlias) ModelAlias {
	m.extra = stored.extra
	return m
}

// ConfiguredModelRoute keeps the configured upstream identity separate from its client label.
type ConfiguredModelRoute struct {
	UpstreamModel string
	CallPoint     string
}

func configuredModelRoutes(models []ModelAlias, prefix string) []ConfiguredModelRoute {
	routes := make([]ConfiguredModelRoute, 0, len(models))
	for _, model := range models {
		name := strings.TrimSpace(model.Name)
		if name == "" {
			continue
		}
		callPoint := strings.TrimSpace(model.Alias)
		if callPoint == "" {
			callPoint = name
		}
		if prefix != "" {
			callPoint = strings.TrimSuffix(prefix, "/") + "/" + callPoint
		}
		routes = append(routes, ConfiguredModelRoute{UpstreamModel: name, CallPoint: callPoint})
	}
	return routes
}

// ConfiguredModelProvider is non-secret provenance captured alongside the model directory.
type ConfiguredModelProvider struct {
	EndpointHost   string
	ID             string
	Family         string
	Name           string
	Prefix         string
	Channel        string
	Priority       int
	IsOAuth        bool
	Models         []string
	Routes         []ConfiguredModelRoute
	ExcludedModels []string
}

// Only the hostname is needed to reuse provider icon inference; URL credentials,
// paths and query parameters never belong in pricing identity metadata.
func pricingEndpointHost(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return ""
	}
	return parsed.Hostname()
}

type ConfiguredModelSnapshot struct {
	Models    map[string]string
	Providers []ConfiguredModelProvider
}

func (c *Client) ListConfiguredModelCatalog(ctx context.Context) (map[string]string, error) {
	snapshot, err := c.ListConfiguredModelSnapshot(ctx)
	return snapshot.Models, err
}

// ListConfiguredModelSnapshot reads membership in the same sweep as aliases so
// console reads never need to fan out across individual credentials.
func (c *Client) ListConfiguredModelSnapshot(ctx context.Context) (ConfiguredModelSnapshot, error) {
	if c == nil {
		return ConfiguredModelSnapshot{}, errors.New("CPA client is not initialized")
	}
	providers := make(map[string]*ConfiguredModelProvider)
	addProvider := func(provider ConfiguredModelProvider, models []string) {
		current := providers[provider.ID]
		if current == nil {
			providerCopy := provider
			current = &providerCopy
			current.Models = nil
			current.Routes = nil
			providers[provider.ID] = current
		}
		current.Routes = append(current.Routes, provider.Routes...)
		if provider.Priority > current.Priority {
			current.Priority = provider.Priority
		}
		for _, model := range models {
			if model = strings.TrimSpace(model); model != "" {
				current.Models = append(current.Models, model)
			}
		}
	}
	priorityOf := func(priority *int) int {
		if priority == nil {
			return 0
		}
		return *priority
	}
	modelSet := make(map[string]string)
	add := func(id, target string) {
		id = strings.TrimSpace(id)
		target = strings.TrimSpace(target)
		if id == "" {
			return
		}
		if old, ok := modelSet[id]; ok && old != target {
			modelSet[id] = ""
		} else if !ok {
			modelSet[id] = target
		}
	}
	var errs []error

	if authResp, err := c.AuthFiles(ctx); err != nil {
		errs = append(errs, fmt.Errorf("auth-files: %w", err))
	} else {
		// Auth-files commonly omits its models. Resolve missing lists in waves
		// of at most four, not one HTTP call per card/render or unbounded fanout.
		resolved := make([][]AuthModel, len(authResp.Files))
		failures := make([]error, len(authResp.Files))
		for start := 0; start < len(authResp.Files); start += 4 {
			var wg sync.WaitGroup
			for i := start; i < min(start+4, len(authResp.Files)); i++ {
				file := authResp.Files[i]
				if file.Disabled {
					continue
				}
				if len(file.Models) > 0 {
					resolved[i] = file.Models
					continue
				}
				if file.Name == "" {
					failures[i] = errors.New("auth file is missing its model identity")
					continue
				}
				wg.Add(1)
				go func(i int, name string) {
					defer wg.Done()
					models, err := c.AuthFileModels(ctx, name)
					if err != nil {
						// Named here rather than at the aggregate, because this is the only
						// place the file the failure belongs to is still in hand.
						failures[i] = fmt.Errorf("auth-file %q models: %w", name, err)
						return
					}
					resolved[i] = models
				}(i, file.Name)
			}
			wg.Wait()
		}
		for i, models := range resolved {
			if failures[i] != nil {
				errs = append(errs, failures[i])
				continue
			}
			file := authResp.Files[i]
			family := strings.ToLower(strings.TrimSpace(file.Provider))
			if family == "" {
				family = strings.ToLower(strings.TrimSpace(file.Type))
			}
			if family == "" {
				family = "unknown"
			}
			identities := make([]string, 0, len(models))
			for _, m := range models {
				add(m.ID, m.ID)
				identities = append(identities, m.ID)
			}
			if !file.Disabled {
				addProvider(ConfiguredModelProvider{ID: "oauth:" + family, Family: family, Name: family, Channel: family, Priority: file.Priority, IsOAuth: true}, identities)
			}
		}
	}

	// Every config API-key family contributes its models the same way, so the
	// families are walked rather than repeated. A family CPA cannot answer for
	// is reported per family, which keeps a newly added credential list from
	// silently disappearing out of the catalog.
	for _, family := range ConfigKeyFamilies {
		entries, err := c.ConfigAPIKeys(ctx, family)
		if err != nil {
			// A family an older CPA release does not have is not a catalog failure.
			if !IsMissingCapability(err) {
				errs = append(errs, fmt.Errorf("%s: %w", family, err))
			}
			continue
		}
		for entryIndex, entry := range entries {
			if IsExcludedAll(entry.ExcludedModels) {
				continue
			}
			identities := make([]string, 0, len(entry.Models)*2)
			for _, model := range entry.Models {
				identities = append(identities, model.Name, model.Alias)
			}
			addProvider(ConfiguredModelProvider{ID: fmt.Sprintf("%s-%d", family, entryIndex), Family: string(family), Prefix: entry.Prefix, EndpointHost: pricingEndpointHost(entry.BaseURL), Channel: string(family), Priority: priorityOf(entry.Priority), Routes: configuredModelRoutes(entry.Models, entry.Prefix), ExcludedModels: entry.ExcludedModels}, identities)
			for _, m := range entry.Models {
				name := strings.TrimSpace(m.Name)
				if name != "" {
					add(name, name)
				}
				alias := strings.TrimSpace(m.Alias)
				if alias != "" {
					add(alias, name)
				}
			}
		}
	}

	if oaiResp, err := c.OpenAICompatibility(ctx); err != nil {
		errs = append(errs, fmt.Errorf("openai-compatibility: %w", err))
	} else {
		for entryIndex, entry := range oaiResp.Entries {
			if entry.Disabled {
				continue
			}
			identities := make([]string, 0, len(entry.Models)*2)
			for _, model := range entry.Models {
				identities = append(identities, model.Name, model.Alias)
			}
			addProvider(ConfiguredModelProvider{ID: fmt.Sprintf("openai-compat-%d", entryIndex), Family: "openai-compatibility", Name: entry.Name, Prefix: entry.Prefix, EndpointHost: pricingEndpointHost(entry.BaseURL), Channel: OpenAICompatibilityLabelPrefix + strings.ToLower(entry.Name), Priority: priorityOf(entry.Priority), Routes: configuredModelRoutes(entry.Models, entry.Prefix)}, identities)
			for _, m := range entry.Models {
				name := strings.TrimSpace(m.Name)
				if name != "" {
					add(name, name)
				}
				alias := strings.TrimSpace(m.Alias)
				if alias != "" {
					add(alias, name)
				}
			}
		}
	}

	if len(errs) > 0 {
		// Refused whole rather than published partially: the pricing service
		// replaces its model table from this snapshot, so a catalog missing every
		// provider that failed to read would prune the rates of models that are
		// still configured (see pricing.Service.refreshModels).
		return ConfiguredModelSnapshot{}, &catalogError{failures: errs}
	}

	snapshot := ConfiguredModelSnapshot{Models: modelSet, Providers: make([]ConfiguredModelProvider, 0, len(providers))}
	for _, provider := range providers {
		sort.Strings(provider.Models)
		provider.Models = slices.Compact(provider.Models)
		if provider.Models == nil {
			provider.Models = []string{}
		}
		snapshot.Providers = append(snapshot.Providers, *provider)
	}
	sort.Slice(snapshot.Providers, func(i, j int) bool { return snapshot.Providers[i].ID < snapshot.Providers[j].ID })
	return snapshot, nil
}

// catalogError aggregates the failures of one catalog read.
//
// It exists so the message stays on a single line - this text is persisted as the
// pricing sync's last error and rendered in a one-line telemetry strip, where a
// list of sources run together reads as one sentence - while `Unwrap() []error`
// still lets `errors.Is` and `errors.As` reach the original failures. That is what
// lets a caller tell a gateway that does not have the endpoint apart from one that
// failed to answer (`IsMissingCapability`), which an aggregated string cannot
// express however carefully it is formatted.
type catalogError struct {
	failures []error
}

func (e *catalogError) Error() string {
	messages := make([]string, 0, len(e.failures))
	for _, failure := range e.failures {
		messages = append(messages, failure.Error())
	}
	return "incomplete CPA model catalog: " + strings.Join(messages, "; ")
}

func (e *catalogError) Unwrap() []error { return e.failures }

// ListAllConfiguredModels is the ID-only view of the authoritative catalog.
func (c *Client) ListAllConfiguredModels(ctx context.Context) ([]string, error) {
	models, err := c.ListConfiguredModelCatalog(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(models))
	for m := range models {
		result = append(result, m)
	}
	sort.Strings(result)
	return result, nil
}
