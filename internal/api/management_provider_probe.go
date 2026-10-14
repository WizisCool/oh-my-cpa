package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

const probeTimeout = 30 * time.Second
const probeMaxErrorSnippet = 300

var errInvalidProbeURL = errors.New("invalid probe URL")
var errProbeRedirectRefused = errors.New("probe redirect refused")

type probeProviderRequest struct {
	ProviderID string            `json:"provider_id"`
	Family     string            `json:"family"`
	BaseURL    string            `json:"base_url"`
	APIKey     string            `json:"api_key"`
	ProxyURL   string            `json:"proxy_url"`
	Model      string            `json:"model"`
	Headers    map[string]string `json:"headers"`
	// Interactions selects the Interactions dialect for a vertex draft whose
	// stored entry has not been read; stored entries resolve it server-side.
	Interactions bool `json:"interactions,omitempty"`
}

// probeSpec is the fixed minimal inference request one provider family is
// tested with. The shapes mirror CPAMC's connectivity test: a short "Hi"
// through the family's own dialect, so a key that passes can actually serve.
type probeSpec struct {
	target string
	body   map[string]any
	apply  func(header http.Header, apiKey string)
}

func probeEndpointForFamily(family, baseURL, model string) (probeSpec, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	join := func(suffix string) string { return trimmed + suffix }
	switch family {
	case openAICompatibilityFamily:
		if trimmed == "" {
			return probeSpec{}, fmt.Errorf("%w: base URL is required", errInvalidProbeURL)
		}
		target := trimmed
		if !strings.HasSuffix(strings.ToLower(target), "/chat/completions") {
			target = join("/chat/completions")
		}
		return probeSpec{
			target: target,
			body:   map[string]any{"model": model, "messages": []any{map[string]any{"role": "user", "content": "Hi"}}, "stream": false, "max_tokens": 5},
			apply: func(header http.Header, apiKey string) {
				setProbeAuthHeader(header, "Authorization", "Bearer "+apiKey)
			},
		}, nil
	case string(management.ConfigFamilyCodex), string(management.ConfigFamilyMeta), string(management.ConfigFamilyXAI):
		if trimmed == "" {
			return probeSpec{}, fmt.Errorf("%w: base URL is required", errInvalidProbeURL)
		}
		lower := strings.ToLower(trimmed)
		target := trimmed
		switch {
		case strings.HasSuffix(lower, "/v1/responses"):
		case strings.HasSuffix(lower, "/v1/models"):
			target = trimmed[:len(trimmed)-len("/models")] + "/responses"
		case strings.HasSuffix(lower, "/v1"):
			target = join("/responses")
		default:
			target = join("/responses")
		}
		return probeSpec{
			target: target,
			body:   map[string]any{"model": model, "input": "Hi", "stream": false},
			apply: func(header http.Header, apiKey string) {
				setProbeAuthHeader(header, "Authorization", "Bearer "+apiKey)
			},
		}, nil
	case string(management.ConfigFamilyClaude):
		if trimmed == "" {
			trimmed = "https://api.anthropic.com"
		}
		target := trimmed
		switch {
		case strings.HasSuffix(target, "/v1/messages"):
		case strings.HasSuffix(target, "/v1"):
			target = join("/messages")
		default:
			target = join("/v1/messages")
		}
		return probeSpec{
			target: target,
			body:   map[string]any{"model": model, "max_tokens": 8, "messages": []any{map[string]any{"role": "user", "content": "Hi"}}},
			apply: func(header http.Header, apiKey string) {
				setProbeAuthHeader(header, "anthropic-version", "2023-06-01")
				if header.Get("x-api-key") == "" {
					if bearer := probeBearerToken(header); bearer != "" {
						header.Set("x-api-key", bearer)
					} else {
						header.Set("x-api-key", apiKey)
					}
				}
			},
		}, nil
	case string(management.ConfigFamilyGemini):
		if trimmed == "" {
			trimmed = "https://generativelanguage.googleapis.com"
		}
		resource := probeGeminiResource(model)
		if resource == "" {
			return probeSpec{}, fmt.Errorf("%w: model is required", errInvalidProbeURL)
		}
		root := trimmed
		if strings.HasSuffix(strings.ToLower(root), ":generatecontent") {
			return probeSpec{
				target: root,
				body:   map[string]any{"contents": []any{map[string]any{"parts": []any{map[string]any{"text": "Hi"}}}}, "generationConfig": map[string]any{"maxOutputTokens": 8}},
				apply: func(header http.Header, apiKey string) {
					setProbeAuthHeader(header, "x-goog-api-key", apiKey)
				},
			}, nil
		}
		lower := strings.ToLower(root)
		switch {
		case strings.HasSuffix(lower, "/v1beta/models"):
			root = root[:len(root)-len("/models")]
		case !strings.HasSuffix(lower, "/v1beta"):
			if index := strings.LastIndex(lower, "/v1beta/"); index >= 0 {
				root = root[:index]
			}
			root += "/v1beta"
		}
		return probeSpec{
			target: root + "/" + resource + ":generateContent",
			body:   map[string]any{"contents": []any{map[string]any{"parts": []any{map[string]any{"text": "Hi"}}}}, "generationConfig": map[string]any{"maxOutputTokens": 8}},
			apply: func(header http.Header, apiKey string) {
				setProbeAuthHeader(header, "x-goog-api-key", apiKey)
			},
		}, nil
	case string(management.ConfigFamilyVertex):
		// Vertex-compatible entries are served from a publishers resource:
		// CPA appends "/v1/publishers/google/models/{model}:action" to the
		// configured base, defaulting to the Vertex API base URL.
		if trimmed == "" {
			trimmed = "https://aiplatform.googleapis.com"
		}
		resource := probeGeminiResource(model)
		if resource == "" {
			return probeSpec{}, fmt.Errorf("%w: model is required", errInvalidProbeURL)
		}
		vertexModel := resource
		if len(vertexModel) > len("models/") && strings.EqualFold(vertexModel[:len("models/")], "models/") {
			vertexModel = vertexModel[len("models/"):]
		}
		lower := strings.ToLower(trimmed)
		target := trimmed
		switch {
		case strings.HasSuffix(lower, ":generatecontent"):
		case strings.HasSuffix(lower, "/v1"):
			target = trimmed + "/publishers/google/models/" + vertexModel + ":generateContent"
		case strings.Contains(lower, "/publishers/"):
			root := strings.TrimRight(trimmed, "/")
			if strings.HasSuffix(strings.ToLower(root), "/models") {
				root = root[:len(root)-len("/models")]
			}
			target = root + "/models/" + vertexModel + ":generateContent"
		default:
			target = trimmed + "/v1/publishers/google/models/" + vertexModel + ":generateContent"
		}
		return probeSpec{
			target: target,
			body:   map[string]any{"contents": []any{map[string]any{"parts": []any{map[string]any{"text": "Hi"}}}}, "generationConfig": map[string]any{"maxOutputTokens": 8}},
			apply: func(header http.Header, apiKey string) {
				setProbeAuthHeader(header, "x-goog-api-key", apiKey)
			},
		}, nil
	case string(management.ConfigFamilyInteractions):
		if trimmed == "" {
			trimmed = "https://generativelanguage.googleapis.com"
		}
		target := trimmed
		lower := strings.ToLower(target)
		if !strings.HasSuffix(lower, "/v1beta/interactions") {
			root := strings.TrimRight(target, "/")
			if strings.HasSuffix(strings.ToLower(root), "/v1beta/models") {
				root = root[:len(root)-len("/models")]
			} else if !strings.HasSuffix(strings.ToLower(root), "/v1beta") {
				if index := strings.LastIndex(strings.ToLower(root), "/v1beta/"); index >= 0 {
					root = root[:index]
				}
				root += "/v1beta"
			}
			target = root + "/interactions"
		}
		return probeSpec{
			target: target,
			body:   map[string]any{"model": model, "input": "Hi"},
			apply: func(header http.Header, apiKey string) {
				setProbeAuthHeader(header, "x-goog-api-key", apiKey)
				setProbeAuthHeader(header, "Api-Revision", "2026-05-20")
			},
		}, nil
	}
	return probeSpec{}, fmt.Errorf("%w: unsupported family %q", errInvalidProbeURL, family)
}

