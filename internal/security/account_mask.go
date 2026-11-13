package security

import (
	"regexp"
	"strings"
)

// AccountMaskRun is the constant-length filler used when masking account
// addresses and project identifiers for display.
const AccountMaskRun = "•••"

// Recognizes RFC 5322 atext local parts so punctuation-bearing addresses
// (such as alice!@example.com or user+tag@example.com) are masked even when
// only a filename or label is available.
var emailAddressTokenPattern = regexp.MustCompile(`[A-Za-z0-9.!#$%&'*+/=?^_` + "`" + `{|}~\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}`)

// MaskAccount hides who a credential belongs to while keeping it recognizable
// to its owner, matching web/src/utils/maskAccount.ts.
//
// An email keeps two leading runes and one trailing rune of its local part (or
// one leading rune when three or fewer), plus the domain. Non-email identifiers
// such as Vertex project IDs keep three leading and two trailing runes when at
// least eight runes long, and collapse to AccountMaskRun otherwise.
func MaskAccount(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	// Already masked values stay idempotent.
	if strings.Contains(trimmed, AccountMaskRun) {
		return trimmed
	}
	at := strings.LastIndex(trimmed, "@")
	if at > 0 && at < len(trimmed)-1 {
		local := []rune(trimmed[:at])
		domain := trimmed[at:]
		if len(local) > 3 {
			return string(local[:2]) + AccountMaskRun + string(local[len(local)-1:]) + domain
		}
		return string(local[:1]) + AccountMaskRun + domain
	}
	runes := []rune(trimmed)
	if len(runes) >= 8 {
		return string(runes[:3]) + AccountMaskRun + string(runes[len(runes)-2:])
	}
	return AccountMaskRun
}

// MaskAccountIn masks every case-insensitive occurrence of account inside text,
// such as a credential file name derived from an email or project ID.
func MaskAccountIn(text, account string) string {
	trimmed := strings.TrimSpace(account)
	if trimmed == "" || text == "" {
		return text
	}
	mask := MaskAccount(trimmed)
	pattern, err := regexp.Compile("(?i)" + regexp.QuoteMeta(trimmed))
	if err != nil {
		return text
	}
	return pattern.ReplaceAllLiteralString(text, mask)
}

// MaskEmailAddresses masks every email-shaped token in text when the raw
// account field is unavailable, leaving already-masked addresses untouched.
func MaskEmailAddresses(text string) string {
	if text == "" || !strings.Contains(text, "@") {
		return text
	}
	locs := emailAddressTokenPattern.FindAllStringIndex(text, -1)
	if len(locs) == 0 {
		return text
	}
	var out strings.Builder
	last := 0
	for _, loc := range locs {
		start, end := loc[0], loc[1]
		out.WriteString(text[last:start])
		token := text[start:end]
		if strings.HasSuffix(text[:start], AccountMaskRun) {
			out.WriteString(token)
		} else {
			out.WriteString(MaskAccount(token))
		}
		last = end
	}
	out.WriteString(text[last:])
	return out.String()
}
