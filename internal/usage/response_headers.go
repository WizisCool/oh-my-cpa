package usage

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// ResponseHeader is one upstream response header kept for diagnosis.
type ResponseHeader struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Bounds on the stored header snapshot. It rides on every request record, so
// it is kept to what a diagnosis reads rather than what the upstream sent.
const (
	MaxResponseHeaders          = 48
	MaxResponseHeaderNameRunes  = 128
	MaxResponseHeaderValueRunes = 512
)

// transportResponseHeaders describe how the bytes travelled, not what the
// upstream decided. They are the same on every request and explain no failure.
var transportResponseHeaders = map[string]struct{}{
	"accept-ranges": {}, "access-control-allow-credentials": {}, "access-control-allow-headers": {},
	"access-control-allow-methods": {}, "access-control-allow-origin": {}, "access-control-expose-headers": {},
	"access-control-max-age": {}, "alt-svc": {}, "cache-control": {}, "connection": {},
	"content-encoding": {}, "content-length": {}, "content-security-policy": {}, "content-type": {},
	"cross-origin-opener-policy": {}, "date": {}, "expires": {}, "keep-alive": {}, "nel": {},
	"permissions-policy": {}, "pragma": {}, "referrer-policy": {}, "report-to": {},
	"strict-transport-security": {}, "transfer-encoding": {}, "vary": {},
	"x-content-type-options": {}, "x-frame-options": {}, "x-xss-protection": {},
}

// credentialHeaderMarkers name headers whose value is, or can carry, a
// credential or a session. A marker matches anywhere in the name because
// providers invent their own spellings.
var credentialHeaderMarkers = []string{
	"cookie", "authorization", "authenticate", "token", "secret", "password",
	"api-key", "apikey", "signature", "session", "credential",
}

// FilterResponseHeaders reduces an upstream header snapshot to its diagnostic
// part: transport headers and anything that can carry a credential are dropped,
// values are redacted and bounded, and the result is sorted by name.
func FilterResponseHeaders(headers map[string][]string) []ResponseHeader {
	merged := make(map[string]string, len(headers))
	for rawName, values := range headers {
		name := strings.ToLower(strings.TrimSpace(rawName))
		if name == "" || len([]rune(name)) > MaxResponseHeaderNameRunes || !isDiagnosticHeader(name) {
			continue
		}
		value := boundedSafe(strings.Join(values, ", "), MaxResponseHeaderValueRunes)
		if value == "" {
			continue
		}
		if existing, ok := merged[name]; ok {
			value = boundedSafe(existing+", "+value, MaxResponseHeaderValueRunes)
		}
		merged[name] = value
	}
	filtered := make([]ResponseHeader, 0, len(merged))
	for name, value := range merged {
		filtered = append(filtered, ResponseHeader{Name: name, Value: value})
	}
	sort.Slice(filtered, func(i, j int) bool { return filtered[i].Name < filtered[j].Name })
	if len(filtered) > MaxResponseHeaders {
		filtered = filtered[:MaxResponseHeaders]
	}
	return filtered
}

func isDiagnosticHeader(name string) bool {
	if _, isTransport := transportResponseHeaders[name]; isTransport {
		return false
	}
	for _, marker := range credentialHeaderMarkers {
		if strings.Contains(name, marker) {
			return false
		}
	}
	return security.RedactText(name) == name
}

// EncodeResponseHeaders is the stored form: a JSON object, empty when there is
// nothing to keep so the common case costs the row no bytes.
func EncodeResponseHeaders(headers []ResponseHeader) string {
	if len(headers) == 0 {
		return ""
	}
	object := make(map[string]string, len(headers))
	for _, header := range headers {
		object[header.Name] = header.Value
	}
	encoded, err := json.Marshal(object)
	if err != nil {
		return ""
	}
	return string(encoded)
}

// DecodeResponseHeaders reads the stored form back through the same filter, so
// a row written by any path is held to the rules above when it is shown.
func DecodeResponseHeaders(stored string) []ResponseHeader {
	if strings.TrimSpace(stored) == "" {
		return nil
	}
	var object map[string]string
	if err := json.Unmarshal([]byte(stored), &object); err != nil {
		return nil
	}
	headers := make(map[string][]string, len(object))
	for name, value := range object {
		headers[name] = []string{value}
	}
	return FilterResponseHeaders(headers)
}

// responseHeadersFromPayload accepts CPA's map of value lists and, for a build
// that flattens them, a map of single values. Anything else is not a header
// snapshot, and a record must not be rejected over its diagnostics.
func responseHeadersFromPayload(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var lists map[string][]string
	if err := json.Unmarshal(raw, &lists); err != nil {
		var singles map[string]string
		if errSingles := json.Unmarshal(raw, &singles); errSingles != nil {
			return ""
		}
		lists = make(map[string][]string, len(singles))
		for name, value := range singles {
			lists[name] = []string{value}
		}
	}
	return EncodeResponseHeaders(FilterResponseHeaders(lists))
}
