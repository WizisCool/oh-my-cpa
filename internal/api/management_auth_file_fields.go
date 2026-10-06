package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// errAuthFileFieldsNotVerified reports a field write whose persisted state could not be confirmed.
var errAuthFileFieldsNotVerified = errors.New("field update could not be verified")

// applyManagementAuthFileFields patches one auth file's safe metadata and verifies the
// runtime projection before reporting success. CPA answers a PATCH as soon as it is
// accepted, so a dropped priority, weight or note would otherwise be reported as saved.
func (h *Handler) applyManagementAuthFileFields(ctx context.Context, client *management.Client, name, authIndex string, fields map[string]any) (map[string]any, error) {
	if _, err := client.PatchAuthFileFields(ctx, name, fields); err != nil {
		return nil, err
	}
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	safeFields := managementAuthFileSafeFields{Name: name}
	hasSafeReadback := managementAuthFileNeedsSafeReadback(fields)
	if hasSafeReadback {
		var readbackErr error
		safeFields, readbackErr = h.readManagementAuthFileSafeFields(ctx, client, name, authIndex)
		if readbackErr != nil {
			return nil, errAuthFileFieldsNotVerified
		}
	}
	files, err := client.AuthFiles(ctx)
	if err != nil {
		return nil, errAuthFileFieldsNotVerified
	}
	file, ok := findManagementAuthFile(files.Files, name, authIndex)
	if !ok {
		return nil, errAuthFileFieldsNotVerified
	}
	if mismatch := managementAuthFileFieldMismatch(fields, file, safeFields); mismatch != "" {
		return nil, fmt.Errorf("%w: CPA did not persist %s", errAuthFileFieldsNotVerified, mismatch)
	}
	payload := map[string]any{"status": "ok", "file": projectManagementAuthFile(file)}
	// A zero-valued projection would tell the drawer that untouched safe fields are
	// empty, so only a verified readback may be published.
	if hasSafeReadback {
		payload["fields"] = safeFields
	}
	return payload, nil
}

