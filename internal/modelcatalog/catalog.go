// Package modelcatalog supplies offline reference metadata, never routing authority.
package modelcatalog

import (
	"embed"
	"encoding/json"
	"net/url"
	"strings"
)

//go:embed snapshot.json
var bundledSnapshot embed.FS

type Link struct {
	Label string `json:"label"`
	URL   string `json:"url"`
	Type  string `json:"type,omitempty"`
}
type Limits struct {
	Context int64 `json:"context,omitempty"`
	Input   int64 `json:"input,omitempty"`
	Output  int64 `json:"output,omitempty"`
}
type Modalities struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}
type Model struct {
	ID               string     `json:"id"`
	Name             string     `json:"name"`
	Description      string     `json:"description,omitempty"`
	Family           string     `json:"family,omitempty"`
	OpenWeights      *bool      `json:"open_weights,omitempty"`
	Reasoning        *bool      `json:"reasoning,omitempty"`
	ToolCall         *bool      `json:"tool_call,omitempty"`
	StructuredOutput *bool      `json:"structured_output,omitempty"`
	Attachment       *bool      `json:"attachment,omitempty"`
	Temperature      *bool      `json:"temperature,omitempty"`
	Knowledge        string     `json:"knowledge,omitempty"`
	ReleaseDate      string     `json:"release_date,omitempty"`
	LastUpdated      string     `json:"last_updated,omitempty"`
	License          string     `json:"license,omitempty"`
	Limit            Limits     `json:"limit"`
	Modalities       Modalities `json:"modalities"`
	Weights          []Link     `json:"weights,omitempty"`
	Links            []Link     `json:"links,omitempty"`
}

// ReferenceCost is one rate a set of models.dev providers list for a canonical model, in USD
// per million tokens. An absent cache rate was not listed; it is not zero.
type ReferenceCost struct {
	Input      float64  `json:"input"`
	Output     float64  `json:"output"`
	CacheRead  *float64 `json:"cache_read,omitempty"`
	CacheWrite *float64 `json:"cache_write,omitempty"`
	Providers  []string `json:"providers"`
}
type Catalog struct {
	Source         string                     `json:"source"`
	UpdatedAt      string                     `json:"updated_at"`
	Models         map[string]Model           `json:"models"`
	Aliases        map[string]string          `json:"aliases"`
	ReferenceCosts map[string][]ReferenceCost `json:"reference_costs"`
}

var DEFAULT_CATALOG = readBundledCatalog()

func readBundledCatalog() Catalog {
	data, err := bundledSnapshot.ReadFile("snapshot.json")
	if err != nil {
		panic(err)
	}
	var catalog Catalog
	if err := json.Unmarshal(data, &catalog); err != nil {
		panic(err)
	}
	for id, model := range catalog.Models {
		model.Weights = retainSafeLinks(model.Weights)
		model.Links = retainSafeLinks(model.Links)
		catalog.Models[id] = model
	}
	return catalog
}

func retainSafeLinks(links []Link) []Link {
	safe := []Link{}
	for _, link := range links {
		parsed, err := url.Parse(link.URL)
		if err == nil && parsed.Scheme == "https" && parsed.Hostname() != "" && parsed.User == nil {
			safe = append(safe, link)
		}
	}
	return safe
}

// VARIANT_SUFFIXES are request variants of one model, not other models: a gateway appends a
// reasoning effort or a router tag to the name it advertises, and the specifications stay the
// base model's. The list is closed on purpose - a suffix outside it is part of the identity.
var VARIANT_SUFFIXES = []string{"-thinking", "-minimal", "-low", "-medium", "-high", "-xhigh"}

// Match resolves an identity to the source's own record for it.
//
// Evidence is always an exact canonical identity or an unambiguous source-declared alias. An
// identity that has neither is retried only in forms that name the same model: without a
// router tag (":free"), without one request-variant suffix, and without leading routing
// namespaces ("relay/model"). Every such form must itself match exactly; similar names and
// version stripping never fill specifications.
func (catalog Catalog) Match(identity string) (Model, bool) {
	for _, candidate := range matchCandidates(identity) {
		if model, exists := catalog.matchExact(candidate); exists {
			return model, true
		}
	}
	return Model{}, false
}

func (catalog Catalog) matchExact(identity string) (Model, bool) {
	if model, exists := catalog.Models[identity]; exists {
		return model, true
	}
	if canonical, exists := catalog.Aliases[identity]; exists {
		model, exists := catalog.Models[canonical]
		return model, exists
	}
	return Model{}, false
}

// matchCandidates orders the forms from most to least literal, so a name the source knows as
// written is never reinterpreted: "model-high" published as its own model keeps its own record.
func matchCandidates(identity string) []string {
	if identity == "" {
		return nil
	}
	forms := []string{identity}
	untagged := identity
	if slash, colon := strings.LastIndex(identity, "/"), strings.LastIndex(identity, ":"); colon > slash+1 && colon < len(identity)-1 {
		untagged = identity[:colon]
		forms = append(forms, untagged)
	}
	for _, suffix := range VARIANT_SUFFIXES {
		if base := strings.TrimSuffix(untagged, suffix); base != untagged && !strings.HasSuffix(base, "/") && base != "" {
			forms = append(forms, base)
			break
		}
	}
	candidates := append([]string{}, forms...)
	// Namespaces are removed only after every whole form has failed: a prefix is weaker evidence
	// than the name the gateway actually sends.
	for _, form := range forms {
		for rest := form; ; {
			slash := strings.Index(rest, "/")
			if slash < 0 || slash == len(rest)-1 {
				break
			}
			rest = rest[slash+1:]
			candidates = append(candidates, rest)
		}
	}
	return candidates
}

func (catalog Catalog) Select(identities []string) map[string]Model {
	models := map[string]Model{}
	for _, identity := range identities {
		if model, exists := catalog.Match(strings.TrimSpace(identity)); exists {
			models[identity] = model
		}
	}
	return models
}

// ReferenceCostsFor returns the rates providers list for exactly this identity: its canonical
// id or an unambiguous alias. Unlike Match it never strips a variant suffix or namespace,
// because a price is a stronger claim than a specification and similar names do not share one.
func (catalog Catalog) ReferenceCostsFor(identity string) (string, []ReferenceCost) {
	model, exists := catalog.matchExact(strings.TrimSpace(identity))
	if !exists || len(catalog.ReferenceCosts[model.ID]) == 0 {
		return "", nil
	}
	return model.ID, catalog.ReferenceCosts[model.ID]
}
