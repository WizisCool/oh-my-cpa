package modelcatalog

import "testing"

func TestCatalogMatchesOnlyExactUnambiguousIdentities(t *testing.T) {
	catalog := Catalog{Models: map[string]Model{"maker/model": {ID: "maker/model"}}, Aliases: map[string]string{"model": "maker/model", "missing": "absent"}}
	for _, identity := range []string{"model", "maker/model"} {
		if model, exists := catalog.Match(identity); !exists || model.ID != "maker/model" {
			t.Fatalf("match %q = %#v %v", identity, model, exists)
		}
	}
	for _, identity := range []string{"", "missing", "model-latest", "model-2", "model-pro", "MODEL", "team/other", "model/", "/", "-high", "team/-high"} {
		if _, exists := catalog.Match(identity); exists {
			t.Errorf("guessed %q", identity)
		}
	}
}
func TestCatalogResolvesRequestVariantsToTheirBaseModel(t *testing.T) {
	catalog := Catalog{
		Models:  map[string]Model{"maker/model": {ID: "maker/model"}, "maker/model-high": {ID: "maker/model-high"}},
		Aliases: map[string]string{"model": "maker/model", "model-high": "maker/model-high", "shared": "absent"},
	}
	for identity, canonical := range map[string]string{
		"model-thinking":           "maker/model",
		"model-low":                "maker/model",
		"model:free":               "maker/model",
		"maker/model:free":         "maker/model",
		"relay/model":              "maker/model",
		"relay/team/model":         "maker/model",
		"relay/maker/model:free":   "maker/model",
		"relay/model-medium":       "maker/model",
		"model-high":               "maker/model-high",
		"relay/model-high":         "maker/model-high",
		"relay/maker/model-xhigh":  "maker/model",
		"relay/model-minimal:beta": "maker/model",
	} {
		if model, exists := catalog.Match(identity); !exists || model.ID != canonical {
			t.Errorf("match %q = %q %v, want %q", identity, model.ID, exists, canonical)
		}
	}
	// One variant suffix names a request variant; a second is part of some other identity.
	for _, identity := range []string{"model-low-high", "model-thinking-thinking", "relay/shared", "model-preview", "model:"} {
		if model, exists := catalog.Match(identity); exists {
			t.Errorf("guessed %q as %q", identity, model.ID)
		}
	}
}
func TestBundledMetadataKeepsOpenWeightsDistinctFromLicense(t *testing.T) {
	closed, exists := DEFAULT_CATALOG.Match("gpt-5")
	if !exists || closed.OpenWeights == nil || *closed.OpenWeights || closed.Limit.Context != 400000 || closed.License != "" {
		t.Fatalf("closed: %#v", closed)
	}
	open, exists := DEFAULT_CATALOG.Match("deepseek-r1")
	if !exists || open.OpenWeights == nil || !*open.OpenWeights || len(open.Weights) == 0 {
		t.Fatalf("open: %#v", open)
	}
	if DEFAULT_CATALOG.UpdatedAt == "" || DEFAULT_CATALOG.Source != "https://models.dev/models.json" {
		t.Fatal("missing provenance")
	}
}
func TestReferenceLinksRejectExecutableSchemesAndCredentials(t *testing.T) {
	links := retainSafeLinks([]Link{{URL: "https://huggingface.co/model"}, {URL: "javascript:alert(1)"}, {URL: "http://example.test"}, {URL: "https://secret@example.test"}, {URL: "/relative"}})
	if len(links) != 1 || links[0].URL != "https://huggingface.co/model" {
		t.Fatalf("links: %#v", links)
	}
}
