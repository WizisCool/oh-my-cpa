package pricing

import (
	"sort"
	"strings"
	"unicode"
)

// Model family → ordered first-party models.dev provider ids, most
// authoritative first. models.dev publishes relays and aggregates under their
// own provider ids (302ai, aihubmix, ...), so "the provider that shares the
// model prefix" must come from this table, not from the id. Lists verified
// against the live catalog; they follow cpa-usage-keeper's ordering.
func officialProvidersByFamily(family string) []string {
	switch family {
	case "openai":
		return []string{"openai", "azure", "azure-cognitive-services"}
	case "anthropic":
		return []string{"anthropic", "google-vertex-anthropic"}
	case "deepseek":
		return []string{"deepseek", "siliconflow-cn", "siliconflow"}
	case "glm":
		return []string{"zai", "zhipuai", "zai-coding-plan", "zhipuai-coding-plan"}
	case "qwen":
		return []string{"alibaba-cn", "alibaba", "aliyun-bailian"}
	case "google":
		return []string{"google", "google-vertex"}
	case "xai":
		return []string{"xai"}
	case "minimax":
		return []string{"minimax-cn", "minimax", "minimax-cn-coding-plan", "minimax-coding-plan"}
	case "moonshot":
		return []string{"moonshotai-cn", "moonshotai", "kimi-for-coding"}
	case "doubao":
		return []string{"doubao"}
	case "mistral":
		return []string{"mistral"}
	case "cohere":
		return []string{"cohere"}
	case "llama":
		return []string{"llama"}
	case "xiaomi":
		return []string{"xiaomi"}
	default:
		return nil
	}
}

// modelFamilyOf maps a model id prefix to a catalog family. Covers the
// manufacturer prefixes that actually appear in traffic; unknown prefixes have
// no official provider and fall back to relay ranking.
func modelFamilyOf(model string) string {
	identity := NormalizeModelKey(StripProviderPrefix(model))
	prefixes := []struct {
		prefix string
		family string
	}{
		{"gpt", "openai"}, {"chatgpt", "openai"}, {"o1", "openai"}, {"o3", "openai"}, {"o4", "openai"},
		{"claude", "anthropic"}, {"deepseek", "deepseek"}, {"glm", "glm"}, {"qwen", "qwen"},
		{"gemini", "google"}, {"grok", "xai"}, {"minimax", "minimax"}, {"moonshot", "moonshot"},
		{"kimi", "moonshot"}, {"doubao", "doubao"}, {"mimo", "xiaomi"}, {"command", "cohere"},
		{"llama", "llama"},
	}
	for _, item := range prefixes {
		if strings.HasPrefix(identity, item.prefix) {
			return item.family
		}
	}
	for _, prefix := range []string{"mistral", "devstral", "codestral", "magistral", "ministral", "mixtral", "pixtral", "voxtral"} {
		if strings.HasPrefix(identity, prefix) {
			return "mistral"
		}
	}
	return ""
}