func (h *Handler) patchManagementAuthFileFields(writer http.ResponseWriter, request *http.Request) {
	if err := h.providerWrites.acquire(request.Context()); err != nil {
		writeError(writer, http.StatusServiceUnavailable, "management write busy")
		return
	}
	defer h.providerWrites.release()
	var raw map[string]json.RawMessage
	if err := decodeManagementJSON(writer, request, managementAuthFileRequestLimit, &raw); err != nil {
		return
	}
	nameValue, exists := raw["name"]
	if !exists {
		writeError(writer, http.StatusBadRequest, "name is required")
		return
	}
	var name string
	if err := json.Unmarshal(nameValue, &name); err != nil {
		writeError(writer, http.StatusBadRequest, "name is required")
		return
	}
	validatedName, selectorErr := validateAuthSelector(name)
	if selectorErr != nil {
		writeError(writer, http.StatusBadRequest, selectorErr.Error())
		return
	}
	delete(raw, "name")
	authIndex := ""
	if rawAuthIndex, exists := raw["auth_index"]; exists {
		if err := json.Unmarshal(rawAuthIndex, &authIndex); err != nil {
			writeError(writer, http.StatusBadRequest, "auth_index must be a string")
			return
		}
		authIndex = strings.TrimSpace(authIndex)
		if len([]rune(authIndex)) > managementAuthFileNameLimit {
			writeError(writer, http.StatusBadRequest, "auth_index is too long")
			return
		}
		delete(raw, "auth_index")
	}
	fields, err := normalizeManagementAuthFileFields(raw)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if len(fields) == 0 {
		writeError(writer, http.StatusBadRequest, "no fields to update")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	if auditErr := h.recordAudit(request, "auth_file.fields_update", "auth_file", validatedName, "attempt", map[string]any{"fields": sortedMapKeys(fields)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; field update aborted")
		return
	}
	payload, err := h.applyManagementAuthFileFields(request.Context(), client, validatedName, authIndex, fields)
	if err != nil {
		_ = h.recordAudit(request, "auth_file.fields_update", "auth_file", validatedName, "failure", map[string]any{"error": err.Error()})
		if errors.Is(err, errAuthFileFieldsNotVerified) {
			writeError(writer, http.StatusBadGateway, err.Error())
			return
		}
		writeCPAFacadeError(writer, err)
		return
	}
	if auditErr := h.recordAudit(request, "auth_file.fields_update", "auth_file", validatedName, "success", map[string]any{"fields": sortedMapKeys(fields), "verified": true}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure after field update")
		return
	}
	writeJSON(writer, http.StatusOK, payload)
}

func managementAuthFileNeedsSafeReadback(fields map[string]any) bool {
	for key := range fields {
		switch key {
		case "prefix", "proxy_url", "expired", "disable_cooling", "websockets", "using_api", "excluded_models",
			"request_retry", "request_scoped_errors", "model_aliases":
			return true
		}
	}
	return false
}

func projectManagementAuthFileSafeFields(name string, data []byte) (managementAuthFileSafeFields, error) {
	var source map[string]any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := decoder.Decode(&source); err != nil || source == nil {
		return managementAuthFileSafeFields{}, errors.New("auth file is not a JSON object")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return managementAuthFileSafeFields{}, errors.New("auth file must contain one JSON object")
	}
	fields := managementAuthFileSafeFields{Name: name}
	if priority, ok := source["priority"]; ok {
		parsed := intValue(priority)
		fields.Priority = &parsed
	}
	if weight, ok := source["weight"]; ok {
		parsed := int64Value(weight)
		fields.Weight = &parsed
	}
	fields.Prefix = boundedText(stringValue(source["prefix"]), managementAuthFileFieldLimit)
	fields.ProxyURL = boundedText(stringValue(source["proxy_url"]), managementAuthFileFieldLimit)
	fields.Expired = boundedText(stringValue(source["expired"]), managementAuthFileFieldLimit)
	fields.Note = boundedText(stringValue(source["note"]), managementAuthFileFieldLimit)
	fields.DisableCooling = firstBool(source, "disable_cooling", "disable-cooling")
	fields.Websockets = boolValue(source["websockets"])
	fields.UsingAPI = firstBool(source, "using_api", "using-api")
	fields.ExcludedModels = projectExcludedModels(source)
	fields.RequestRetry = projectCredentialRequestRetry(source)
	fields.ErrorRules = projectCredentialErrorRules(source)
	fields.ModelAliases = projectCredentialModelAliases(source)
	return fields, nil
}

func managementAuthFileFieldMismatch(requested map[string]any, file management.AuthFile, safe managementAuthFileSafeFields) string {
	for key, raw := range requested {
		switch key {
		case "prefix":
			if stringValue(raw) != safe.Prefix {
				return "prefix"
			}
		case "proxy_url":
			if stringValue(raw) != safe.ProxyURL {
				return "proxy_url"
			}
		case "expired":
			if stringValue(raw) != safe.Expired {
				return "expired"
			}
		case "disable_cooling":
			if boolValue(raw) != safe.DisableCooling {
				return "disable_cooling"
			}
		case "websockets":
			if boolValue(raw) != safe.Websockets {
				return "websockets"
			}
		case "using_api":
			if boolValue(raw) != safe.UsingAPI {
				return "using_api"
			}
		case "excluded_models":
			if !equalStringSlices(stringSliceValue(raw), safe.ExcludedModels) {
				return "excluded_models"
			}
		case "request_retry":
			if raw == nil != (safe.RequestRetry == nil) || (raw != nil && intValue(raw) != *safe.RequestRetry) {
				return "request_retry"
			}
		case "request_scoped_errors":
			if !equalErrorRules(projectErrorRuleList(raw), safe.ErrorRules) {
				return "request_scoped_errors"
			}
		case "model_aliases":
			if !equalCredentialModelAliases(projectModelAliasList(raw), safe.ModelAliases) {
				return "model_aliases"
			}
		case "priority":
			if intValue(raw) != file.Priority {
				return "priority"
			}
		case "weight":
			if int64Value(raw) != file.Weight {
				return "weight"
			}
		case "note":
			if stringValue(raw) != boundedText(file.Note, managementAuthFileFieldLimit) {
				return "note"
			}
		}
	}
	return ""
}

func projectExcludedModels(source map[string]any) []string {
	raw, ok := source["excluded_models"]
	if !ok {
		raw = source["excluded-models"]
	}
	values := stringSliceValue(raw)
	if len(values) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = boundedText(value, managementAuthFileFieldLimit)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
	}
	if len(result) == 0 {
		return nil
	}
	return result
}

func normalizeManagementAuthFileFields(raw map[string]json.RawMessage) (map[string]any, error) {
	allowed := map[string]string{
		"prefix":          "prefix",
		"proxy_url":       "proxy_url",
		"proxy-url":       "proxy_url",
		"headers":         "headers",
		"priority":        "priority",
		"weight":          "weight",
		"disable_cooling": "disable_cooling",
		"disable-cooling": "disable_cooling",
		"websockets":      "websockets",
		"using_api":       "using_api",
		"using-api":       "using_api",
		"note":            "note",
		"excluded_models": "excluded_models",
		"excluded-models": "excluded_models",
		"expired":         "expired",
		"request_retry":   "request_retry",
		"request-retry":   "request_retry",
		// The console's own name for the rules is the snake-case one; the
		// hyphenated spelling is CPA's and is accepted like the others above.
		"request_scoped_errors": "request_scoped_errors",
		"request-scoped-errors": "request_scoped_errors",
		"model_aliases":         "model_aliases",
		"model-aliases":         "model_aliases",
	}
	fields := make(map[string]any, len(raw))
	seen := make(map[string]string, len(raw))
	for key, value := range raw {
		canonical, ok := allowed[strings.TrimSpace(key)]
		if !ok {
			return nil, fmt.Errorf("field %q is not allowed", key)
		}
		if previous, exists := seen[canonical]; exists {
			return nil, fmt.Errorf("fields %q and %q refer to the same field", previous, key)
		}
		seen[canonical] = key
		decoded, err := decodeManagementValue(value)
		if err != nil {
			return nil, fmt.Errorf("invalid field %q", key)
		}
		if err := validateManagementAuthFileField(canonical, decoded); err != nil {
			return nil, err
		}
		normalized, err := normalizeManagementAuthFileField(canonical, decoded)
		if err != nil {
			return nil, err
		}
		fields[canonical] = normalized
	}
	return fields, nil
}

func normalizeManagementAuthFileField(name string, value any) (any, error) {
	if value == nil {
		return nil, nil
	}
	switch name {
	case "prefix", "proxy_url", "note":
		return strings.TrimSpace(value.(string)), nil
	case "priority":
		number, err := numberInt64(value)
		if err != nil || number < -9007199254740991 || number > 9007199254740991 {
			return nil, fmt.Errorf("field %q must be a safe integer", name)
		}
		return json.Number(strconv.FormatInt(number, 10)), nil
	case "weight":
		number, err := numberInt64(value)
		if err != nil {
			return nil, fmt.Errorf("field %q must be an integer", name)
		}
		if number <= 0 {
			number = 0
		}
		if number > 1_000_000 {
			return nil, fmt.Errorf("field %q must not exceed 1000000", name)
		}
		return json.Number(strconv.FormatInt(number, 10)), nil
	case "request_scoped_errors":
		return credentialErrorRulesWire(value)
	case "model_aliases":
		return credentialModelAliasesWire(value)
	case "excluded_models":
		raw := value.([]any)
		seen := make(map[string]struct{}, len(raw))
		models := make([]string, 0, len(raw))
		for _, item := range raw {
			model := strings.TrimSpace(item.(string))
			if model == "" {
				continue
			}
			key := strings.ToLower(model)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			models = append(models, model)
		}
		return models, nil
	default:
		return value, nil
	}
}

func validateManagementAuthFileField(name string, value any) error {
	if value == nil {
		switch name {
		case "prefix", "proxy_url", "headers", "priority", "weight", "note", "expired", "request_retry":
			return nil
		default:
			return fmt.Errorf("field %q cannot be null", name)
		}
	}
	switch name {
	case "prefix", "proxy_url", "note", "expired":
		text, ok := value.(string)
		if !ok || len([]rune(text)) > managementAuthFileFieldLimit {
			return fmt.Errorf("field %q must be a short string", name)
		}
	case "priority", "weight":
		number, ok := value.(json.Number)
		if !ok {
			return fmt.Errorf("field %q must be an integer", name)
		}
		if _, err := number.Int64(); err != nil {
			return fmt.Errorf("field %q must be an integer", name)
		}
	case "request_retry":
		// CPA reads a negative count as "remove the override", which null already
		// states, so a negative one is refused rather than silently reinterpreted.
		number, ok := value.(json.Number)
		if !ok {
			return errors.New("request_retry must be an integer or null")
		}
		if retry, err := number.Int64(); err != nil || retry < 0 || retry > maxCredentialRequestRetry {
			return fmt.Errorf("request_retry must be between 0 and %d, or null to inherit", maxCredentialRequestRetry)
		}
	case "request_scoped_errors":
		if _, err := credentialErrorRulesWire(value); err != nil {
			return err
		}
	case "model_aliases":
		if _, err := credentialModelAliasesWire(value); err != nil {
			return err
		}
	case "disable_cooling", "websockets", "using_api":
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("field %q must be boolean", name)
		}
	case "headers":
		headers, ok := value.(map[string]any)
		if !ok || len(headers) > 64 {
			return errors.New("headers must be an object with at most 64 entries")
		}
		for key, headerValue := range headers {
			text, ok := headerValue.(string)
			if !ok || len([]rune(key)) > 256 || len([]rune(text)) > managementAuthFileFieldLimit {
				return errors.New("headers must contain short string keys and values")
			}
		}
	case "excluded_models":
		models, ok := value.([]any)
		if !ok || len(models) > 256 {
			return errors.New("excluded_models must be an array of at most 256 strings")
		}
		for _, model := range models {
			text, ok := model.(string)
			if !ok || len([]rune(text)) > managementAuthFileFieldLimit {
				return errors.New("excluded_models must contain short strings")
			}
		}
	}
	return nil
}

