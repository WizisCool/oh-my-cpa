package api

import (
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

/**
 * The plugin system's host settings: the global switch, the third-party store
 * registries and the store authentication rules.
 *
 * They live under `plugins` in CPA's configuration and are written as a sparse v8
 * change to exactly those keys. The write is the same transaction a configuration
 * save is: it holds the provider write gate and the configuration mutex, and it is
 * refused when the document changed since the operator loaded it
 * (`config_conflict`), so it can never overwrite an edit made on the configuration
 * page or by another session.
 */

const (
	// maxPluginStoreSources bounds the extra registries one save may declare. Each one
	// is fetched on every store read, so a long list is a slow page, not a feature.
	maxPluginStoreSources = 32
	// maxPluginStoreAuthRules bounds the authentication rules, for the same reason the
	// source list is bounded.
	maxPluginStoreAuthRules = 64
)

// pluginStoreAuthTypes are the rule types CPA's store client understands.
var pluginStoreAuthTypes = map[string]bool{
	"none": true, "bearer": true, "github-token": true, "basic": true, "header": true,
}

// pluginStoreAuthTargets are the request kinds a rule may apply to.
var pluginStoreAuthTargets = map[string]bool{"registry": true, "metadata": true, "artifact": true}

var (
	environmentVariableName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
	httpHeaderName          = regexp.MustCompile(`^[!#$%&'*+.^_` + "`" + `|~0-9A-Za-z-]{1,128}$`)
)

type PluginStoreAuthRuleDTO struct {
	Match          string   `json:"match"`
	ApplyTo        []string `json:"apply_to"`
	Type           string   `json:"type"`
	TokenEnv       string   `json:"token_env,omitempty"`
	UsernameEnv    string   `json:"username_env,omitempty"`
	PasswordEnv    string   `json:"password_env,omitempty"`
	HeaderName     string   `json:"header_name,omitempty"`
	HeaderValueEnv string   `json:"header_value_env,omitempty"`
	AllowInsecure  bool     `json:"allow_insecure"`
}

type PluginSettingsDTO struct {
	Revision     string                   `json:"revision"`
	Enabled      bool                     `json:"enabled"`
	Dir          string                   `json:"dir"`
	StoreSources []string                 `json:"store_sources"`
	StoreAuth    []PluginStoreAuthRuleDTO `json:"store_auth"`
}

type putPluginSettingsRequest struct {
	Revision     string                   `json:"revision"`
	Enabled      *bool                    `json:"enabled"`
	StoreSources []string                 `json:"store_sources"`
	StoreAuth    []PluginStoreAuthRuleDTO `json:"store_auth"`
}

func projectPluginSettings(revision string, settings configyaml.PluginSettings) PluginSettingsDTO {
	dto := PluginSettingsDTO{
		Revision:     revision,
		Enabled:      settings.Enabled,
		Dir:          boundedText(settings.Dir, pluginTextLimit),
		StoreSources: boundedPluginList(settings.StoreSources),
		StoreAuth:    make([]PluginStoreAuthRuleDTO, 0, len(settings.StoreAuth)),
	}
	if dto.Dir == "" {
		dto.Dir = "plugins"
	}
	for _, rule := range settings.StoreAuth {
		ruleType := strings.ToLower(strings.TrimSpace(rule.Type))
		if ruleType == "" {
			ruleType = "none"
		}
		applyTo := boundedPluginList(rule.ApplyTo)
		dto.StoreAuth = append(dto.StoreAuth, PluginStoreAuthRuleDTO{
			Match:          boundedText(rule.Match, pluginTextLimit),
			ApplyTo:        applyTo,
			Type:           ruleType,
			TokenEnv:       boundedText(rule.TokenEnv, 128),
			UsernameEnv:    boundedText(rule.UsernameEnv, 128),
			PasswordEnv:    boundedText(rule.PasswordEnv, 128),
			HeaderName:     boundedText(rule.HeaderName, 128),
			HeaderValueEnv: boundedText(rule.HeaderValueEnv, 128),
			AllowInsecure:  rule.AllowInsecure,
		})
	}
	return dto
}

func (h *Handler) getPluginSettings(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	rawYAML, err := client.ConfigYAML(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	settings, err := configyaml.ReadPluginSettings(rawYAML)
	if err != nil {
		writePluginSettingsUnreadable(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, projectPluginSettings(configyaml.ComputeRevision(rawYAML), settings))
}

func writePluginSettingsUnreadable(writer http.ResponseWriter, err error) {
	writeJSON(writer, http.StatusUnprocessableEntity, map[string]any{
		"error": fmt.Sprintf("the plugins section of the configuration cannot be read: %v", err),
		"code":  "plugin_settings_unreadable",
	})
}

// validatePluginSettings normalizes a submitted settings document the way CPA would
// read it, and refuses what CPA would silently drop or reject at the next reload: a
// rule without a match, an unknown type, a credential variable that is not a name.
func validatePluginSettings(req putPluginSettingsRequest) (configyaml.PluginSettings, error) {
	settings := configyaml.PluginSettings{Enabled: *req.Enabled}
	if len(req.StoreSources) > maxPluginStoreSources {
		return settings, fmt.Errorf("at most %d store sources are allowed", maxPluginStoreSources)
	}
	seenSources := map[string]bool{}
	for _, source := range req.StoreSources {
		source = strings.TrimSpace(source)
		if source == "" || seenSources[source] {
			continue
		}
		if !isRegistryURL(source) {
			return settings, fmt.Errorf("store source %q must be an absolute http(s) URL", boundedText(source, 256))
		}
		seenSources[source] = true
		settings.StoreSources = append(settings.StoreSources, source)
	}

	if len(req.StoreAuth) > maxPluginStoreAuthRules {
		return settings, fmt.Errorf("at most %d store auth rules are allowed", maxPluginStoreAuthRules)
	}
	for index, rule := range req.StoreAuth {
		label := fmt.Sprintf("store auth rule %d", index+1)
		normalized := configyaml.PluginStoreAuthRule{
			Match:         strings.TrimSpace(rule.Match),
			Type:          strings.ToLower(strings.TrimSpace(rule.Type)),
			AllowInsecure: rule.AllowInsecure,
		}
		if normalized.Match == "" || len(normalized.Match) > pluginTextLimit {
			return settings, fmt.Errorf("%s needs a URL prefix to match", label)
		}
		if normalized.Type == "" {
			normalized.Type = "none"
		}
		if !pluginStoreAuthTypes[normalized.Type] {
			return settings, fmt.Errorf("%s has an unknown type %q", label, boundedText(normalized.Type, 64))
		}
		seenTargets := map[string]bool{}
		for _, target := range rule.ApplyTo {
			target = strings.ToLower(strings.TrimSpace(target))
			if target == "" || seenTargets[target] {
				continue
			}
			if !pluginStoreAuthTargets[target] {
				return settings, fmt.Errorf("%s applies to an unknown request kind %q", label, boundedText(target, 64))
			}
			seenTargets[target] = true
			normalized.ApplyTo = append(normalized.ApplyTo, target)
		}
		requireEnv := func(field, value string) (string, error) {
			value = strings.TrimSpace(value)
			if !environmentVariableName.MatchString(value) {
				return "", fmt.Errorf("%s needs an environment variable name for %s", label, field)
			}
			return value, nil
		}
		var err error
		// Only the variables the rule's type reads are written, so switching a rule's
		// type does not leave a stale credential reference behind in the file.
		switch normalized.Type {
		case "bearer", "github-token":
			normalized.TokenEnv, err = requireEnv("the token", rule.TokenEnv)
		case "basic":
			if normalized.UsernameEnv, err = requireEnv("the username", rule.UsernameEnv); err == nil {
				normalized.PasswordEnv, err = requireEnv("the password", rule.PasswordEnv)
			}
		case "header":
			normalized.HeaderName = strings.TrimSpace(rule.HeaderName)
			if !httpHeaderName.MatchString(normalized.HeaderName) {
				err = fmt.Errorf("%s needs a valid header name", label)
			} else {
				normalized.HeaderValueEnv, err = requireEnv("the header value", rule.HeaderValueEnv)
			}
		}
		if err != nil {
			return settings, err
		}
		settings.StoreAuth = append(settings.StoreAuth, normalized)
	}
	return settings, nil
}

func isRegistryURL(raw string) bool {
	if len(raw) > pluginTextLimit {
		return false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || parsed.User != nil {
		return false
	}
	scheme := strings.ToLower(parsed.Scheme)
	return scheme == "https" || scheme == "http"
}

func (h *Handler) putPluginSettings(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")

	var req putPluginSettingsRequest
	if err := decodeManagementJSON(writer, request, 256*1024, &req); err != nil {
		return
	}
	expectedRevision := strings.Trim(strings.TrimSpace(req.Revision), `"`)
	if expectedRevision == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{
			"error": "config revision is required for conflict protection",
			"code":  "missing_revision",
		})
		return
	}
	if req.Enabled == nil {
		writeError(writer, http.StatusBadRequest, "enabled is required")
		return
	}
	settings, err := validatePluginSettings(req)
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": err.Error(), "code": "plugin_settings_invalid"})
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	// The same gate and mutex a configuration save holds, so the revision this
	// write is checked against cannot change between the check and the write.
	if err := h.providerWrites.acquire(request.Context()); err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	defer h.providerWrites.release()
	h.configMu.Lock()
	defer h.configMu.Unlock()

	currentYAML, ok := h.currentConfigAtRevision(writer, request, client, expectedRevision)
	if !ok {
		return
	}
	// A section CPA itself would not load is refused rather than written over.
	if _, err := configyaml.ReadPluginSettings(currentYAML); err != nil {
		writePluginSettingsUnreadable(writer, err)
		return
	}
	set, remove, err := configyaml.PluginSettingsEdit(settings)
	if err != nil {
		writeError(writer, http.StatusUnprocessableEntity, "the configuration cannot be edited: "+err.Error())
		return
	}
	changes := make([]management.ConfigChange, 0, len(set)+len(remove))
	for key, value := range set {
		changes = append(changes, management.ConfigChange{Path: []string{"plugins", key}, Value: value})
	}
	for _, key := range remove {
		changes = append(changes, management.ConfigChange{Path: []string{"plugins", key}, Remove: true})
	}

	details := map[string]any{
		"enabled":       settings.Enabled,
		"store_sources": len(settings.StoreSources),
		"store_auth":    len(settings.StoreAuth),
	}
	if auditErr := h.recordAudit(request, "plugin.settings", "config", "plugins", "attempt", details); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; plugin settings save aborted")
		return
	}
	if err := client.ApplyConfigChanges(request.Context(), changes); err != nil {
		_ = h.recordAudit(request, "plugin.settings", "config", "plugins", "failure", map[string]any{"error": publicCPAErrorMessage(err)})
		writeCPAFacadeError(writer, err)
		return
	}
	_ = h.recordAudit(request, "plugin.settings", "config", "plugins", "success", details)

	savedYAML, err := client.ConfigYAML(request.Context())
	if err != nil {
		// The write landed; the answer is what was sent, without a revision, so
		// the page reloads before its next save.
		writeJSON(writer, http.StatusOK, projectPluginSettings("", settings))
		return
	}
	stored, err := configyaml.ReadPluginSettings(savedYAML)
	if err != nil {
		stored = settings
	}
	writeJSON(writer, http.StatusOK, projectPluginSettings(configyaml.ComputeRevision(savedYAML), stored))
}
