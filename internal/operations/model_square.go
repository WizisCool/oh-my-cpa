package operations

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/modelcatalog"
)

type ModelSquareRoute struct {
	ProviderID    string `json:"provider_id"`
	UpstreamModel string `json:"upstream_model"`
	CallPoint     string `json:"call_point"`
}
type ModelSquareProvider struct {
	ID           string `json:"id"`
	Family       string `json:"family"`
	Name         string `json:"name"`
	EndpointHost string `json:"endpoint_host,omitempty"`
	IsOAuth      bool   `json:"is_oauth"`
	IconID       string `json:"icon_id,omitempty"`
}

var ErrClientKeyRequired = errors.New("client_key_required")

type ModelSquareQuery struct{}
type ModelSquareDirectory struct {
	ModelInfo         map[string]modelcatalog.Model `json:"model_info"`
	MetadataUpdatedAt string                        `json:"metadata_updated_at"`
	Models            []gateway.Model               `json:"models"`

	Providers []ModelSquareProvider `json:"providers"`
	Routes    []ModelSquareRoute    `json:"routes"`
	Partial   []string              `json:"partial"`
}

// ProjectModelSquare does not use the pricing alias map: an alias with several targets
// must retain every route here, rather than becoming the pricing ambiguity sentinel.
func ProjectModelSquare(snapshot management.ConfiguredModelSnapshot, aliases map[string][]management.OAuthModelAlias, hasAliases bool) ModelSquareDirectory {
	directory := ModelSquareDirectory{Providers: []ModelSquareProvider{}, Routes: []ModelSquareRoute{}, Partial: []string{}}
	if !hasAliases {
		directory.Partial = append(directory.Partial, "oauth_aliases")
	}
	seen := map[ModelSquareRoute]bool{}
	addRoute := func(route ModelSquareRoute) {
		if route.CallPoint != "" && !seen[route] {
			directory.Routes = append(directory.Routes, route)
			seen[route] = true
		}
	}
	for _, provider := range snapshot.Providers {
		directory.Providers = append(directory.Providers, ModelSquareProvider{ID: provider.ID, Family: provider.Family, Name: provider.Name, EndpointHost: provider.EndpointHost, IsOAuth: provider.IsOAuth})
		if !provider.IsOAuth {
			for _, route := range provider.Routes {
				if isModelExcluded(route.UpstreamModel, provider.ExcludedModels) {
					continue
				}
				addRoute(ModelSquareRoute{provider.ID, route.UpstreamModel, route.CallPoint})
			}
			continue
		}
		for _, model := range provider.Models {
			// CPA's OAuth directory is already alias/exclusion-aware. Only invert a mapping
			// that actually appears there; fabricating a native call point would bypass fork semantics.
			targets := []string{}
			if hasAliases {
				for _, alias := range aliases[provider.Family] {
					if strings.EqualFold(alias.Alias, model) {
						targets = append(targets, alias.Name)
					}
				}
				if len(targets) == 0 {
					targets = append(targets, model)
				}
			} else {
				targets = append(targets, "")
			}
			for _, target := range targets {
				addRoute(ModelSquareRoute{provider.ID, target, model})
			}
		}
	}
	sort.Slice(directory.Routes, func(left, right int) bool {
		first, second := directory.Routes[left], directory.Routes[right]
		if first.CallPoint != second.CallPoint {
			return first.CallPoint < second.CallPoint
		}
		if first.UpstreamModel != second.UpstreamModel {
			return first.UpstreamModel < second.UpstreamModel
		}
		return first.ProviderID < second.ProviderID
	})
	return directory
}

