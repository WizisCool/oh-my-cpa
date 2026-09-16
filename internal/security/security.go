package security

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// RedactedValue is the fixed marker used when a value cannot be safely
// fingerprinted or projected.
const RedactedValue = "[redacted]"

var ErrFingerprinterUnavailable = errors.New("security fingerprinter is unavailable")

// Fingerprinter is implemented by the application's keyed crypto service.
type Fingerprinter interface {
	Fingerprint(parts ...string) (string, error)
}

// Fingerprint returns a stable keyed value for a non-empty source. A missing
// fingerprinter fails closed with a fixed marker.
func Fingerprint(f Fingerprinter, purpose, value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	if f == nil {
		return RedactedValue, ErrFingerprinterUnavailable
	}
	fingerprint, err := f.Fingerprint("oh-my-cpa", purpose, value)
	if err != nil || strings.TrimSpace(fingerprint) == "" {
		if err == nil {
			err = fmt.Errorf("%w: empty fingerprint", ErrFingerprinterUnavailable)
		}
		return RedactedValue, err
	}
	return fingerprint, nil
}

// FingerprintOrRedacted is convenient at persistence boundaries where the
// caller must continue with a safe value after a crypto/configuration error.
func FingerprintOrRedacted(f Fingerprinter, purpose, value string) string {
	fingerprinted, _ := Fingerprint(f, purpose, value)
	if strings.TrimSpace(value) != "" && strings.TrimSpace(fingerprinted) == "" {
		return RedactedValue
	}
	return fingerprinted
}

// PublicURL accepts only HTTP(S) URLs and removes credentials and
// request-specific data.
func PublicURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return ""
	}
	if !strings.EqualFold(parsed.Scheme, "http") && !strings.EqualFold(parsed.Scheme, "https") {
		return ""
	}
	parsed.User = nil
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.RawQuery = ""
	parsed.ForceQuery = false
	parsed.Fragment = ""
	parsed.RawFragment = ""
	return strings.TrimRight(parsed.String(), "/")
}

// publicPathEndpoint strips query, fragment and any authority from an absolute
// API path, which is how CPA labels requests it serves directly.
//
// A path may still carry an authority ("//user:pass@host/path"): browsers resolve
// that as protocol-relative, so credentials there are real and must not survive.
func publicPathEndpoint(value string) string {
	if !strings.HasPrefix(value, "/") {
		return ""
	}
	// Resolve a protocol-relative form through PublicURL, which already drops
	// userinfo, query and fragment, then keep only the resulting path.
	if strings.HasPrefix(value, "//") {
		if safe := PublicURL("https:" + value); safe != "" {
			parsed, err := url.Parse(safe)
			if err != nil {
				return ""
			}
			return parsed.Path
		}
		return ""
	}
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	parsed.RawQuery = ""
	parsed.ForceQuery = false
	parsed.Fragment = ""
	parsed.RawFragment = ""
	return parsed.String()
}

// requestLinePattern matches the endpoint label CPA publishes: the request line
// it handled, method included ("POST /v1/chat/completions"), not a bare URL.
var requestLinePattern = regexp.MustCompile(`^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)[ \t]+(\S+)$`)

// PublicEndpoint removes authority credentials and request-specific query data
// from a full HTTP(S) endpoint, an absolute API path, or the method-prefixed
// request line CPA reports.
func PublicEndpoint(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if safe := PublicURL(value); safe != "" {
		return safe
	}
	if safe := publicPathEndpoint(value); safe != "" {
		return safe
	}
	// CPA labels a request it proxied with the request line it served, so the
	// path has to be salvaged from behind the method. Refusing the whole value
	// here is what left every stored endpoint blank.
	if match := requestLinePattern.FindStringSubmatch(value); match != nil {
		if safe := PublicURL(match[2]); safe != "" {
			return match[1] + " " + safe
		}
		if safe := publicPathEndpoint(match[2]); safe != "" {
			return match[1] + " " + safe
		}
	}
	return ""
}

var urlTokenPattern = regexp.MustCompile(`(?i)\bhttps?://[^\s"'<>]+`)
var bearerPattern = regexp.MustCompile(`(?i)\bBearer\s+[^\s,;"'<>]+`)
var headerSecretPattern = regexp.MustCompile(`(?im)^([ \t]*(?:authorization|proxy-authorization|cookie|set-cookie)[ \t]*:[ \t]*)[^\r\n]*`)
var keyValueSecretPattern = regexp.MustCompile(`(?i)(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd|secret|authorization|proxy[_-]?authorization|cookie|account|token)["']?[ \t]*[:=][ \t]*)(?:"[^"]*"|'[^']*'|[^\s,;}&]+)`)
var apiKeyPrefixPattern = regexp.MustCompile(`\b(?:sk|pk|ghp|gho|glpat|xox[baprs]|pat)-[A-Za-z0-9_-]{8,}\b`)

