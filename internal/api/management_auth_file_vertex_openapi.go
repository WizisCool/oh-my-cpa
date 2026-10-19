package api

import (
	"errors"
	"fmt"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// errAuthFileFieldNotApplicable refuses a field the target credential's kind does
// not read, before anything is written: CPA would store it and silently ignore it.
var errAuthFileFieldNotApplicable = errors.New("field does not apply to this credential")

// Vertex model names are path segments such as `meta/llama-3.3-70b-instruct-maas`;
// CPA keeps the registered list as one comma-joined attribute, so a comma would
// split a name in two.
const (
	maxVertexOpenAPIModels         = 256
	maxVertexOpenAPIModelLength    = 256
	maxVertexOpenAPILocationLength = 64
)

func hasVertexOpenAPIField(fields map[string]any) bool {
	for _, key := range management.VERTEX_OPENAPI_FIELDS {
		if _, ok := fields[key]; ok {
			return true
		}
	}
	return false
}

// requireVertexOpenAPITarget refuses OpenAPI overrides for any credential other
// than a Vertex service account.
func requireVertexOpenAPITarget(files []management.AuthFile, name, authIndex string, fields map[string]any) error {
	if !hasVertexOpenAPIField(fields) {
		return nil
	}
	file, ok := findManagementAuthFile(files, name, authIndex)
	if !ok {
		return errManagementAuthFileNotFound
	}
	if !file.IsVertexServiceAccount() {
		return fmt.Errorf("%w: openapi, openapi_location and openapi_models are Vertex service account settings", errAuthFileFieldNotApplicable)
	}
	return nil
}

func validateVertexOpenAPIField(name string, value any) error {
	switch name {
	case "openapi":
		if _, ok := value.(bool); !ok {
			return errors.New("openapi must be a boolean, or null to follow CPA's model detection")
		}
	case "openapi_location":
		text, ok := value.(string)
		if !ok || !isVertexLocation(strings.TrimSpace(text)) {
			return errors.New("openapi_location must be a Vertex location such as us-central1 or global, or null to use the credential's location")
		}
	case "openapi_models":
		models, ok := value.([]any)
		if !ok || len(models) > maxVertexOpenAPIModels {
			return fmt.Errorf("openapi_models must be an array of at most %d model IDs, or null", maxVertexOpenAPIModels)
		}
		for _, model := range models {
			text, ok := model.(string)
			text = strings.TrimSpace(text)
			if !ok || text == "" || len([]rune(text)) > maxVertexOpenAPIModelLength || strings.ContainsAny(text, ",\r\n") {
				return errors.New("openapi_models must contain non-empty model IDs without commas")
			}
		}
	}
	return nil
}

// isVertexLocation accepts the empty string, which clears the override.
func isVertexLocation(location string) bool {
	if len(location) > maxVertexOpenAPILocationLength {
		return false
	}
	for _, char := range location {
		if (char < 'a' || char > 'z') && (char < '0' || char > '9') && char != '-' {
			return false
		}
	}
	return true
}

// normalizeVertexOpenAPIField states "inherit" as null. CPA stores a null key
// rather than deleting it, and reads null exactly as an absent key.
func normalizeVertexOpenAPIField(name string, value any) any {
	switch name {
	case "openapi_location":
		if location := strings.TrimSpace(value.(string)); location != "" {
			return location
		}
		return nil
	case "openapi_models":
		if models := dedupeVertexOpenAPIModels(stringSliceValue(value)); len(models) > 0 {
			return models
		}
		return nil
	}
	return value
}

func dedupeVertexOpenAPIModels(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		key := strings.ToLower(value)
		if _, exists := seen[key]; value == "" || exists {
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

// projectVertexOpenAPIFields reads the overrides the way CPA does: an explicit
// boolean (or its "true"/"1"/"false"/"0" spelling) for `openapi`, the first
// non-empty location spelling, and model names from a list, a comma-joined
// string or `{name}` objects.
func projectVertexOpenAPIFields(source map[string]any, fields *managementAuthFileSafeFields) {
	if !strings.EqualFold(stringValue(source["type"]), "vertex") {
		return
	}
	fields.OpenAPI = vertexOpenAPIBool(source["openapi"])
	for _, key := range []string{"openapi_location", "openapi-location"} {
		if location := boundedText(stringValue(source[key]), maxVertexOpenAPILocationLength); location != "" {
			fields.OpenAPILocation = location
			break
		}
	}
	fields.OpenAPIModels = dedupeVertexOpenAPIModels(append(vertexOpenAPIModelNames(source["openapi_models"]), vertexOpenAPIModelNames(source["openapi-models"])...))
	fields.OpenAPILegacyModels = dedupeVertexOpenAPIModels(vertexOpenAPIModelNames(source["models"]))
}

func vertexOpenAPIBool(value any) *bool {
	var parsed bool
	switch typed := value.(type) {
	case bool:
		parsed = typed
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "true", "1":
			parsed = true
		case "false", "0":
			parsed = false
		default:
			return nil
		}
	default:
		return nil
	}
	return &parsed
}

func vertexOpenAPIModelNames(value any) []string {
	var names []string
	add := func(name string) {
		if name = boundedText(strings.TrimSpace(name), maxVertexOpenAPIModelLength); name != "" && len(names) < maxVertexOpenAPIModels {
			names = append(names, name)
		}
	}
	switch typed := value.(type) {
	case string:
		for _, part := range strings.Split(typed, ",") {
			add(part)
		}
	case []any:
		for _, item := range typed {
			switch entry := item.(type) {
			case string:
				add(entry)
			case map[string]any:
				name, _ := entry["name"].(string)
				add(name)
			}
		}
	}
	return names
}

func vertexOpenAPIFieldMismatch(key string, raw any, safe managementAuthFileSafeFields) bool {
	switch key {
	case "openapi":
		requested, isSet := raw.(bool)
		return isSet != (safe.OpenAPI != nil) || (isSet && requested != *safe.OpenAPI)
	case "openapi_location":
		return stringValue(raw) != safe.OpenAPILocation
	case "openapi_models":
		return !equalStringSlices(stringSliceValue(raw), safe.OpenAPIModels)
	}
	return false
}
