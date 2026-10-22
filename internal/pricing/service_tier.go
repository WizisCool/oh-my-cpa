package pricing

import (
	"slices"
	"strings"
)

// Where the service tier a request was billed on came from.
const (
	ServiceTierFromResponse = "response"
	ServiceTierFromRequest  = "request"
)

// serviceTierAuto is the caller's "let the upstream decide": it names no tier,
// so it can never select a service-tier price.
const serviceTierAuto = "auto"

// NormalizeServiceTier is the one spelling tiers are stored and compared in.
func NormalizeServiceTier(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// BilledServiceTier names the service tier a request is priced on and where it
// came from under the original response-first policy. Historical cost snapshots
// without a stored selection retain this policy. For providers other than Codex a
// requested priority tier can be served on the default lane. An older gateway
// or an upstream that reports nothing leaves only the requested tier, which is
// then used as the caller's explicit choice. Auto and empty name no tier, so
// such a request is priced without any service-tier rule.
func BilledServiceTier(response, requested string) (tier, source string) {
	if tier = NormalizeServiceTier(response); tier != "" && tier != serviceTierAuto {
		return tier, ServiceTierFromResponse
	}
	if tier = NormalizeServiceTier(requested); tier != "" && tier != serviceTierAuto {
		return tier, ServiceTierFromRequest
	}
	return "", ""
}

// ResolveServiceTier keeps provider-specific evidence separate from the raw
// request and response. Codex reports default/auto even for Fast requests, so
// its client choice is the best available evidence until CPA reports the final
// outbound tier. An explicit auto must not fall through to a response lane.
func ResolveServiceTier(provider, executor, response, requested string) (tier, source string) {
	isCodex := NormalizeServiceTier(provider) == "codex"
	switch NormalizeServiceTier(executor) {
	case "codexexecutor", "codexwebsocketsexecutor":
		isCodex = true
	}
	if tier = NormalizeServiceTier(requested); isCodex && tier != "" {
		if tier == serviceTierAuto {
			tier = ""
		}
		return tier, ServiceTierFromRequest
	}
	return BilledServiceTier(response, requested)
}

// matchesServiceTier reports whether a tier's service-tier condition holds; a
// tier without one holds for every request.
func (t PriceTier) matchesServiceTier(billed string) bool {
	if !t.HasServiceTiers() {
		return true
	}
	billed = NormalizeServiceTier(billed)
	if billed == "" {
		return false
	}
	for _, name := range t.ServiceTiers {
		if NormalizeServiceTier(name) == billed {
			return true
		}
	}
	return false
}

// canonicalServiceTiers normalizes, sorts and deduplicates a tier's list, so
// two spellings of the same condition store as the same text.
func canonicalServiceTiers(names []string) []string {
	if len(names) == 0 {
		return nil
	}
	canonical := make([]string, 0, len(names))
	for _, name := range names {
		canonical = append(canonical, NormalizeServiceTier(name))
	}
	slices.Sort(canonical)
	return slices.Compact(canonical)
}

func isValidServiceTier(name string) bool {
	if name == "" || len(name) > 64 || name == serviceTierAuto {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-') {
			return false
		}
	}
	return true
}