// maxCredentialRequestRetry bounds a credential's retry override. CPA sets no
// limit; this one only keeps a mistyped number from multiplying every request.
const maxCredentialRequestRetry = 100

// credentialErrorRulesWire validates a credential's error rules and returns
// them under CPA's field names. An empty list clears the override: CPA falls
// back to the channel's rules when the credential's list is empty.
func credentialErrorRulesWire(value any) ([]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, errors.New("request_scoped_errors must be an array of rules")
	}
	var rules []ProviderErrorRuleDTO
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&rules); err != nil || rules == nil {
		return nil, errors.New("request_scoped_errors must be an array of rules")
	}
	if len(rules) > maxProviderErrorRules {
		return nil, fmt.Errorf("request_scoped_errors holds more than %d rules", maxProviderErrorRules)
	}
	wire := make([]any, 0, len(rules))
	for position, rule := range rules {
		rule.Action = strings.ToLower(strings.TrimSpace(rule.Action))
		if reason := errorRuleProblem(rule); reason != "" {
			return nil, fmt.Errorf("request_scoped_errors[%d]: %s", position, reason)
		}
		entry := map[string]any{"status": json.Number(strconv.Itoa(rule.Status)), "action": rule.Action}
		if len(rule.Match) > 0 {
			entry["match"] = rule.Match
		}
		if len(rule.MatchRegex) > 0 {
			entry["match-regexr"] = rule.MatchRegex
		}
		wire = append(wire, entry)
	}
	return wire, nil
}