func probeGeminiResource(model string) string {
	trimmed := strings.TrimSpace(model)
	trimmed = strings.TrimLeft(trimmed, "/")
	if index := strings.LastIndex(strings.ToLower(trimmed), ":generatecontent"); index >= 0 {
		trimmed = trimmed[:index]
	}
	if trimmed == "" {
		return ""
	}
	if lower := strings.ToLower(trimmed); strings.HasPrefix(lower, "models/") || strings.HasPrefix(lower, "tunedmodels/") {
		parts := strings.Split(trimmed, "/")
		for index, part := range parts {
			parts[index] = url.PathEscape(part)
		}
		return strings.Join(parts, "/")
	}
	return "models/" + url.PathEscape(trimmed)
}

func setProbeAuthHeader(header http.Header, key, value string) {
	if header.Get(key) == "" && value != "" {
		header.Set(key, value)
	}
}

// probeBearerToken reuses an Authorization bearer the operator already placed
// in custom headers, the way CPAMC prefers an explicit key, then a stored one,
// then the bearer from the form headers.
func probeBearerToken(header http.Header) string {
	for key, values := range header {
		if strings.EqualFold(key, "authorization") && len(values) > 0 {
			if match := strings.Fields(values[0]); len(match) == 2 && strings.EqualFold(match[0], "bearer") {
				return strings.TrimSpace(match[1])
			}
		}
	}
	return ""
}

