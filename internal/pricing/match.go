package pricing

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// firstPartyAuthors maps a model family to the OpenRouter author namespaces that
// publish it first-hand, most authoritative first. OpenRouter namespaces a model
// by its maker, so this only decides between makers that list the same slug.
func firstPartyAuthors(family string) []string {
	switch family {
	case "openai":
		return []string{"openai"}
	case "anthropic":
		return []string{"anthropic"}
	case "google":
		return []string{"google"}
	case "xai":
		return []string{"x-ai"}
	case "glm":
		return []string{"z-ai", "thudm"}
	case "qwen":
		return []string{"qwen"}
	case "moonshot":
		return []string{"moonshotai"}
	case "deepseek":
		return []string{"deepseek"}
	case "minimax":
		return []string{"minimax"}
	case "xiaomi":
		return []string{"xiaomi"}
	case "mistral":
		return []string{"mistralai"}
	case "llama":
		return []string{"meta-llama", "meta"}
	case "cohere":
		return []string{"cohere"}
	case "doubao":
		return []string{"bytedance-seed", "bytedance"}
	default:
		return nil
	}
}

// modelFamilyOf maps a model id prefix to a family. Unknown prefixes have no
// first-party author and are ranked on match precision alone.
func modelFamilyOf(model string) string {
	identity := NormalizeModelKey(StripProviderPrefix(model))
	prefixes := []struct {
		prefix string
		family string
	}{
		{"gpt", "openai"}, {"chatgpt", "openai"}, {"o1", "openai"}, {"o3", "openai"}, {"o4", "openai"},
		{"claude", "anthropic"}, {"deepseek", "deepseek"}, {"glm", "glm"}, {"qwen", "qwen"},
		{"gemini", "google"}, {"gemma", "google"}, {"grok", "xai"}, {"minimax", "minimax"}, {"moonshot", "moonshot"},
		{"kimi", "moonshot"}, {"doubao", "doubao"}, {"seed", "doubao"}, {"mimo", "xiaomi"}, {"command", "cohere"},
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

// NormalizeModelKey ignores case and separators but preserves numeric component
// boundaries: version 5.1 and 51 must never inherit each other's prices.
func NormalizeModelKey(value string) string {
	var key strings.Builder
	key.Grow(len(value))
	hasSeparator, wasDigit := false, false
	for _, character := range value {
		if !unicode.IsLetter(character) && !unicode.IsDigit(character) {
			hasSeparator = true
			continue
		}
		isDigit := unicode.IsDigit(character)
		if hasSeparator && wasDigit && isDigit {
			key.WriteByte('.')
		}
		key.WriteRune(unicode.ToLower(character))
		wasDigit, hasSeparator = isDigit, false
	}
	return key.String()
}

// StripProviderPrefix keeps the part after the last routing separator of a CPA
// model name — CPA often routes "openai/gpt-5" or "openai:gpt-5". It is for CPA
// names only: an OpenRouter id's ':' introduces a variant, not a model.
func StripProviderPrefix(value string) string {
	if idx := strings.LastIndexAny(value, "/:"); idx >= 0 {
		return value[idx+1:]
	}
	return value
}

// upstreamSlug is an OpenRouter id without its author namespace.
func upstreamSlug(id string) string {
	_, slug, found := strings.Cut(strings.TrimPrefix(id, "~"), "/")
	if !found {
		return id
	}
	return slug
}

var (
	reasoningSuffix   = regexp.MustCompile(`(?i)(?:[-_ ](?:reasoning[-_ ])?(?:none|minimal|low|medium|high|xhigh|thinking)|\((?:none|minimal|low|medium|high|xhigh|thinking)\))$`)
	dateSuffixCompact = regexp.MustCompile(`-(\d{4})(\d{2})(\d{2})$`)
	dateSuffixDashed  = regexp.MustCompile(`-(\d{4})-(\d{2})-(\d{2})$`)
	dateSuffixMonthYr = regexp.MustCompile(`-(\d{2})-(\d{4})$`)
	dateSuffixMonthDy = regexp.MustCompile(`-(\d{2})(\d{2})$`)
)

// stripDateSuffix removes one trailing release date. A four-digit suffix is only
// a date when it reads as a real month and day, so Qwen's YYMM "2507" survives.
func stripDateSuffix(value string) string {
	isDate := func(month, day string) bool {
		m, _ := strconv.Atoi(month)
		d, _ := strconv.Atoi(day)
		return m >= 1 && m <= 12 && d >= 1 && d <= 31
	}
	if match := dateSuffixCompact.FindStringSubmatch(value); match != nil && isDate(match[2], match[3]) {
		return value[:len(value)-len(match[0])]
	}
	if match := dateSuffixDashed.FindStringSubmatch(value); match != nil && isDate(match[2], match[3]) {
		return value[:len(value)-len(match[0])]
	}
	if match := dateSuffixMonthYr.FindStringSubmatch(value); match != nil && isDate(match[1], "1") {
		return value[:len(value)-len(match[0])]
	}
	if match := dateSuffixMonthDy.FindStringSubmatch(value); match != nil && isDate(match[1], match[2]) {
		return value[:len(value)-len(match[0])]
	}
	return value
}

// Catalog is one decoded OpenRouter snapshot with its lookup index.
type Catalog struct {
	FetchedAt time.Time
	Models    []UpstreamModel
	index     *catalogIndex
}

type indexedEntry struct {
	model UpstreamModel
	kind  string
}

type catalogIndex struct {
	byID       map[string]UpstreamModel
	exact      map[string][]indexedEntry
	normalized map[string][]indexedEntry
	dated      map[string][]indexedEntry
}

// NewCatalog indexes a snapshot once; lookups are then map reads.
func NewCatalog(models []UpstreamModel, fetchedAt time.Time) Catalog {
	index := &catalogIndex{
		byID:       make(map[string]UpstreamModel, len(models)),
		exact:      make(map[string][]indexedEntry, len(models)*2),
		normalized: make(map[string][]indexedEntry, len(models)*2),
		dated:      make(map[string][]indexedEntry, len(models)),
	}
	add := func(target map[string][]indexedEntry, key string, entry indexedEntry) {
		if key == "" {
			return
		}
		for _, existing := range target[key] {
			if existing.model.ID == entry.model.ID {
				return
			}
		}
		target[key] = append(target[key], entry)
	}
	for _, model := range models {
		index.byID[strings.ToLower(model.ID)] = model
		slug := upstreamSlug(model.ID)
		canonical := upstreamSlug(model.CanonicalSlug)
		exactKind, canonicalKind, normalizedKind, datedKind := MatchExact, MatchCanonical, MatchNormalized, MatchDateStripped
		if model.IsAlias() {
			exactKind, canonicalKind, normalizedKind, datedKind = MatchAlias, MatchAlias, MatchAlias, MatchAlias
		}
		add(index.exact, strings.ToLower(slug), indexedEntry{model, exactKind})
		if model.CanonicalSlug != "" {
			add(index.exact, strings.ToLower(canonical), indexedEntry{model, canonicalKind})
			add(index.normalized, NormalizeModelKey(canonical), indexedEntry{model, normalizedKind})
			add(index.dated, NormalizeModelKey(stripDateSuffix(canonical)), indexedEntry{model, datedKind})
		}
		add(index.normalized, NormalizeModelKey(slug), indexedEntry{model, normalizedKind})
		add(index.dated, NormalizeModelKey(stripDateSuffix(slug)), indexedEntry{model, datedKind})
	}
	return Catalog{FetchedAt: fetchedAt, Models: models, index: index}
}

func (c *Catalog) ensureIndex() *catalogIndex {
	if c.index == nil {
		*c = NewCatalog(c.Models, c.FetchedAt)
	}
	return c.index
}

// Lookup finds an OpenRouter model by its exact id.
func (c Catalog) Lookup(id string) (UpstreamModel, bool) {
	model, ok := c.ensureIndex().byID[strings.ToLower(strings.TrimSpace(id))]
	return model, ok
}

// Match is the upstream model a CPA model resolved to and how precisely.
type Match struct {
	Model UpstreamModel
	Kind  string
}

var matchKindRank = map[string]int{
	MatchExact: 0, MatchCanonical: 1, MatchNormalized: 2, MatchDateStripped: 3, MatchAlias: 4,
}

// MatchModel resolves the strongest OpenRouter identity for a CPA model. The
// chain is: match precision (exact id, canonical slug, normalized, date-stripped,
// floating alias) → first-party author for the model's family → shorter slug →
// id. It is total, so the winner is stable across syncs. A name that only
// resembles a listed model is not matched; Suggest offers it instead.
func (c Catalog) MatchModel(model string) (Match, bool) {
	index := c.ensureIndex()
	model = strings.TrimSpace(model)
	if model == "" {
		return Match{}, false
	}
	if exact, ok := index.byID[strings.ToLower(model)]; ok {
		kind := MatchExact
		if exact.IsAlias() {
			kind = MatchAlias
		}
		return Match{Model: exact, Kind: kind}, true
	}
	suffix := StripProviderPrefix(model)
	var candidates []indexedEntry
	candidates = append(candidates, index.exact[strings.ToLower(suffix)]...)
	candidates = append(candidates, index.normalized[NormalizeModelKey(suffix)]...)
	if stripped := stripDateSuffix(suffix); stripped != suffix {
		for _, entry := range index.normalized[NormalizeModelKey(stripped)] {
			candidates = append(candidates, indexedEntry{entry.model, demoteToDated(entry.kind)})
		}
	}
	candidates = append(candidates, index.dated[NormalizeModelKey(stripDateSuffix(suffix))]...)
	if len(candidates) == 0 {
		return Match{}, false
	}
	officials := firstPartyAuthors(modelFamilyOf(model))
	officialRank := func(author string) int {
		for i, candidate := range officials {
			if candidate == author {
				return i
			}
		}
		return len(officials)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		if matchKindRank[left.kind] != matchKindRank[right.kind] {
			return matchKindRank[left.kind] < matchKindRank[right.kind]
		}
		if leftRank, rightRank := officialRank(left.model.Author), officialRank(right.model.Author); leftRank != rightRank {
			return leftRank < rightRank
		}
		if len(upstreamSlug(left.model.ID)) != len(upstreamSlug(right.model.ID)) {
			return len(upstreamSlug(left.model.ID)) < len(upstreamSlug(right.model.ID))
		}
		return left.model.ID < right.model.ID
	})
	return Match{Model: candidates[0].model, Kind: candidates[0].kind}, true
}

func demoteToDated(kind string) string {
	if kind == MatchAlias {
		return MatchAlias
	}
	return MatchDateStripped
}

// Suggest ranks upstream models that resemble a model MatchModel could not
// resolve, such as a reasoning-effort decoration ("gpt-5.4-mini-high"). The
// console offers them for one-click adoption; they are never applied on their
// own, because resemblance is not identity.
func (c Catalog) Suggest(model string, limit int) []UpstreamModel {
	if limit <= 0 {
		return nil
	}
	key := NormalizeModelKey(StripProviderPrefix(model))
	if len(key) < 3 {
		return nil
	}
	// Effort controls can identify a useful suggestion, but are not proof of price identity.
	base := strings.TrimSpace(reasoningSuffix.ReplaceAllString(StripProviderPrefix(model), ""))
	preferredID := ""
	if base != StripProviderPrefix(model) {
		if matched, ok := c.MatchModel(base); ok {
			preferredID = matched.Model.ID
		}
	}
	family := modelFamilyOf(model)
	officials := firstPartyAuthors(family)
	type scored struct {
		model    UpstreamModel
		prefix   int
		overlap  float64
		official bool
	}
	wanted := modelTokens(StripProviderPrefix(model))
	var ranked []scored
	for _, candidate := range c.Models {
		slugKey := NormalizeModelKey(upstreamSlug(candidate.ID))
		prefix := commonPrefix(key, slugKey)
		if candidate.ID != preferredID && (prefix < 4 || prefix*2 < len(slugKey)) {
			continue
		}
		official := false
		for _, author := range officials {
			if author == candidate.Author {
				official = true
			}
		}
		if len(officials) > 0 && !official {
			continue
		}
		ranked = append(ranked, scored{candidate, prefix, tokenOverlap(wanted, modelTokens(upstreamSlug(candidate.ID))), official})
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		left, right := ranked[i], ranked[j]
		if (left.model.ID == preferredID) != (right.model.ID == preferredID) {
			return left.model.ID == preferredID
		}
		if left.model.IsAlias() != right.model.IsAlias() {
			return !left.model.IsAlias()
		}
		if left.prefix != right.prefix {
			return left.prefix > right.prefix
		}
		if left.overlap != right.overlap {
			return left.overlap > right.overlap
		}
		return left.model.ID < right.model.ID
	})
	result := make([]UpstreamModel, 0, min(limit, len(ranked)))
	for _, item := range ranked {
		if len(result) == limit {
			break
		}
		result = append(result, item.model)
	}
	return result
}

func commonPrefix(left, right string) int {
	n := min(len(left), len(right))
	for i := 0; i < n; i++ {
		if left[i] != right[i] {
			return i
		}
	}
	return n
}

// modelTokens splits a name into lowercase alphanumeric words.
func modelTokens(value string) map[string]struct{} {
	tokens := make(map[string]struct{})
	for _, word := range strings.FieldsFunc(strings.ToLower(value), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	}) {
		tokens[word] = struct{}{}
	}
	return tokens
}

func tokenOverlap(left, right map[string]struct{}) float64 {
	if len(left) == 0 || len(right) == 0 {
		return 0
	}
	shared := 0
	for token := range left {
		if _, ok := right[token]; ok {
			shared++
		}
	}
	return float64(shared) / float64(len(left)+len(right)-shared)
}