// RedactText removes common credential-bearing forms from arbitrary text.
func RedactText(value string, knownSecrets ...string) string {
	for _, secret := range sortedSecrets(knownSecrets) {
		if secret != "" {
			value = strings.ReplaceAll(value, secret, RedactedValue)
		}
	}
	value = headerSecretPattern.ReplaceAllString(value, `${1}`+RedactedValue)
	value = bearerPattern.ReplaceAllString(value, "Bearer "+RedactedValue)
	value = keyValueSecretPattern.ReplaceAllString(value, `${1}`+RedactedValue)
	value = apiKeyPrefixPattern.ReplaceAllString(value, RedactedValue)
	value = urlTokenPattern.ReplaceAllStringFunc(value, func(raw string) string {
		if safe := PublicURL(raw); safe != "" {
			return safe
		}
		return RedactedValue
	})
	return stripControl(value)
}

// RedactJSON preserves JSON shape while replacing values under sensitive keys.
// Invalid JSON is treated as opaque text and still receives text redaction.
func RedactJSON(raw []byte, knownSecrets ...string) ([]byte, error) {
	var value any
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&value); err != nil {
		return []byte(RedactText(string(raw), knownSecrets...)), err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return []byte(RedactText(string(raw), knownSecrets...)), errors.New("json contains multiple values")
	}
	redacted := redactJSONValue("", value, knownSecrets...)
	encoded, err := json.Marshal(redacted)
	if err != nil {
		return []byte(RedactText(string(raw), knownSecrets...)), fmt.Errorf("encode redacted json: %w", err)
	}
	return encoded, nil
}

// RedactPayload is the persistence-safe form for queue messages.
func RedactPayload(raw string, knownSecrets ...string) string {
	redacted, err := RedactJSON([]byte(raw), knownSecrets...)
	if err == nil {
		return string(redacted)
	}
	return RedactText(raw, knownSecrets...)
}

func redactJSONValue(key string, value any, knownSecrets ...string) any {
	if IsSensitiveKey(key) {
		return RedactedValue
	}
	switch typed := value.(type) {
	case map[string]any:
		result := make(map[string]any, len(typed))
		for childKey, childValue := range typed {
			result[childKey] = redactJSONValue(childKey, childValue, knownSecrets...)
		}
		return result
	case []any:
		result := make([]any, len(typed))
		for index, childValue := range typed {
			result[index] = redactJSONValue(key, childValue, knownSecrets...)
		}
		return result
	case string:
		return RedactText(typed, knownSecrets...)
	default:
		return value
	}
}

// IsSensitiveKey recognizes credential and session material independent of
// punctuation or JSON naming conventions.
func IsSensitiveKey(key string) bool {
	normalized := strings.ToLower(strings.TrimSpace(key))
	normalized = strings.NewReplacer("_", "", "-", "", " ", "", ".", "").Replace(normalized)
	if normalized == "" {
		return false
	}
	// CPA's usage payload has a non-secret accounting object named `tokens`
	// and fields such as `input_tokens`. Keep those counters available for
	// decoding; credential tokens use singular or credential-specific names.
	if normalized == "tokens" || strings.HasSuffix(normalized, "tokens") {
		return false
	}
	for _, exact := range []string{
		"account", "apikey", "accesstoken", "refreshtoken", "idtoken", "clientsecret",
		"password", "passwd", "secret", "authorization", "proxyauthorization", "cookie",
		"setcookie", "token", "credential", "credentials", "privatekey", "signingkey",
	} {
		if normalized == exact {
			return true
		}
	}
	return strings.Contains(normalized, "token") || strings.Contains(normalized, "secret") ||
		strings.Contains(normalized, "password") || strings.Contains(normalized, "credential")
}

// maskRun is the test-visible alias of MaskRun, so the masking expectations can
// assert an exact filler without spelling the runes out.
const maskRun = MaskRun

// MaskSecret renders a credential as a recognisable but non-recoverable display
// label: a short head and tail survive and everything between them becomes a
// fixed run of bullets ("sk-1234••••••••7890"). The caller keeps the keyed
// fingerprint for identity; this value exists only so a human can tell two keys
// apart in the UI.
//
// A secret too short for a head and tail to stay informative is hidden
// completely — exposing four of an eight-character key would say nothing and
// give away half the secret. The filler is a constant length so the mask never
// reveals the secret's length.
func MaskSecret(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	runes := []rune(value)
	switch {
	case len(runes) >= 20:
		return string(runes[:8]) + MaskRun + string(runes[len(runes)-4:])
	case len(runes) >= 12:
		return string(runes[:4]) + MaskRun + string(runes[len(runes)-2:])
	default:
		return MaskRun
	}
}

// MaskRun is the filler a display mask uses. Callers that need to recognise or
// re-render a mask use it instead of spelling the runes out.
const MaskRun = "••••••••"

// legacyMaskRun is the filler used before the mask switched to bullets. Rows
// ingested earlier still carry it, so projections normalize it on read.
const legacyMaskRun = "xxxxxxx"

