package usage

import "strings"

// IsModelSubstituted reports whether the upstream served a different model than
// the one the request named.
//
// The rule follows CPA's own substitution check so a record OMC flags is one CPA
// would warn about: a dated snapshot, a "-latest" alias, a provider prefix and a
// thinking suffix all name the same model, and treating them as substitutions
// would flag nearly every request to an upstream that answers with its pinned
// snapshot. An unknown side is never a substitution.
func IsModelSubstituted(requested, served string) bool {
	servedModel := normalizeModelName(served)
	requestedModel := normalizeModelName(requested)
	if servedModel == "" || requestedModel == "" {
		return false
	}
	if sameModelRelease(requestedModel, servedModel) {
		return false
	}
	requestedModel = stripModelProviderPrefix(requestedModel)
	servedModel = stripModelProviderPrefix(servedModel)
	if sameModelRelease(requestedModel, servedModel) {
		return false
	}
	return !sameModelRelease(
		strings.TrimSuffix(requestedModel, "-latest"),
		strings.TrimSuffix(servedModel, "-latest"),
	)
}

// isServedModelSubstituted applies the rule to one record. CPA publishes both
// the upstream model name and the alias the client asked for, and an upstream
// may echo either, so only a served model that matches neither is a
// substitution.
func isServedModelSubstituted(model string, alias *string, served string) bool {
	if !IsModelSubstituted(model, served) {
		return false
	}
	return alias == nil || strings.TrimSpace(*alias) == "" || IsModelSubstituted(*alias, served)
}

// normalizeModelName lower-cases a model id and drops CPA's thinking suffix
// ("gpt-5(high)"), which selects a reasoning level and never reaches the
// upstream.
func normalizeModelName(model string) string {
	name := strings.ToLower(strings.TrimSpace(model))
	if strings.HasSuffix(name, ")") {
		if open := strings.LastIndex(name, "("); open > 0 {
			name = strings.TrimSpace(name[:open])
		}
	}
	return name
}

func stripModelProviderPrefix(model string) string {
	if slash := strings.LastIndex(model, "/"); slash >= 0 && slash < len(model)-1 {
		return model[slash+1:]
	}
	return model
}

func sameModelRelease(first, second string) bool {
	return first == second || isDatedModelAlias(first, second) || isDatedModelAlias(second, first)
}

// isDatedModelAlias reports whether dated is base plus a release suffix: a
// YYYY-MM-DD or YYYYMMDD date, or a three-digit build number.
func isDatedModelAlias(base, dated string) bool {
	suffix, found := strings.CutPrefix(dated, base+"-")
	if !found {
		return false
	}
	switch len(suffix) {
	case len("YYYY-MM-DD"):
		return suffix[4] == '-' && suffix[7] == '-' &&
			isDigits(suffix[:4]) && isDigits(suffix[5:7]) && isDigits(suffix[8:])
	case len("YYYYMMDD"), 3:
		return isDigits(suffix)
	default:
		return false
	}
}

func isDigits(value string) bool {
	if value == "" {
		return false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}
