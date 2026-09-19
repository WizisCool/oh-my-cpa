package management

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
)

func (c *Client) OpenAICompatibility(ctx context.Context) (OpenAICompatibilityResponse, error) {
	var response OpenAICompatibilityResponse
	if err := c.DoJSON(ctx, http.MethodGet, "/openai-compatibility", &response); err != nil {
		return OpenAICompatibilityResponse{}, err
	}
	return response, nil
}

type ClientAPIKeysResponse struct {
	APIKeys []string `json:"api-keys"`
}

func (c *Client) ClientAPIKeys(ctx context.Context) ([]string, error) {
	var response ClientAPIKeysResponse
	if err := c.DoJSON(ctx, http.MethodGet, "/api-keys", &response); err != nil {
		return nil, err
	}
	return response.APIKeys, nil
}

func (c *Client) UpdateClientAPIKeys(ctx context.Context, keys []string) error {
	if keys == nil {
		keys = []string{}
	}
	return c.doJSONBody(ctx, http.MethodPut, "/api-keys", keys, nil)
}

func (c *Client) UpdateOpenAICompatibility(ctx context.Context, entries []OpenAICompatibility) error {
	if entries == nil {
		entries = []OpenAICompatibility{}
	}
	return c.doJSONBody(ctx, http.MethodPut, "/openai-compatibility", entries, nil)
}

type OpenAICompatibilityResponse struct {
	Entries []OpenAICompatibility `json:"openai-compatibility"`
}

type OpenAICompatibility struct {
	Name           string            `json:"name"`
	Disabled       bool              `json:"disabled"`
	Prefix         string            `json:"prefix,omitempty"`
	Priority       *int              `json:"priority,omitempty"`
	DisableCooling bool              `json:"disable-cooling,omitempty"`
	BaseURL        string            `json:"base-url"`
	APIKeyEntries  []APIKeyEntry     `json:"api-key-entries,omitempty"`
	LegacyAPIKeys  []string          `json:"api-keys,omitempty"`
	Models         []ModelAlias      `json:"models,omitempty"`
	Headers        map[string]string `json:"headers,omitempty"`
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
}

// ListConfiguredModelCatalog collects every configured model across all
// providers and auth files, keeping each model's routed target so aliases can
// be resolved back to a canonical pricing identity.
func (c *Client) ListConfiguredModelCatalog(ctx context.Context) (map[string]string, error) {
	if c == nil {
		return nil, errors.New("CPA client is not initialized")
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
			for _, m := range models {
				add(m.ID, m.ID)
			}
		}
	}

	// Every config API-key family contributes its models the same way, so the
	// families are walked rather than repeated. A family CPA cannot answer for
	// is reported per family, which keeps a newly added credential list from
	// silently disappearing out of the catalog.
	for _, family := range []ConfigKeyFamily{
		ConfigFamilyCodex,
		ConfigFamilyClaude,
		ConfigFamilyGemini,
		ConfigFamilyMeta,
	} {
		entries, err := c.ConfigAPIKeys(ctx, family)
		if err != nil {
			// A family an older CPA release does not have is not a catalog failure.
			if !IsMissingCapability(err) {
				errs = append(errs, fmt.Errorf("%s: %w", family, err))
			}
			continue
		}
		for _, entry := range entries {
			if IsExcludedAll(entry.ExcludedModels) {
				continue
			}
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
		for _, entry := range oaiResp.Entries {
			if entry.Disabled {
				continue
			}
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
		return nil, &catalogError{failures: errs}
	}

	return modelSet, nil
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