func probeSecrets(apiKey string, headers map[string]string) []string {
	secrets := []string{apiKey}
	for _, value := range headers {
		secrets = append(secrets, value)
		// An upstream may echo the credential without its scheme, so its
		// substrings redact too. Fragments stay long enough to avoid
		// redacting ordinary prose that happens to share a short word.
		for _, field := range strings.FieldsFunc(value, func(rune rune) bool {
			switch rune {
			case ' ', '\t', '"', '\'', ',', ';', '=', '&', '?', ':', '/', '(', ')', '[', ']', '{', '}':
				return true
			}
			return false
		}) {
			if len(field) >= 8 {
				secrets = append(secrets, field)
			}
		}
	}
	return secrets
}

// probeProvider answers whether one provider entry can actually serve: it sends
// the family's fixed minimal inference request with the operator's values and
// reports the outcome. Stored entries resolve server-side through provider_id,
// so the browser never holds their secrets; typed values win over stored ones.
// The upstream body is discarded — only the status and a redacted snippet come
// back, so a relay that echoes the request cannot hand the key to the caller.
func (h *Handler) probeProvider(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req probeProviderRequest
	if err := decodeManagementJSON(writer, request, 32*1024, &req); err != nil {
		return
	}

	baseURL := strings.TrimSpace(req.BaseURL)
	apiKey := strings.TrimSpace(req.APIKey)
	proxyURL := strings.TrimSpace(req.ProxyURL)
	headers := req.Headers
	family := strings.ToLower(strings.TrimSpace(req.Family))
	model := strings.TrimSpace(req.Model)
	// storedBaseURL and storedKey record what the stored entry carries, so a
	// stored key is never sent to a destination it was not configured for.
	// storedInteractions does the same for the vertex dialect switch.
	storedBaseURL := ""
	storedKey := ""
	storedInteractions := false

	if req.ProviderID != "" {
		if client, ok := h.managementClientOrError(writer, request); ok {
			storedFamily, index, err := parseProviderID(req.ProviderID)
			if err == nil && index >= 0 {
				ctx := request.Context()
				switch {
				case storedFamily == openAICompatibilityFamily:
					if resp, err := client.OpenAICompatibility(ctx); err == nil && index < len(resp.Entries) {
						entry := resp.Entries[index]
						storedBaseURL = entry.BaseURL
						if len(entry.APIKeyEntries) > 0 {
							stored := entry.APIKeyEntries[0]
							storedKey = stored.APIKey
							baseURL, apiKey, proxyURL, headers = mergeProbeDefaults(entry.BaseURL, stored.APIKey, stored.ProxyURL, entry.Headers, baseURL, apiKey, proxyURL, headers)
						} else {
							baseURL, _, proxyURL, headers = mergeProbeDefaults(entry.BaseURL, "", "", entry.Headers, baseURL, apiKey, proxyURL, headers)
						}
					}
				default:
					if spec, isConfigFamily := lookupProviderConfigFamily(storedFamily); isConfigFamily {
						if entries, err := client.ConfigAPIKeys(ctx, spec.Family); err == nil && index < len(entries) {
							entry := entries[index]
							storedBaseURL = entry.BaseURL
							storedKey = entry.APIKey
							storedInteractions = entry.Interactions
							baseURL, apiKey, proxyURL, headers = mergeProbeDefaults(entry.BaseURL, entry.APIKey, entry.ProxyURL, entry.Headers, baseURL, apiKey, proxyURL, headers)
						}
					}
				}
				if family == "" {
					family = storedFamily
				}
			}
		} else {
			return
		}
	}

	if family == "" || model == "" {
		writeError(writer, http.StatusBadRequest, "family and model are required")
		return
	}
	// A vertex entry with Interactions enabled is served through the
	// Interactions dialect, so it probes as one: the builder, body and
	// headers below all follow the effective dialect, not the entry family.
	if family == string(management.ConfigFamilyVertex) && (req.Interactions || storedInteractions) {
		family = string(management.ConfigFamilyInteractions)
	}
	// A stored key travels only to its configured endpoint (or the family's
	// default when none is configured): probing another URL with it needs the
	// key retyped, so a stored secret never leaves for a caller-chosen host.
	if strings.TrimSpace(req.APIKey) == "" && storedKey != "" && !probeDestinationMatches(storedBaseURL, strings.TrimSpace(req.BaseURL)) {
		writeError(writer, http.StatusBadRequest, "the stored key is only sent to its configured endpoint; retype the key to probe a different URL")
		return
	}
	// Stored headers can carry their own bearer, so they stay behind with the
	// key: a probe aimed elsewhere carries only the headers its caller typed.
	if req.ProviderID != "" && !probeDestinationMatches(storedBaseURL, strings.TrimSpace(req.BaseURL)) {
		headers = req.Headers
	}
	// A caller-chosen proxy sees the request in transit, so only credentials
	// the caller typed may travel through it: borrowing stored secrets while
	// naming another proxy needs the key retyped, like a changed base URL.
	if req.ProviderID != "" && strings.TrimSpace(req.ProxyURL) != "" {
		apiKey = strings.TrimSpace(req.APIKey)
		headers = req.Headers
	}
	secrets := probeSecrets(apiKey, headers)
	spec, err := probeEndpointForFamily(family, baseURL, model)
	if err != nil {
		writeError(writer, http.StatusBadRequest, security.RedactText(err.Error(), secrets...))
		return
	}
	parsed, err := url.Parse(spec.target)
	if err != nil || !isModelPullURLAllowed(parsed) {
		writeError(writer, http.StatusBadRequest, "probe URL must use HTTPS unless it targets localhost, a loopback address, or a private IP address")
		return
	}
	if apiKey == "" && probeBearerToken(headerFromMap(headers)) == "" && !hasProbeAuthHeader(headers, family) {
		writeError(writer, http.StatusBadRequest, "api_key is required")
		return
	}

	// The probe exercises a credential outside the process, so the attempt is
	// audited before anything is sent, and a lost audit record aborts the
	// probe. The row names the family and the target host, never the key.
	auditTarget := req.ProviderID
	if auditTarget == "" {
		auditTarget = parsed.Host
	}
	if err := h.recordAudit(request, "provider.probe", "provider", auditTarget, "attempt", map[string]any{"family": family, "host": parsed.Host}); err != nil {
		writeAuditFailure(writer, "audit log failure; provider probe aborted")
		return
	}
	auditOutcome := func(result string, details map[string]any) {
		if details == nil {
			details = map[string]any{}
		}
		details["family"] = family
		details["host"] = parsed.Host
		_ = h.recordAudit(request, "provider.probe", "provider", auditTarget, result, details)
	}

	payload, err := json.Marshal(spec.body)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "failed to encode probe request")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), probeTimeout)
	defer cancel()
	outgoing, err := http.NewRequestWithContext(ctx, http.MethodPost, spec.target, bytes.NewReader(payload))
	if err != nil {
		writeJSON(writer, http.StatusOK, map[string]any{"ok": false, "error": security.RedactText(err.Error(), secrets...)})
		return
	}
	outgoing.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		outgoing.Header.Set(key, value)
	}
	spec.apply(outgoing.Header, apiKey)

	transport := &http.Transport{Proxy: http.ProxyFromEnvironment}
	if proxyURL != "" {
		// A proxy the operator named must be the path taken: falling back to
		// a direct connection on a parse failure would silently change it.
		parsedProxy, err := url.Parse(proxyURL)
		if err != nil || parsedProxy.Host == "" {
			writeError(writer, http.StatusBadRequest, "proxy_url is not a valid URL")
			return
		}
		transport.Proxy = http.ProxyURL(parsedProxy)
	}
	client := &http.Client{
		Timeout:       probeTimeout,
		Transport:     transport,
		CheckRedirect: sameOriginRedirectGuard(errProbeRedirectRefused, MAX_MODEL_PULL_REDIRECTS),
	}
	resp, err := client.Do(outgoing)
	if err != nil {
		if errors.Is(err, errProbeRedirectRefused) {
			// The refusal names no destination: client.Do wraps the guard
			// error in a url.Error whose method and URL repeat the
			// upstream-controlled redirect target, which may echo a
			// credential back. The guard's own reason carries no URL.
			refusal := errProbeRedirectRefused.Error()
			var urlErr *url.Error
			if errors.As(err, &urlErr) && urlErr.Err != nil {
				refusal = urlErr.Err.Error()
			}
			refusal = security.RedactText(refusal, secrets...)
			auditOutcome("failure", map[string]any{"error": refusal})
			writeJSON(writer, http.StatusOK, map[string]any{"ok": false, "error": refusal})
			return
		}
		auditOutcome("failure", map[string]any{"error": security.RedactText(probeTransportError(err), secrets...)})
		writeJSON(writer, http.StatusOK, map[string]any{"ok": false, "error": security.RedactText(probeTransportError(err), secrets...)})
		return
	}
	defer resp.Body.Close()
	// The body is evidence about the provider, not content the console needs:
	// a short redacted snippet names the refusal, the rest is discarded.
	snippet, _ := io.ReadAll(io.LimitReader(resp.Body, probeMaxErrorSnippet))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		auditOutcome("success", map[string]any{"status_code": resp.StatusCode})
		writeJSON(writer, http.StatusOK, map[string]any{"ok": true, "status_code": resp.StatusCode})
		return
	}
	reason := strings.TrimSpace(string(snippet))
	if reason == "" {
		reason = http.StatusText(resp.StatusCode)
	}
	auditOutcome("failure", map[string]any{"status_code": resp.StatusCode})
	writeJSON(writer, http.StatusOK, map[string]any{
		"ok":          false,
		"status_code": resp.StatusCode,
		"error":       fmt.Sprintf("upstream answered %d: %s", resp.StatusCode, security.RedactText(reason, secrets...)),
	})
}