// NormalizeModelKey lowercases and keeps only letters and digits, so separators
// and regional decorations ("GLM-5.3 Flash" vs "glm-5.3-flash") cannot hide an
// identical model identity.
func NormalizeModelKey(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

// StripProviderPrefix keeps the part after the last routing separator — CPA
// often routes "openai/gpt-5" or "openai:gpt-5" while models.dev lists "gpt-5".
func StripProviderPrefix(value string) string {
	if idx := strings.LastIndexAny(value, "/:"); idx >= 0 {
		return value[idx+1:]
	}
	return value
}

type catalogIndex struct {
	exact      map[string][]CatalogEntry
	normalized map[string][]CatalogEntry
}

func buildCatalogIndex(entries []CatalogEntry) catalogIndex {
	index := catalogIndex{
		exact:      make(map[string][]CatalogEntry, len(entries)*3),
		normalized: make(map[string][]CatalogEntry, len(entries)*3),
	}
	register := func(target map[string][]CatalogEntry, entry CatalogEntry, values ...string) {
		seen := make(map[string]struct{}, len(values))
		for _, value := range values {
			key := strings.ToLower(strings.TrimSpace(value))
			if key == "" {
				continue
			}
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			target[key] = append(target[key], entry)
		}
	}
	for _, entry := range entries {
		id, name := entry.Model.ID, entry.Model.Name
		register(index.exact, entry, id, name, StripProviderPrefix(id), StripProviderPrefix(name))
		register(index.normalized, entry,
			NormalizeModelKey(id), NormalizeModelKey(name),
			NormalizeModelKey(StripProviderPrefix(id)), NormalizeModelKey(StripProviderPrefix(name)))
	}
	return index
}

// matchScore ranks how directly a catalog entry answered the lookup. Higher is
// more specific; a CPA prefix must not steer provider inference, so the
// stripped id always outranks the full routed name.
const (
	scoreExactSuffix      = 100
	scoreExactFull        = 96
	scoreNormalizedSuffix = 92
	scoreNormalizedFull   = 88
)

type rankedCandidate struct {
	entry         CatalogEntry
	score         int
	idMatchLength int
	officialRank  int // index into the family list; -1 when the provider is a relay
	planZero      bool
	deprecated    bool
}

func buildCandidates(model string, index catalogIndex) []rankedCandidate {
	model = strings.TrimSpace(model)
	if model == "" {
		return nil
	}
	suffix := StripProviderPrefix(model)
	type lookup struct {
		key        string
		score      int
		normalized bool
	}
	var lookups []lookup
	if suffix != model {
		lookups = []lookup{
			{strings.ToLower(suffix), scoreExactSuffix, false},
			{NormalizeModelKey(suffix), scoreNormalizedSuffix, true},
			{strings.ToLower(model), scoreExactFull, false},
			{NormalizeModelKey(model), scoreNormalizedFull, true},
		}
	} else {
		lookups = []lookup{
			{strings.ToLower(model), scoreExactSuffix, false},
			{NormalizeModelKey(model), scoreNormalizedSuffix, true},
		}
	}
	best := make(map[string]rankedCandidate, 8)
	family := modelFamilyOf(model)
	officials := officialProvidersByFamily(family)
	officialRank := make(map[string]int, len(officials))
	for i, provider := range officials {
		officialRank[provider] = i
	}
	add := func(entry CatalogEntry, score int) {
		candidate := rankedCandidate{
			entry:         entry,
			score:         score,
			officialRank:  -1,
			deprecated:    strings.EqualFold(strings.TrimSpace(entry.Model.Status), "deprecated"),
			idMatchLength: idMatchLength(model, entry.Model.ID),
		}
		if isPlanZeroProvider(entry.ProviderID) && costIsZero(entry.Model.Cost) {
			// Subscription-plan catalogs list $0 quotas, not USD rates.
			candidate.planZero = true
		} else if rank, ok := officialRank[strings.ToLower(strings.TrimSpace(entry.ProviderID))]; ok {
			candidate.officialRank = rank
		}
		key := entry.ProviderID + "\x00" + entry.Model.ID
		if existing, ok := best[key]; !ok || candidateLess(candidate, existing) {
			best[key] = candidate
		}
	}
	for _, item := range lookups {
		key := strings.ToLower(item.key)
		if item.normalized {
			for _, entry := range index.normalized[NormalizeModelKey(item.key)] {
				add(entry, item.score)
			}
		} else {
			for _, entry := range index.exact[key] {
				add(entry, item.score)
			}
		}
	}
	result := make([]rankedCandidate, 0, len(best))
	for _, candidate := range best {
		result = append(result, candidate)
	}
	sort.Slice(result, func(i, j int) bool { return candidateLess(result[i], result[j]) })
	return result
}

// candidateLess orders candidates the way Keeper does: subscription-plan zero
// prices last, first-party providers first, then match precision, then the
// freshest, shortest-namespace entry. The chain is total, so the winner is
// deterministic across syncs.
func candidateLess(left, right rankedCandidate) bool {
	if left.planZero != right.planZero {
		return !left.planZero
	}
	if left.officialRank != right.officialRank && (left.officialRank >= 0 || right.officialRank >= 0) {
		if left.officialRank < 0 {
			return false
		}
		if right.officialRank < 0 {
			return true
		}
		return left.officialRank < right.officialRank
	}
	if left.score != right.score {
		return left.score > right.score
	}
	if left.idMatchLength != right.idMatchLength {
		return left.idMatchLength > right.idMatchLength
	}
	leftNamespaces := strings.Count(left.entry.Model.ID, "/")
	rightNamespaces := strings.Count(right.entry.Model.ID, "/")
	if leftNamespaces != rightNamespaces {
		return leftNamespaces < rightNamespaces
	}
	if left.deprecated != right.deprecated {
		return !left.deprecated
	}
	if left.entry.Model.LastUpdated != right.entry.Model.LastUpdated {
		return left.entry.Model.LastUpdated > right.entry.Model.LastUpdated
	}
	if left.entry.ProviderID != right.entry.ProviderID {
		return left.entry.ProviderID < right.entry.ProviderID
	}
	return left.entry.Model.ID < right.entry.Model.ID
}

// idMatchLength scores how concretely a catalog id answered the lookup: only a
// true identity (equal, routed suffix, or prefix-stripped equal) counts;
// unrelated longer ids must not outrank an exact bare id.
func idMatchLength(model, id string) int {
	model = strings.ToLower(strings.TrimSpace(model))
	id = strings.ToLower(strings.TrimSpace(id))
	if id == "" {
		return 0
	}
	if model == id || strings.HasSuffix(model, "/"+id) || strings.HasSuffix(model, ":"+id) ||
		NormalizeModelKey(StripProviderPrefix(model)) == NormalizeModelKey(StripProviderPrefix(id)) {
		return len(id)
	}
	return 0
}

// isPlanZeroProvider marks subscription-plan catalogs (coding-plan /
// token-plan) whose listed prices are zero: they describe plan quotas, not USD.
func isPlanZeroProvider(providerID string) bool {
	provider := strings.ToLower(strings.TrimSpace(providerID))
	return strings.Contains(provider, "coding-plan") || strings.Contains(provider, "token-plan")
}

func costIsZero(cost MetadataCost) bool {
	return cost.Input != nil && cost.Output != nil && *cost.Input == 0 && *cost.Output == 0
}

// usableCost requires explicit input and output rates; a catalog entry without
// them must not become a zero-completion price.
func usableCost(cost MetadataCost) bool {
	return cost.Input != nil && cost.Output != nil &&
		*cost.Input >= 0 && *cost.Output >= 0
}

// MatchModel resolves the strongest catalog identity for a model. First-party
// providers win over relays; among relays the most specific, freshest entry
// wins deterministically. A model with no catalog entry at all stays unpriced.
func (c Catalog) MatchModel(model string) *CatalogEntry {
	index := buildCatalogIndex(c.Entries)
	for _, candidate := range buildCandidates(model, index) {
		if !candidate.planZero && usableCost(candidate.entry.Model.Cost) {
			entry := candidate.entry
			return &entry
		}
	}
	return nil
}
