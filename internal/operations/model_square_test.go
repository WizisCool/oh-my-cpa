package operations

import (
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"testing"
)

func TestModelSquarePreservesAliasFanoutAndOAuthDirectory(t *testing.T) {
	snapshot := management.ConfiguredModelSnapshot{Models: map[string]string{"fast": ""}, Providers: []management.ConfiguredModelProvider{
		{ID: "openai-compat-0", Routes: []management.ConfiguredModelRoute{{UpstreamModel: "gpt-5", CallPoint: "team/fast"}, {UpstreamModel: "gpt-5", CallPoint: "team/fast"}}},
		{ID: "openai-compat-1", Routes: []management.ConfiguredModelRoute{{UpstreamModel: "claude-sonnet", CallPoint: "team/fast"}}},
		{ID: "oauth:claude", Family: "claude", IsOAuth: true, Models: []string{"fast", "claude-opus"}},
	}}
	aliases := map[string][]management.OAuthModelAlias{"claude": {{Name: "claude-sonnet", Alias: "fast"}}}
	directory := ProjectModelSquare(snapshot, aliases, true)
	if len(directory.Routes) != 4 {
		t.Fatalf("routes = %#v", directory.Routes)
	}
	if directory.Routes[1].CallPoint != "fast" || directory.Routes[1].UpstreamModel != "claude-sonnet" {
		t.Fatalf("OAuth alias = %#v", directory.Routes[1])
	}
	for _, route := range directory.Routes {
		if route.CallPoint == "claude-sonnet" {
			t.Fatal("invented an OAuth call point that the directory did not publish")
		}
	}
	if directory.Routes[2].CallPoint != "team/fast" || directory.Routes[3].CallPoint != "team/fast" {
		t.Fatal("lost shared call point")
	}
	if len(directory.Partial) != 0 {
		t.Fatal(directory.Partial)
	}
}

func TestModelSquareDoesNotGuessFailedOAuthMapping(t *testing.T) {
	directory := ProjectModelSquare(management.ConfiguredModelSnapshot{Providers: []management.ConfiguredModelProvider{{ID: "oauth:claude", IsOAuth: true, Models: []string{"fast"}}}}, nil, false)
	if len(directory.Partial) != 1 || len(directory.Routes) != 1 || directory.Routes[0].UpstreamModel != "" {
		t.Fatalf("unknown mapping = %#v", directory)
	}
}

func TestModelSquareUsesAdvertisedModelsAsTheAuthority(t *testing.T) {
	directory := ModelSquareDirectory{Providers: []ModelSquareProvider{{ID: "active"}, {ID: "hidden"}}, Routes: []ModelSquareRoute{
		{ProviderID: "active", UpstreamModel: "gpt-5", CallPoint: "fast"},
		{ProviderID: "active", UpstreamModel: "claude-sonnet", CallPoint: "fast"},
		{ProviderID: "hidden", UpstreamModel: "not-published", CallPoint: "not-published"},
	}}
	advertised := []gateway.Model{{ID: "fast", CallPoint: "fast"}, {ID: "runtime-only", CallPoint: "runtime-only"}}
	projected := RetainAdvertisedModels(directory, advertised)
	if len(projected.Models) != 2 || len(projected.Routes) != 3 || len(projected.Providers) != 1 {
		t.Fatalf("directory = %#v", projected)
	}
	if projected.Routes[2].CallPoint != "runtime-only" || projected.Routes[2].ProviderID != "" || projected.Routes[2].UpstreamModel != "" {
		t.Fatalf("invented runtime provenance = %#v", projected.Routes[2])
	}
	empty := RetainAdvertisedModels(directory, []gateway.Model{})
	if len(empty.Models) != 0 || len(empty.Routes) != 0 || len(empty.Providers) != 0 {
		t.Fatalf("empty live directory advertised configured models: %#v", empty)
	}
}

func TestModelSquareNativeExclusionsApplyWithoutGuessingAliases(t *testing.T) {
	for _, input := range []struct {
		model, pattern string
		isExcluded     bool
	}{
		{"GPT-5", "gpt-*", true}, {"openai/gpt-5", "*gpt*", true}, {"claude-sonnet", "gpt-*", false}, {"model[1]", "model[1]", true},
	} {
		if got := isModelExcluded(input.model, []string{input.pattern}); got != input.isExcluded {
			t.Fatalf("%q / %q = %v", input.model, input.pattern, got)
		}
	}
}
