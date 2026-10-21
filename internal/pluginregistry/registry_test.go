package pluginregistry

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

// The registry is read over HTTPS by every installation's gateway, so a broken
// document is not caught by a build gate: this test is that gate. It validates the
// fields CPA itself validates, which turns a malformed catalogue entry into a test
// failure instead of a store error in every deployment.
func TestPublishedRegistryIsReadable(t *testing.T) {
	raw, err := os.ReadFile("../../plugins/registry.json")
	if err != nil {
		t.Fatalf("read the plugin registry: %v", err)
	}
	var document struct {
		SchemaVersion int `json:"schema_version"`
		Plugins       []struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Description string `json:"description"`
			Author      string `json:"author"`
			Repository  string `json:"repository"`
			Install     struct {
				Type string `json:"type"`
			} `json:"install"`
		} `json:"plugins"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("decode the plugin registry: %v", err)
	}
	if document.SchemaVersion != 1 && document.SchemaVersion != 2 {
		t.Fatalf("schema_version = %d, want 1 or 2", document.SchemaVersion)
	}
	identifier := regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	seen := map[string]bool{}
	for index, plugin := range document.Plugins {
		required := map[string]string{
			"id": plugin.ID, "name": plugin.Name, "description": plugin.Description, "author": plugin.Author,
		}
		if installType := strings.ToLower(strings.TrimSpace(plugin.Install.Type)); installType != "direct" {
			required["repository"] = plugin.Repository
		}
		for field, value := range required {
			if strings.TrimSpace(value) == "" {
				t.Errorf("plugins[%d]: missing %s", index, field)
			}
		}
		if !identifier.MatchString(strings.TrimSpace(plugin.ID)) {
			t.Errorf("plugins[%d]: invalid id %q", index, plugin.ID)
		}
		if seen[plugin.ID] {
			t.Errorf("plugins[%d]: duplicate id %q", index, plugin.ID)
		}
		seen[plugin.ID] = true
	}
}

// The source id is derived from the URL, so changing the address silently changes
// which registry CPA thinks a saved install came from. Pinning it makes that a
// deliberate edit to this value rather than an accident in a constant.
func TestSourceIDPinsThePublishedRegistry(t *testing.T) {
	if got := SourceID(OMCSourceURL); got != "source-91d6a8a15335" {
		t.Fatalf("SourceID(%q) = %q; a new registry address means a new source id, so update this value with the URL", OMCSourceURL, got)
	}
	if got := SourceID("  https://example.test/registry.json  "); got != SourceID("https://example.test/registry.json") {
		t.Fatalf("SourceID should trim the URL, got %q", got)
	}
}