func mergeProbeDefaults(entryBaseURL, entryAPIKey, entryProxyURL string, entryHeaders map[string]string, baseURL, apiKey, proxyURL string, headers map[string]string) (string, string, string, map[string]string) {
	return mergePullDefaults(entryBaseURL, entryAPIKey, entryProxyURL, entryHeaders, baseURL, apiKey, proxyURL, headers)
}

// probeDestinationMatches reports whether a typed base URL names the endpoint
// a stored key is already configured for. An empty typed URL falls back to the
// stored (or family-default) endpoint; anything else must match it, so the
// comparison is a guardrail backed by the audit row, not a canonicalization.
func probeDestinationMatches(storedBaseURL, typedBaseURL string) bool {
	if strings.TrimSpace(typedBaseURL) == "" {
		return true
	}
	if strings.TrimSpace(storedBaseURL) == "" {
		return false
	}
	normalize := func(raw string) string {
		return strings.TrimRight(strings.TrimSpace(raw), "/")
	}
	return normalize(typedBaseURL) == normalize(storedBaseURL)
}

func headerFromMap(headers map[string]string) http.Header {
	outgoing := http.Header{}
	for key, value := range headers {
		outgoing.Set(key, value)
	}
	return outgoing
}

// hasProbeAuthHeader reports whether custom headers already authenticate the
// family's dialect, so a key the operator placed in headers is not demanded
// twice. Vertex and Gemini share the x-goog-api-key dialect.
func hasProbeAuthHeader(headers map[string]string, family string) bool {
	want := "authorization"
	switch family {
	case string(management.ConfigFamilyClaude):
		want = "x-api-key"
	case string(management.ConfigFamilyGemini), string(management.ConfigFamilyVertex), string(management.ConfigFamilyInteractions):
		want = "x-goog-api-key"
	}
	for key := range headers {
		if strings.EqualFold(key, want) {
			return true
		}
	}
	return false
}

func probeTransportError(err error) string {
	var urlErr *url.Error
	if errors.As(err, &urlErr) && urlErr.Timeout() {
		return fmt.Sprintf("probe timed out after %d seconds", int(probeTimeout.Seconds()))
	}
	return err.Error()
}