// maxCredentialModelAliases bounds one credential's alias list. CPA sets no
// limit; the list is stored inside the credential file and read on every request.
const maxCredentialModelAliases = 100

// credentialModelAliasesWire validates a credential's own model aliases and
// returns them under CPA's field names. It refuses what CPA's sanitiser would
// drop without saying so - an alias equal to its model, or one alias named
// twice - because a saved list that silently loses an entry reads as a bug.
// An empty list removes the credential's aliases.
func credentialModelAliasesWire(value any) ([]any, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, errors.New("model_aliases must be an array of aliases")
	}
	var aliases []managementOAuthModelAlias
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&aliases); err != nil || aliases == nil {
		return nil, errors.New("model_aliases must be an array of aliases")
	}
	if len(aliases) > maxCredentialModelAliases {
		return nil, fmt.Errorf("model_aliases holds more than %d aliases", maxCredentialModelAliases)
	}
	wire := make([]any, 0, len(aliases))
	seenAliases := make(map[string]struct{}, len(aliases))
	for position, entry := range aliases {
		name, alias, displayName := strings.TrimSpace(entry.Name), strings.TrimSpace(entry.Alias), strings.TrimSpace(entry.DisplayName)
		switch {
		case name == "" || alias == "":
			return nil, fmt.Errorf("model_aliases[%d]: name and alias are both required", position)
		case len([]rune(name)) > managementAuthFileFieldLimit || len([]rune(alias)) > managementAuthFileFieldLimit || len([]rune(displayName)) > managementAuthFileFieldLimit:
			return nil, fmt.Errorf("model_aliases[%d]: a value is too long", position)
		case strings.EqualFold(name, alias):
			return nil, fmt.Errorf("model_aliases[%d]: the alias must differ from the model it names", position)
		}
		aliasKey := strings.ToLower(alias)
		if _, isDuplicate := seenAliases[aliasKey]; isDuplicate {
			return nil, fmt.Errorf("model_aliases[%d]: alias %q is already used", position, alias)
		}
		seenAliases[aliasKey] = struct{}{}
		item := map[string]any{"name": name, "alias": alias}
		if entry.Fork {
			item["fork"] = true
		}
		if displayName != "" {
			item["display-name"] = displayName
		}
		if entry.ForceMapping {
			item["force-mapping"] = true
		}
		wire = append(wire, item)
	}
	return wire, nil
}

