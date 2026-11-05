package api

import (
	"encoding/base64"
	"net/http"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// roundTripFunc lets HTTP boundary tests answer a request without external access.
type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestPluginLogoProjection(t *testing.T) {
	for _, logo := range []string{
		"https://cdn.example.test/logo.svg",
		"http://cdn.example.test/logo.png",
		"http://127.0.0.1:8317/logo.png",
		"data:image/svg+xml,%3Csvg/%3E",
		"data:image/png;base64,cG5n",
	} {
		if got := projectPluginLogo("  " + logo + "  "); got != logo {
			t.Errorf("projectPluginLogo(%q) = %q, want the declared image source", logo, got)
		}
	}
	for _, logo := range []string{
		"https://",
		"https:relative.png",
		"//cdn.example.test/logo.png",
		"/assets/logo.png",
		"icons/logo.png",
		"javascript:alert(1)",
		"data:text/html,<script/>",
		"data:image/svg+xml",
		"https://user:pass@cdn.example.test/logo.png",
		"https://cdn.example.test/" + strings.Repeat("x", pluginTextLimit),
	} {
		if got := projectPluginLogo(logo); got != "" {
			t.Errorf("projectPluginLogo(%q) = %q, want no artwork", logo, got)
		}
	}

	atCeiling := "data:image/png;base64," + base64.StdEncoding.EncodeToString(make([]byte, maxPluginLogoBytes))
	oversized := "data:image/png;base64," + base64.StdEncoding.EncodeToString(make([]byte, maxPluginLogoBytes+1))
	if got := projectPluginLogo(atCeiling); got != atCeiling {
		t.Error("inline artwork at the decoded size ceiling was dropped")
	}
	if got := projectPluginLogo(oversized); got != "" {
		t.Error("inline artwork above the decoded size ceiling was retained")
	}

	for _, source := range []struct {
		name      string
		installed bool
		status    string
		canLoad   bool
	}{
		{name: "available"},
		{name: "available-matched", status: "matched"},
		{name: "installed-unknown", installed: true},
		{name: "installed-different", installed: true, status: "different"},
		{name: "installed-matched", installed: true, status: "matched", canLoad: true},
	} {
		t.Run(source.name, func(t *testing.T) {
			for _, remote := range []string{"https://cdn.example.test/logo.png", "http://127.0.0.1:8317/logo.png"} {
				plugin := management.StorePluginItem{ID: "catalog-logo", Installed: source.installed, InstallSourceStatus: source.status, Logo: remote}
				want := ""
				if source.canLoad {
					want = remote
				}
				if got := projectStorePlugin(plugin).Logo; got != want {
					t.Errorf("store logo = %q, want %q for %s", got, want, source.name)
				}
				plugin.Logo = "data:image/svg+xml,%3Csvg/%3E"
				if got := projectStorePlugin(plugin).Logo; got != plugin.Logo {
					t.Errorf("inline store logo = %q, want %q", got, plugin.Logo)
				}
			}
		})
	}
}

func TestPluginLogosRemainInlineOnlyInDemo(t *testing.T) {
	const remote = "https://cdn.example.test/logo.png"
	const inline = "data:image/svg+xml,%3Csvg/%3E"
	plugins := []management.PluginItem{{
		ID: "multi-portal", Logo: remote,
		Metadata: &management.PluginMetadata{Logo: remote},
		OAuthProviderEntries: []management.PluginOAuthProviderEntry{
			{Identifier: "portal-one", Logo: remote},
			{Identifier: "portal-two", Logo: inline},
		},
	}}
	demo := projectPluginItems(plugins, true)[0]
	if demo.Logo != "" || demo.Metadata.Logo != "" || demo.OAuthProviderEntries[0].Logo != "" {
		t.Fatalf("demo retained external plugin artwork: %#v", demo)
	}
	if demo.OAuthProviderEntries[1].Logo != inline {
		t.Fatal("demo dropped self-contained portal artwork")
	}
	normal := projectPluginItems(plugins, false)[0]
	if normal.Logo != remote || normal.Metadata.Logo != remote || normal.OAuthProviderEntries[0].Logo != remote {
		t.Fatalf("ordinary projection lost declared logo URLs: %#v", normal)
	}
	store := []management.StorePluginItem{{ID: "remote", Installed: true, InstallSourceStatus: "matched", Logo: remote}, {ID: "inline", Logo: inline}}
	if got := projectStorePlugins(store, true); got[0].Logo != "" || got[1].Logo != inline {
		t.Fatalf("demo store artwork = %#v, want inline logos only", got)
	}
	if got := projectStorePlugins(store, false); got[0].Logo != remote || got[1].Logo != inline {
		t.Fatalf("store artwork = %#v, want declared sources", got)
	}
}