func (s *Service) ListModelSquare(ctx context.Context, input ModelSquareQuery) (ModelSquareDirectory, error) {
	client, err := s.Client(ctx)
	if err != nil {
		return ModelSquareDirectory{}, err
	}
	keys, err := client.ClientAPIKeys(ctx)
	if err != nil {
		return ModelSquareDirectory{}, err
	}
	selectedKey := ""
	for _, key := range keys {
		if key = strings.TrimSpace(key); key != "" {
			selectedKey = key
			break
		}
	}
	if selectedKey == "" {
		return ModelSquareDirectory{}, ErrClientKeyRequired
	}
	inference, err := gateway.NewClient(client.BaseURL(), selectedKey, s.TLSSkipVerify)
	if err != nil {
		return ModelSquareDirectory{}, err
	}
	advertised, err := inference.ListModels(ctx)
	if err != nil {
		return ModelSquareDirectory{}, err
	}
	snapshot, snapshotErr := client.ListConfiguredModelSnapshot(ctx)
	if snapshotErr != nil {
		snapshot = management.ConfiguredModelSnapshot{}
	}
	// A native API-key entry may rely on CPA's built-in catalog rather than listing
	// every model in configuration. Resolve only those configured families, never the
	// OpenRouter universe, and apply that entry's exclusions before publishing routes.
	hasMissingModels := false
	definitions := map[string][]management.AuthModel{}
	for index := range snapshot.Providers {
		provider := &snapshot.Providers[index]
		if provider.IsOAuth || len(provider.Routes) > 0 {
			continue
		}
		if provider.Family == "openai-compatibility" {
			hasMissingModels = true
			continue
		}
		models, hasDefinitions := definitions[provider.Family]
		if !hasDefinitions {
			models, err = client.StaticModelDefinitions(ctx, provider.Family)
			if err != nil {
				models = nil
			}
			definitions[provider.Family] = models
		}
		if models == nil {
			hasMissingModels = true
			continue
		}
		for _, model := range models {
			if isModelExcluded(model.ID, provider.ExcludedModels) {
				continue
			}
			callPoint := model.ID
			if provider.Prefix != "" {
				callPoint = strings.TrimSuffix(provider.Prefix, "/") + "/" + callPoint
			}
			provider.Routes = append(provider.Routes, management.ConfiguredModelRoute{UpstreamModel: model.ID, CallPoint: callPoint})
		}
	}
	aliases, aliasErr := client.OAuthModelAliases(ctx)
	directory := ProjectModelSquare(snapshot, aliases, aliasErr == nil)
	if snapshotErr != nil {
		directory.Partial = append(directory.Partial, "routes")
	}
	directory = RetainAdvertisedModels(directory, advertised)
	identities := []string{}
	for _, route := range directory.Routes {
		identity := route.UpstreamModel
		if identity == "" {
			identity = route.CallPoint
		}
		identities = append(identities, identity)
	}
	directory.ModelInfo = modelcatalog.DEFAULT_CATALOG.Select(identities)
	directory.MetadataUpdatedAt = modelcatalog.DEFAULT_CATALOG.UpdatedAt
	if hasMissingModels {
		directory.Partial = append(directory.Partial, "provider_models")
	}
	if s.Repo != nil {
		names := map[string]string{}
		icons := map[string]string{}
		if raw, _, readErr := s.Repo.GetPreference(ctx, "provider_names"); readErr == nil {
			_ = json.Unmarshal([]byte(raw), &names)
		}
		if raw, _, readErr := s.Repo.GetPreference(ctx, "provider_icons"); readErr == nil {
			_ = json.Unmarshal([]byte(raw), &icons)
		}
		for index := range directory.Providers {
			provider := &directory.Providers[index]
			if name := names[provider.ID]; name != "" {
				provider.Name = name
			}
			if provider.Name == "" {
				provider.Name = provider.Family
			}
			provider.IconID = icons[provider.ID]
		}
	}
	return directory, nil
}

// RetainAdvertisedModels makes /v1/models authoritative. Static configuration only
// enriches identities that the gateway actually published for this client key.
func RetainAdvertisedModels(directory ModelSquareDirectory, advertised []gateway.Model) ModelSquareDirectory {
	directory.Models = advertised
	directory.Routes = append([]ModelSquareRoute{}, directory.Routes...)
	allowed := map[string]bool{}
	for _, model := range advertised {
		allowed[model.ID] = true
	}
	filtered := []ModelSquareRoute{}
	represented := map[string]bool{}
	for _, route := range directory.Routes {
		if allowed[route.CallPoint] {
			filtered = append(filtered, route)
			represented[route.CallPoint] = true
		}
	}
	for _, model := range advertised {
		if !represented[model.ID] {
			filtered = append(filtered, ModelSquareRoute{CallPoint: model.ID})
		}
	}
	directory.Routes = filtered
	usedProviders := map[string]bool{}
	for _, route := range filtered {
		usedProviders[route.ProviderID] = true
	}
	providers := []ModelSquareProvider{}
	for _, provider := range directory.Providers {
		if usedProviders[provider.ID] {
			providers = append(providers, provider)
		}
	}
	directory.Providers = providers
	return directory
}

func isModelExcluded(model string, patterns []string) bool {
	for _, pattern := range patterns {
		expression := "(?i)^" + strings.ReplaceAll(regexp.QuoteMeta(strings.TrimSpace(pattern)), `\*`, ".*") + "$"
		if matches, _ := regexp.MatchString(expression, model); matches {
			return true
		}
	}
	return false
}

func (s *Service) registerModelSquare(registry *capability.Registry) error {
	return read(registry, "models_list", "List models advertised by CPA /v1/models for an existing client key, with configured route provenance when known. Defaults to the first configured client key. Empty upstream_model or provider_id means unresolved provenance. Includes bundled models.dev reference metadata; it never establishes availability. No inference or credential disclosure.", func(ctx context.Context, input ModelSquareQuery) (ModelSquareDirectory, error) {
		directory, err := s.ListModelSquare(ctx, input)
		if len(directory.Routes) > 2000 {
			return ModelSquareDirectory{}, errors.New("tool_result_too_large")
		}
		return directory, err
	})
}
