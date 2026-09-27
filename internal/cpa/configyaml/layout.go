package configyaml

import (
	"fmt"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// ConfigLayout names the spelling a CPA configuration document uses.
//
// CPA v8 reads both spellings from one file, so the layout is a property of the
// document rather than of the gateway: a v8 gateway keeps serving a legacy file
// unchanged until something performs a v8 configuration write, and a document can
// be mixed after an operator adds v8 sections by hand.
type ConfigLayout string

const (
	// LayoutLegacy is every document a v7 gateway can read, including an empty one.
	LayoutLegacy ConfigLayout = "legacy"
	// LayoutV8 carries v8 locations and no legacy spelling of a relocated setting.
	LayoutV8 ConfigLayout = "v8"
	// LayoutMixed carries both. CPA v8 resolves each setting to its v8 location
	// when present and to its legacy spelling otherwise.
	LayoutMixed ConfigLayout = "mixed"
)

// LegacyKindSequence marks a legacy spelling that only counts when its value is
// a list. The legacy client-key list and the v8 upstream provider groups share
// the root api-keys key, told apart by shape exactly as CPA does.
const LegacyKindSequence = "sequence"

// LayoutRule relocates one legacy path (dot-separated) to its v8 path.
type LayoutRule struct {
	Legacy     string `json:"legacy"`
	Current    string `json:"current"`
	LegacyKind string `json:"legacy_kind,omitempty"`
}

// V8_ONLY_SECTIONS are root keys that only the v8 layout defines. routing,
// plugins and quota-exceeded exist in both layouts and prove nothing on their own.
var V8_ONLY_SECTIONS = []string{"config-version", "server", "management", "access", "requests", "oauth", "multimedia", "observability", "credentials"}

// LayoutRules returns every path-level relocation, leaves first. The console
// receives exactly this list so its field placement cannot drift from the
// server-side guard that checks the same document.
func LayoutRules() []LayoutRule {
	rules := make([]LayoutRule, 0, len(CONFIG_LAYOUT_LEAF_RULES)+len(CONFIG_LAYOUT_SECTION_RULES))
	rules = append(rules, CONFIG_LAYOUT_LEAF_RULES...)
	return append(rules, CONFIG_LAYOUT_SECTION_RULES...)
}

// RewriteToV8 returns the v8 spelling of a legacy path. A path with no rule is
// shared by both layouts (routing.strategy, quota-exceeded.switch-project) and
// comes back unchanged with false.
func RewriteToV8(path []string) ([]string, bool) {
	joined := strings.Join(path, ".")
	best := LayoutRule{}
	for _, rule := range LayoutRules() {
		if (joined == rule.Legacy || strings.HasPrefix(joined, rule.Legacy+".")) && len(rule.Legacy) > len(best.Legacy) {
			best = rule
		}
	}
	if best.Legacy == "" {
		return append([]string(nil), path...), false
	}
	rewritten := best.Current + strings.TrimPrefix(joined, best.Legacy)
	return strings.Split(rewritten, "."), true
}

// LayoutReport is the layout facts the console and the save guard act on.
type LayoutReport struct {
	Layout ConfigLayout `json:"layout"`
	// HasProviderGroups reports a root api-keys mapping: upstream provider
	// credentials in the v8 layout. A document that replaces it with a list
	// deletes every one of them.
	HasProviderGroups bool `json:"has_provider_groups"`
}

// DetectLayout classifies a raw configuration document. It never fails on an
// empty document, which is a legacy one; it fails only on YAML that CPA could
// not parse either.
func DetectLayout(rawYAML string) (LayoutReport, error) {
	root, err := parseRootMapping(rawYAML)
	if err != nil || root == nil {
		return LayoutReport{Layout: LayoutLegacy}, err
	}
	hasV8 := false
	for _, section := range V8_ONLY_SECTIONS {
		if mappingValue(root, section) != nil {
			hasV8 = true
			break
		}
	}
	report := LayoutReport{}
	if groups := mappingValue(root, "api-keys"); groups != nil && groups.Kind == yaml.MappingNode {
		report.HasProviderGroups = true
		hasV8 = true
	}
	for _, rule := range CONFIG_LAYOUT_LEAF_RULES {
		if strings.HasPrefix(rule.Current, "routing.") && nodeAtPath(root, rule.Current) != nil {
			hasV8 = true
		}
	}
	hasLegacy := false
	for _, rule := range CONFIG_LAYOUT_LEAF_RULES {
		if legacyNode(root, rule) != nil {
			hasLegacy = true
			break
		}
	}
	if !hasLegacy {
		for _, rule := range append(append([]LayoutRule(nil), CONFIG_LAYOUT_SECTION_RULES...), PROVIDER_KEY_FAMILY_RULES...) {
			if nodeAtPath(root, rule.Legacy) != nil {
				hasLegacy = true
				break
			}
		}
	}
	switch {
	case hasV8 && hasLegacy:
		report.Layout = LayoutMixed
	case hasV8:
		report.Layout = LayoutV8
	default:
		report.Layout = LayoutLegacy
	}
	return report, nil
}

// ShadowedLegacyPaths lists the legacy spellings a CPA v8 gateway would ignore
// and then delete: those whose v8 location is also present in the document.
//
// This is the silent failure the v8 layout introduces. CPA accepts the whole
// document, answers success, keeps the v8 value and drops the edit, so the only
// place it can be caught is before the write. The check is per leaf because
// CPA's precedence is per leaf: a legacy tls.cert beside a v8 server.tls.enable
// is still honoured, while a legacy oauth-model-alias map loses to any v8
// oauth.model-alias map, whatever providers each one names.
func ShadowedLegacyPaths(rawYAML string) ([]LayoutRule, error) {
	root, err := parseRootMapping(rawYAML)
	if err != nil || root == nil {
		return nil, err
	}
	var shadowed []LayoutRule
	for _, rule := range CONFIG_LAYOUT_LEAF_RULES {
		if legacyNode(root, rule) != nil && nodeAtPath(root, rule.Current) != nil {
			shadowed = append(shadowed, rule)
		}
	}
	for _, family := range PROVIDER_KEY_FAMILY_RULES {
		if nodeAtPath(root, family.Legacy) != nil && nodeAtPath(root, family.Current) != nil {
			shadowed = append(shadowed, family)
		}
	}
	sort.Slice(shadowed, func(i, j int) bool { return shadowed[i].Legacy < shadowed[j].Legacy })
	return shadowed, nil
}

// ReplacesProviderGroups reports a submitted document that turns a stored root
// api-keys mapping (v8 upstream provider groups) into anything else. Writing a
// legacy client-key list there is the typical cause, and it deletes every
// upstream credential the mapping held while the client-key edit itself loses to
// access.api-keys.
func ReplacesProviderGroups(storedYAML, submittedYAML string) (bool, error) {
	stored, err := DetectLayout(storedYAML)
	if err != nil {
		// An unparseable stored file holds no provider groups CPA can be using,
		// since CPA cannot load it either. Saving a valid document over it is how
		// an operator repairs it, so this is not a refusal.
		return false, nil //nolint:nilerr // deliberate: see above
	}
	if !stored.HasProviderGroups {
		return false, nil
	}
	root, err := parseRootMapping(submittedYAML)
	if err != nil {
		return false, err
	}
	if root == nil {
		return true, nil
	}
	value := mappingValue(root, "api-keys")
	return value != nil && value.Kind != yaml.MappingNode, nil
}

func parseRootMapping(rawYAML string) (*yaml.Node, error) {
	if strings.TrimSpace(rawYAML) == "" {
		return nil, nil
	}
	var document yaml.Node
	if err := yaml.Unmarshal([]byte(rawYAML), &document); err != nil {
		return nil, fmt.Errorf("parse yaml: %w", err)
	}
	if len(document.Content) == 0 {
		return nil, nil
	}
	root := resolveAlias(document.Content[0])
	if root.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("configuration must be a mapping")
	}
	return root, nil
}

// legacyNode applies the rule's shape condition, as CPA's legacyPath does.
func legacyNode(root *yaml.Node, rule LayoutRule) *yaml.Node {
	node := nodeAtPath(root, rule.Legacy)
	if node != nil && rule.LegacyKind == LegacyKindSequence && node.Kind != yaml.SequenceNode {
		return nil
	}
	return node
}

func nodeAtPath(root *yaml.Node, dotted string) *yaml.Node {
	node := root
	for _, key := range strings.Split(dotted, ".") {
		node = mappingValue(node, key)
		if node == nil {
			return nil
		}
	}
	return node
}

func mappingValue(node *yaml.Node, key string) *yaml.Node {
	node = resolveAlias(node)
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for index := 0; index+1 < len(node.Content); index += 2 {
		if node.Content[index].Value == key {
			return resolveAlias(node.Content[index+1])
		}
	}
	return nil
}

func resolveAlias(node *yaml.Node) *yaml.Node {
	for node != nil && node.Kind == yaml.AliasNode {
		node = node.Alias
	}
	return node
}
