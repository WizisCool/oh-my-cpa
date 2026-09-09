package pricing

import (
	"strings"
)

// Model family → official catalog provider id. Keeper's ranking insight: when
// several providers list the same model, the first-party provider entry is the
// right default estimate; relays and aggregates are fallbacks.
var providerFamilies = map[string]string{
	"claude": "anthropic", "gemini": "google", "gpt": "openai", "chatgpt": "openai",
	"o1": "openai", "o3": "openai", "o4": "openai", "deepseek": "deepseek",
	"glm": "zhipu", "qwen": "qwen", "grok": "xai", "llama": "meta",
	"mistral": "mistral", "kimi": "moonshot", "minimax": "minimax",
	"doubao": "bytedance", "ernie": "baidu",
}

// NormalizeModelKey lowercases and removes whitespace so trivial formatting
// differences (CPA prefixes aside) cannot hide an identical model identity.
func NormalizeModelKey(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		if r == ' ' || r == '\t' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// StripProviderPrefix keeps the part after the last "/" — CPA often routes
// "openai/gpt-5" style names while models.dev lists "gpt-5".
func StripProviderPrefix(value string) string {
	if idx := strings.LastIndex(value, "/"); idx >= 0 {
		return value[idx+1:]
	}
	return value
}

type catalogIndex struct {
	byKey map[string][]CatalogEntry
}

func buildCatalogIndex(entries []CatalogEntry) catalogIndex {
	index := catalogIndex{byKey: make(map[string][]CatalogEntry, len(entries)*3)}
	add := func(key string, entry CatalogEntry) {
		if key == "" {
			return
		}
		index.byKey[key] = append(index.byKey[key], entry)
	}
	for _, entry := range entries {
		id, name := entry.Model.ID, entry.Model.Name
		add(id, entry)
		add(name, entry)
		add(StripProviderPrefix(id), entry)
		add(StripProviderPrefix(name), entry)
		add(NormalizeModelKey(id), entry)
		add(NormalizeModelKey(name), entry)
		add(NormalizeModelKey(StripProviderPrefix(id)), entry)
		add(NormalizeModelKey(StripProviderPrefix(name)), entry)
	}
	return index
}

func providerRank(model, providerID string) int {
	identity := NormalizeModelKey(StripProviderPrefix(model))
	provider := strings.ToLower(strings.TrimSpace(providerID))
	for prefix, family := range providerFamilies {
		if strings.HasPrefix(identity, prefix) && provider == family {
			return 0
		}
	}
	if idx := strings.Index(model, "/"); idx > 0 && strings.EqualFold(model[:idx], provider) {
		return 0
	}
	return 1
}

// MatchModel resolves one strong catalog identity for a model. Multiple
// same-rank candidates are ambiguous and return nothing: auto sync never
// guesses between providers, it leaves the model unpriced for manual setup.
func (c Catalog) MatchModel(model string) *CatalogEntry {
	model = strings.TrimSpace(model)
	if model == "" {
		return nil
	}
	index := buildCatalogIndex(c.Entries)
	suffix := StripProviderPrefix(model)
	for _, key := range []string{model, NormalizeModelKey(model), suffix, NormalizeModelKey(suffix)} {
		candidates := uniqueEntries(index.byKey[key])
		if len(candidates) == 0 {
			continue
		}
		var winner *CatalogEntry
		bestRank := 2
		count := 0
		for i := range candidates {
			rank := providerRank(model, candidates[i].ProviderID)
			if rank < bestRank {
				bestRank, winner, count = rank, &candidates[i], 1
				continue
			}
			if rank == bestRank {
				count++
			}
		}
		if winner != nil && count == 1 {
			return winner
		}
	}
	return nil
}

func uniqueEntries(entries []CatalogEntry) []CatalogEntry {
	seen := make(map[string]struct{}, len(entries))
	result := make([]CatalogEntry, 0, len(entries))
	for _, entry := range entries {
		key := entry.ProviderID + "\x00" + entry.Model.ID
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, entry)
	}
	return result
}