func projectCredentialModelAliases(source map[string]any) []managementOAuthModelAlias {
	for _, key := range []string{"model_aliases", "model-aliases"} {
		if value, ok := source[key]; ok {
			return projectModelAliasList(value)
		}
	}
	return nil
}

// projectModelAliasList reads aliases stored under CPA's field names, skipping
// the entries CPA's own sanitiser would not apply.
func projectModelAliasList(value any) []managementOAuthModelAlias {
	raw, ok := value.([]any)
	if !ok || len(raw) == 0 {
		return nil
	}
	aliases := make([]managementOAuthModelAlias, 0, len(raw))
	for _, item := range raw {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, alias := strings.TrimSpace(stringValue(entry["name"])), strings.TrimSpace(stringValue(entry["alias"]))
		if name == "" || alias == "" || strings.EqualFold(name, alias) {
			continue
		}
		aliases = append(aliases, managementOAuthModelAlias{
			Name:         boundedText(name, managementAuthFileFieldLimit),
			Alias:        boundedText(alias, managementAuthFileFieldLimit),
			Fork:         boolValue(entry["fork"]),
			DisplayName:  boundedText(strings.TrimSpace(stringValue(entry["display-name"])), managementAuthFileFieldLimit),
			ForceMapping: boolValue(entry["force-mapping"]),
		})
		if len(aliases) == maxCredentialModelAliases {
			break
		}
	}
	if len(aliases) == 0 {
		return nil
	}
	return aliases
}

func equalCredentialModelAliases(left, right []managementOAuthModelAlias) bool {
	if len(left) != len(right) {
		return false
	}
	for position := range left {
		if left[position] != right[position] {
			return false
		}
	}
	return true
}

func projectCredentialRequestRetry(source map[string]any) *int {
	for _, key := range []string{"request_retry", "request-retry"} {
		value, ok := source[key]
		if !ok || value == nil {
			continue
		}
		if _, err := numberInt64(value); err != nil {
			return nil
		}
		// CPA treats a stored negative count as no override.
		if retry := intValue(value); retry >= 0 {
			return &retry
		}
		return nil
	}
	return nil
}

func projectCredentialErrorRules(source map[string]any) []ProviderErrorRuleDTO {
	for _, key := range []string{"request_scoped_errors", "request-scoped-errors"} {
		if value, ok := source[key]; ok {
			return projectErrorRuleList(value)
		}
	}
	return nil
}

// projectErrorRuleList reads rules stored under CPA's field names. Anything
// that is not a rule object is skipped, as CPA itself would not run it.
func projectErrorRuleList(value any) []ProviderErrorRuleDTO {
	raw, ok := value.([]any)
	if !ok || len(raw) == 0 {
		return nil
	}
	rules := make([]ProviderErrorRuleDTO, 0, len(raw))
	for _, item := range raw {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		rules = append(rules, ProviderErrorRuleDTO{
			Status:     intValue(entry["status"]),
			Match:      rawStringSlice(entry["match"]),
			MatchRegex: rawStringSlice(entry["match-regexr"]),
			Action:     stringValue(entry["action"]),
		})
	}
	if len(rules) > maxProviderErrorRules {
		rules = rules[:maxProviderErrorRules]
	}
	return rules
}

// rawStringSlice keeps each string as stored: a pattern is matched literally,
// so its surrounding whitespace is part of it.
func rawStringSlice(value any) []string {
	switch typed := value.(type) {
	case []string:
		return typed
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok {
				result = append(result, text)
			}
		}
		if len(result) == 0 {
			return nil
		}
		return result
	}
	return nil
}

func equalErrorRules(left, right []ProviderErrorRuleDTO) bool {
	if len(left) != len(right) {
		return false
	}
	for position := range left {
		a, b := left[position], right[position]
		if a.Status != b.Status || a.Action != b.Action || !equalRawStrings(a.Match, b.Match) || !equalRawStrings(a.MatchRegex, b.MatchRegex) {
			return false
		}
	}
	return true
}

func equalRawStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for position := range left {
		if left[position] != right[position] {
			return false
		}
	}
	return true
}