// NormalizeMask converts a stored display mask to the current filler.
//
// Only the filler changes: the visible edges are preserved, because they are
// what lets an operator tell two keys apart. A value that is not a mask (a raw
// key, a fingerprint, an empty string) is returned untouched — this function
// never guesses at or reconstructs a secret, and it is not a security boundary.
func NormalizeMask(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || !strings.Contains(value, legacyMaskRun) {
		return value
	}
	return strings.Replace(value, legacyMaskRun, MaskRun, 1)
}

// IsMask reports whether value has the shape of a display mask: a single
// unbroken token carrying a current or legacy filler run.
//
// This is shape checking for a persistence boundary, not proof that a value is
// not a secret — a credential may itself contain the filler. Mask provenance
// comes from masking at ingestion; this only stops a caller that forgot to mask
// from writing an obviously unmasked value into a display column.
func IsMask(value string) bool {
	value = strings.TrimSpace(value)
	if value == "" {
		return false
	}
	if strings.ContainsAny(value, " \t\r\n") {
		return false
	}
	return strings.Contains(value, MaskRun) || strings.Contains(value, legacyMaskRun)
}

// MaskIP keeps only a coarse network prefix. Invalid input is omitted.
//
// Idempotent by construction, because masking runs twice on one record: the
// ingest decoder masks the payload and the persistence boundary masks the
// decoded event again. A CIDR is therefore reduced back to its address and
// re-masked, which also stops a narrow prefix (a /32 is a whole address) from
// being passed through as though it were already anonymized.
func MaskIP(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if host, port, err := net.SplitHostPort(value); err == nil {
		if port != "" {
			number, errPort := strconv.Atoi(port)
			if errPort != nil || number < 0 || number > 65535 {
				return nil
			}
		}
		value = host
	}
	value = strings.Trim(value, "[]")
	if strings.Contains(value, "/") {
		address, _, err := net.ParseCIDR(value)
		if err != nil {
			return nil
		}
		value = address.String()
	}
	parsed := net.ParseIP(value)
	if parsed == nil {
		return nil
	}
	if v4 := parsed.To4(); v4 != nil {
		v4[3] = 0
		masked := v4.String() + "/24"
		return &masked
	}
	v6 := parsed.To16()
	for index := 8; index < len(v6); index++ {
		v6[index] = 0
	}
	masked := v6.String() + "/64"
	return &masked
}

// MaskForwardedFor uses only the first forwarded hop.
func MaskForwardedFor(value string) *string {
	for _, part := range strings.Split(value, ",") {
		if masked := MaskIP(strings.TrimSpace(part)); masked != nil {
			return masked
		}
	}
	return nil
}

// NormalizeClientIP preserves the diagnostic client address while removing the
// transport port and canonicalizing equivalent IPv6 spellings. Unlike MaskIP,
// this is not a privacy projection: it is used only for the protected request
// detail view, never for list/search payloads or authorization decisions.
func NormalizeClientIP(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if host, port, err := net.SplitHostPort(value); err == nil {
		if port != "" {
			number, errPort := strconv.Atoi(port)
			if errPort != nil || number < 0 || number > 65535 {
				return nil
			}
		}
		value = host
	}
	value = strings.Trim(value, "[]")
	if value == "" || strings.Contains(value, "/") {
		return nil
	}
	parsed := net.ParseIP(value)
	if parsed == nil {
		return nil
	}
	normalized := parsed.String()
	return &normalized
}

// NormalizeForwardedFor preserves every valid hop in a proxy chain, in the order
// the upstream sent it. Invalid or empty hops are omitted rather than allowing a
// malformed diagnostic header to become an unbounded stored string.
func NormalizeForwardedFor(value string) *string {
	const (
		maxHops  = 32
		maxRunes = 2048
	)
	hops := make([]string, 0, maxHops)
	for _, part := range strings.Split(value, ",") {
		if len(hops) >= maxHops {
			break
		}
		if normalized := NormalizeClientIP(strings.TrimSpace(part)); normalized != nil {
			hops = append(hops, *normalized)
		}
	}
	if len(hops) == 0 {
		return nil
	}
	normalized := boundedRunes(strings.Join(hops, ", "), maxRunes)
	if normalized == "" {
		return nil
	}
	return &normalized
}

// MinimizeUserAgent keeps a short diagnostic product label.
func MinimizeUserAgent(value string) *string {
	value = RedactText(value)
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	fields := strings.Fields(value)
	if len(fields) > 0 {
		value = fields[0]
	}
	value = boundedRunes(value, 128)
	if value == "" || value == RedactedValue {
		return nil
	}
	return &value
}

func sortedSecrets(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			result = append(result, value)
		}
	}
	sort.Slice(result, func(i, j int) bool { return len(result[i]) > len(result[j]) })
	return result
}

func stripControl(value string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == '\t' || !unicode.IsControl(r) {
			return r
		}
		return -1
	}, value)
}

func boundedRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return value
}
