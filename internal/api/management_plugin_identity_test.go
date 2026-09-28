package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

const identityStoreBody = `{"plugins":[` +
	`{"id":"codebuddy","name":"CodeBuddy","author":"tencent","installed":true,"installed_version":"0.2.1","logo":"https://cdn.example/codebuddy.png"},` +
	`{"id":"limiter","name":"Rate Limiter","installed":false}]}`

func newIdentityStoreServer(t *testing.T, reads *atomic.Int32) *management.Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v0/management/plugin-store" {
			http.NotFound(writer, request)
			return
		}
		reads.Add(1)
		_, _ = writer.Write([]byte(identityStoreBody))
	}))
	t.Cleanup(server.Close)
	client, err := management.NewClient(server.URL, "management-key", 5*time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestPluginIdentityFillsAnUnregisteredPluginFromTheStore(t *testing.T) {
	var reads atomic.Int32
	client := newIdentityStoreServer(t, &reads)
	cache := newPluginIdentityCache()

	plugins := []management.PluginItem{
		{ID: "codebuddy", Enabled: false},
		{ID: "logger", Registered: true, Logo: "https://example.com/logger.png", Metadata: &management.PluginMetadata{Name: "Logger", Version: "1.0.0"}},
	}
	cache.fill(context.Background(), client, plugins)

	if reads.Load() != 1 {
		t.Fatalf("store reads = %d, want 1", reads.Load())
	}
	got := plugins[0]
	if got.Metadata == nil || got.Metadata.Name != "CodeBuddy" || got.Metadata.Author != "tencent" || got.Metadata.Version != "0.2.1" {
		t.Fatalf("unregistered plugin metadata = %#v, want the store's name, author and installed version", got.Metadata)
	}
	if got.Logo != "https://cdn.example/codebuddy.png" {
		t.Fatalf("unregistered plugin logo = %q, want the store's", got.Logo)
	}
	if plugins[1].Metadata.Name != "Logger" || plugins[1].Logo != "https://example.com/logger.png" {
		t.Fatalf("a registered plugin's own identity was replaced: %#v", plugins[1])
	}

	// The cache answers the next list without reading the store again.
	again := []management.PluginItem{{ID: "codebuddy"}}
	cache.fill(context.Background(), client, again)
	if reads.Load() != 1 || again[0].Metadata == nil || again[0].Metadata.Name != "CodeBuddy" {
		t.Fatalf("second fill: reads = %d, metadata = %#v", reads.Load(), again[0].Metadata)
	}
}

func TestPluginIdentityDoesNotReadTheStoreOnEveryPollForAnUnlistedPlugin(t *testing.T) {
	var reads atomic.Int32
	client := newIdentityStoreServer(t, &reads)
	cache := newPluginIdentityCache()
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	cache.now = func() time.Time { return now }

	for range 3 {
		plugins := []management.PluginItem{{ID: "homemade"}}
		cache.fill(context.Background(), client, plugins)
		if plugins[0].Metadata != nil {
			t.Fatalf("an unlisted plugin gained metadata: %#v", plugins[0].Metadata)
		}
	}
	if reads.Load() != 1 {
		t.Fatalf("store reads = %d within the retry interval, want 1", reads.Load())
	}
	now = now.Add(pluginIdentityRetryInterval)
	cache.fill(context.Background(), client, []management.PluginItem{{ID: "homemade"}})
	if reads.Load() != 2 {
		t.Fatalf("store reads = %d after the retry interval, want 2", reads.Load())
	}
}

func TestPluginIdentityRemembersTheStorePageAndSkipsCompletePlugins(t *testing.T) {
	cache := newPluginIdentityCache()
	cache.remember([]management.StorePluginItem{
		{ID: "codebuddy", Name: "CodeBuddy (mirror)", Installed: true, InstallSourceStatus: "different"},
		{ID: "codebuddy", Name: "CodeBuddy", Installed: true, InstallSourceStatus: "matched", Logo: "data:image/png;base64,AAAA"},
		{ID: "limiter", Name: "Rate Limiter", Installed: false},
	})
	if _, ok := cache.entries["limiter"]; ok {
		t.Fatal("a plugin that is not installed was remembered")
	}

	// No client: a complete list must not need one, and a cached identity must not either.
	plugins := []management.PluginItem{{ID: "codebuddy"}}
	cache.fill(context.Background(), nil, plugins)
	if plugins[0].Metadata == nil || plugins[0].Metadata.Name != "CodeBuddy" {
		t.Fatalf("metadata = %#v, want the listing CPA installed from", plugins[0].Metadata)
	}
	if plugins[0].Logo != "data:image/png;base64,AAAA" {
		t.Fatalf("logo = %q, want the matched listing's", plugins[0].Logo)
	}
}

func TestPluginIdentityRetriesWhenTheCachedEntryCannotFillTheGap(t *testing.T) {
	var reads atomic.Int32
	client := newIdentityStoreServer(t, &reads)
	cache := newPluginIdentityCache()
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	cache.now = func() time.Time { return now }
	// A listing with a name but no logo: the plugin's missing logo is still an open gap.
	cache.remember([]management.StorePluginItem{{ID: "limiter", Name: "Rate Limiter", Author: "acme", InstalledVersion: "1.0.0", Installed: true}})

	cache.fill(context.Background(), client, []management.PluginItem{{ID: "limiter"}})
	if reads.Load() != 0 {
		t.Fatalf("store reads = %d within the retry interval, want 0", reads.Load())
	}
	now = now.Add(pluginIdentityRetryInterval)
	cache.fill(context.Background(), client, []management.PluginItem{{ID: "limiter"}})
	if reads.Load() != 1 {
		t.Fatalf("store reads = %d after the retry interval, want 1: a cached entry without the logo must not end the search", reads.Load())
	}
}

func TestPluginIdentityFillsAMissingAuthorAndVersion(t *testing.T) {
	cache := newPluginIdentityCache()
	cache.remember([]management.StorePluginItem{{ID: "codebuddy", Name: "CodeBuddy", Author: "tencent", InstalledVersion: "0.2.1", Installed: true, Logo: "data:image/png;base64,AAAA"}})
	plugins := []management.PluginItem{{ID: "codebuddy", Logo: "https://example.com/own.png", Metadata: &management.PluginMetadata{Name: "CodeBuddy"}}}
	cache.fill(context.Background(), nil, plugins)
	if plugins[0].Metadata.Author != "tencent" || plugins[0].Metadata.Version != "0.2.1" {
		t.Fatalf("metadata = %#v, want the store's author and version", plugins[0].Metadata)
	}
	if plugins[0].Logo != "https://example.com/own.png" {
		t.Fatalf("logo = %q, want the plugin's own", plugins[0].Logo)
	}
}
