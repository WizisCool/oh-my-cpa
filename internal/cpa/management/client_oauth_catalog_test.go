package management

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

func newOAuthCatalogClient(t *testing.T, files, aliases string, aliasStatus int) (*Client, *atomic.Int64) {
	t.Helper()
	aliasReads := &atomic.Int64{}
	server := newV8Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v8/management/credentials":
			_, _ = fmt.Fprintf(writer, `{"files":%s}`, files)
		case "/v8/management/credentials/models":
			_, _ = writer.Write([]byte(`{"models":[{"id":"gemini-3.8-flash"}]}`))
		case "/v8/management/config/oauth/model-alias":
			aliasReads.Add(1)
			writer.WriteHeader(aliasStatus)
			_, _ = writer.Write([]byte(aliases))
		default:
			_, _ = writer.Write([]byte(`{}`))
		}
	}))
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, "fixture-key", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	return client, aliasReads
}

func TestOAuthCatalogAppliesCredentialModelAliases(t *testing.T) {
	// A credential's own aliases live only in its file, which the management list
	// does not project. Without them the hidden upstream is never billable, and a
	// price for the model CPA actually reports cannot be saved.
	const defaultFiles = `[{"name":"workbuddy.json","provider":"workbuddy","models":[{"id":"deepseek-v4.1-flash"}]}]`
	const credentialFile = `{"access":"secret","model_aliases":[{"name":"deepseek-v4.1-flash-sg","alias":"deepseek-v4.1-flash","display-name":"deepseek-v4.1-flash","force-mapping":true}]}`
	for _, test := range []struct {
		name     string
		files    string
		provider string
		download string
		// downloads overrides the payload for named credentials, so a sibling can
		// state no aliases of its own.
		downloads map[string]string
		status    int
		// wantRefused asserts the snapshot is refused, so the last complete catalog
		// and its rates stay published.
		wantRefused bool
		wantModels  map[string]string
		wantRoutes  []ConfiguredModelRoute
	}{
		{
			name: "credential alias", provider: `{}`, download: credentialFile, status: http.StatusOK,
			wantModels: map[string]string{"deepseek-v4.1-flash": "deepseek-v4.1-flash-sg", "deepseek-v4.1-flash-sg": "deepseek-v4.1-flash-sg"},
			wantRoutes: []ConfiguredModelRoute{{CallPoint: "deepseek-v4.1-flash", UpstreamModel: "deepseek-v4.1-flash-sg"}},
		},
		{
			// Credential rules are resolved first, so they win a shared call point.
			name: "credential alias before provider alias", provider: `{"workbuddy":[{"name":"deepseek-v4.1-pro","alias":"deepseek-v4.1-flash"}]}`, download: credentialFile, status: http.StatusOK,
			wantModels: map[string]string{"deepseek-v4.1-flash": "deepseek-v4.1-flash-sg", "deepseek-v4.1-flash-sg": "deepseek-v4.1-flash-sg"},
			wantRoutes: []ConfiguredModelRoute{{CallPoint: "deepseek-v4.1-flash", UpstreamModel: "deepseek-v4.1-flash-sg"}},
		},
		{
			// A rule one credential stores never retargets its sibling's call point.
			name: "sibling credential keeps its own target",
			files: `[{"name":"aliased.json","provider":"workbuddy","models":[{"id":"deepseek-v4.1-flash"}]},` +
				`{"name":"plain.json","provider":"workbuddy","models":[{"id":"deepseek-v4.1-flash"}]}]`,
			provider: `{}`, download: credentialFile, status: http.StatusOK,
			downloads:  map[string]string{"plain.json": `{}`},
			wantModels: map[string]string{"deepseek-v4.1-flash": "", "deepseek-v4.1-flash-sg": "deepseek-v4.1-flash-sg"},
			wantRoutes: []ConfiguredModelRoute{{CallPoint: "deepseek-v4.1-flash", UpstreamModel: "deepseek-v4.1-flash-sg"}, {CallPoint: "deepseek-v4.1-flash", UpstreamModel: "deepseek-v4.1-flash"}},
		},
		{
			// An unreadable credential file is a failed source: publishing without it
			// would prune the hidden upstream and retire its rate.
			name: "unreadable credential file", provider: `{}`, download: `{"error":"unavailable"}`, status: http.StatusServiceUnavailable,
			wantRefused: true,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			files := test.files
			if files == "" {
				files = defaultFiles
			}
			server := newV8Server(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				switch request.URL.Path {
				case "/v8/management/credentials":
					_, _ = writer.Write([]byte(`{"files":` + files + `}`))
				case "/v8/management/credentials/download":
					name := request.URL.Query().Get("name")
					if name == "" {
						t.Error("downloaded an unnamed credential")
					}
					payload, overridden := test.downloads[name]
					if !overridden {
						payload = test.download
					}
					writer.WriteHeader(test.status)
					_, _ = writer.Write([]byte(payload))
				case "/v8/management/config/oauth/model-alias":
					_, _ = writer.Write([]byte(test.provider))
				default:
					_, _ = writer.Write([]byte(`{}`))
				}
			}))
			t.Cleanup(server.Close)
			client, err := NewClient(server.URL, "fixture-key", time.Second, false)
			if err != nil {
				t.Fatal(err)
			}
			snapshot, err := client.ListConfiguredModelSnapshot(context.Background())
			if test.wantRefused {
				if err == nil || snapshot.Models != nil {
					t.Fatalf("published a catalog without the credential's aliases: %+v, %v", snapshot, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("credential aliases failed the catalog: %v", err)
			}
			if !reflect.DeepEqual(snapshot.Models, test.wantModels) {
				t.Fatalf("catalog=%v, want=%v", snapshot.Models, test.wantModels)
			}
			if len(snapshot.Providers) != 1 {
				t.Fatalf("providers=%+v", snapshot.Providers)
			}
			provider := snapshot.Providers[0]
			if !reflect.DeepEqual(provider.Routes, test.wantRoutes) {
				t.Fatalf("routes=%+v, want=%+v", provider.Routes, test.wantRoutes)
			}
			if !reflect.DeepEqual(provider.Models, []string{"deepseek-v4.1-flash"}) {
				t.Fatalf("invented callable upstream: %+v", provider.Models)
			}
			wantPricing := []string{"deepseek-v4.1-flash"}
			for _, route := range test.wantRoutes {
				if route.UpstreamModel != route.CallPoint {
					wantPricing = append(wantPricing, route.UpstreamModel)
				}
			}
			if !reflect.DeepEqual(provider.ListPricingModelIDs(), slices.Compact(wantPricing)) {
				t.Fatalf("pricing membership=%v, want=%v", provider.ListPricingModelIDs(), wantPricing)
			}
		})
	}
}

func TestOAuthCatalogKeepsReportedModelsWhenTheReadBudgetIsSpent(t *testing.T) {
	// A reported model list is membership the gateway already answered for, so an
	// exhausted enrichment budget may drop the optional alias read but never the
	// models themselves.
	files := []AuthFile{}
	for index := range MODEL_PROVENANCE_READ_LIMIT + 1 {
		files = append(files, AuthFile{Name: fmt.Sprintf("scale-%d.json", index), Provider: "grok"})
	}
	files = append(files, AuthFile{Name: "inline.json", Provider: "grok", Models: []AuthModel{{ID: "inline-model"}}})
	encoded, err := json.Marshal(files)
	if err != nil {
		t.Fatal(err)
	}
	client, _ := newOAuthCatalogClient(t, string(encoded), `{}`, http.StatusOK)
	snapshot, err := client.ListConfiguredModelProvenance(context.Background())
	if err == nil {
		t.Fatal("an exhausted budget must stay partial")
	}
	if snapshot.Models["inline-model"] != "inline-model" {
		t.Fatalf("exhausted budget discarded reported membership: %v", snapshot.Models)
	}
}

func TestOAuthCatalogRetainsBillableUpstreamModels(t *testing.T) {
	for _, test := range []struct {
		name    string
		files   string
		aliases string
		want    map[string]string
	}{
		{"replacement alias", `[{"provider":"antigravity","models":[{"id":"gemini-3.8-flash"}]}]`, `{"antigravity":[{"name":"gemini-3.8-flash-high","alias":"gemini-3.8-flash","fork":false}]}`, map[string]string{"gemini-3.8-flash": "gemini-3.8-flash-high", "gemini-3.8-flash-high": "gemini-3.8-flash-high"}},
		{"forked alias", `[{"provider":"antigravity","models":[{"id":"gemini-3.8-flash"},{"id":"gemini-3.8-flash-high"}]}]`, `{"antigravity":[{"name":"gemini-3.8-flash-high","alias":"gemini-3.8-flash","fork":true}]}`, map[string]string{"gemini-3.8-flash": "gemini-3.8-flash-high", "gemini-3.8-flash-high": "gemini-3.8-flash-high"}},
		{"fetched credential models", `[{"name":"antigravity.json","type":" Antigravity "}]`, `{"antigravity":[{"name":"gemini-3.8-flash-high","alias":"gemini-3.8-flash"}]}`, map[string]string{"gemini-3.8-flash": "gemini-3.8-flash-high", "gemini-3.8-flash-high": "gemini-3.8-flash-high"}},
		{"inactive rules", `[{"provider":"antigravity","models":[{"id":"other"}]}]`, `{"antigravity":[{"name":"gemini-3.8-flash-high","alias":"gemini-3.8-flash"}],"codex":[{"name":"gpt-5","alias":"fast"}]}`, map[string]string{"other": "other"}},
		{"disabled credential", `[{"provider":"antigravity","disabled":true,"models":[{"id":"gemini-3.8-flash"}]}]`, `{"antigravity":[{"name":"gemini-3.8-flash-high","alias":"gemini-3.8-flash"}]}`, map[string]string{}},
		{"provider scoped conflicts", `[{"provider":"claude","models":[{"id":"fast"}]},{"provider":"codex","models":[{"id":"fast"}]}]`, `{"claude":[{"name":"claude-sonnet","alias":"fast"}],"codex":[{"name":"gpt-5","alias":"fast"}]}`, map[string]string{"fast": "", "claude-sonnet": "claude-sonnet", "gpt-5": "gpt-5"}},
		{"case insensitive alias", `[{"provider":"Antigravity","models":[{"id":"GEMINI-3.8-FLASH"}]}]`, `{"antigravity":[{"name":"gemini-3.8-flash-high","alias":"gemini-3.8-flash"}]}`, map[string]string{"GEMINI-3.8-FLASH": "gemini-3.8-flash-high", "gemini-3.8-flash-high": "gemini-3.8-flash-high"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			client, aliasReads := newOAuthCatalogClient(t, test.files, test.aliases, http.StatusOK)
			snapshot, err := client.ListConfiguredModelSnapshot(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(snapshot.Models, test.want) {
				t.Fatalf("catalog=%v, want=%v", snapshot.Models, test.want)
			}
			wantReads := int64(1)
			if test.name == "disabled credential" {
				wantReads = 0
			}
			if aliasReads.Load() != wantReads {
				t.Fatalf("alias reads=%d, want=%d", aliasReads.Load(), wantReads)
			}
			for _, provider := range snapshot.Providers {
				if test.name == "replacement alias" {
					if got := provider.ListPricingModelIDs(); !reflect.DeepEqual(got, []string{"gemini-3.8-flash", "gemini-3.8-flash-high"}) {
						t.Fatalf("missing pricing membership: %v", got)
					}
					if !reflect.DeepEqual(provider.Models, []string{"gemini-3.8-flash"}) {
						t.Fatalf("invented callable upstream: %+v", provider)
					}
					if !reflect.DeepEqual(provider.Routes, []ConfiguredModelRoute{{CallPoint: "gemini-3.8-flash", UpstreamModel: "gemini-3.8-flash-high"}}) {
						t.Fatalf("lost routing identity: %+v", provider.Routes)
					}
				}
			}
		})
	}
}

func TestOAuthCatalogRefusesUnreadableAliasRules(t *testing.T) {
	client, _ := newOAuthCatalogClient(t, `[{"provider":"antigravity","models":[{"id":"gemini-3.8-flash"}]}]`, `{"error":"fixture failure"}`, http.StatusServiceUnavailable)
	snapshot, err := client.ListConfiguredModelSnapshot(context.Background())
	if err == nil || snapshot.Models != nil {
		t.Fatalf("published partial catalog: %+v, %v", snapshot, err)
	}
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("alias read failure lost classification: %v", err)
	}
}

// catalogTransportFunc observes dispatch even when net/http would reject an
// already-cancelled request before it could reach the test server.
type catalogTransportFunc func(*http.Request) (*http.Response, error)

func (transport catalogTransportFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestOAuthCatalogCancellationStopsCredentialDiscovery(t *testing.T) {
	for _, isProvenance := range []bool{false, true} {
		t.Run(fmt.Sprintf("provenance=%t", isProvenance), func(t *testing.T) {
			files := []AuthFile{}
			for index := range 32 {
				files = append(files, AuthFile{Name: fmt.Sprintf("scale-%d.json", index), Provider: "grok"})
			}
			files = append(files, AuthFile{Provider: "codex", Models: []AuthModel{{ID: "inline-model"}}})
			encoded, err := json.Marshal(files)
			if err != nil {
				t.Fatal(err)
			}
			client, _ := newOAuthCatalogClient(t, string(encoded), `{}`, http.StatusOK)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var modelReads atomic.Int64
			transport := client.httpClient.Transport
			client.httpClient.Transport = catalogTransportFunc(func(request *http.Request) (*http.Response, error) {
				if request.URL.Path == "/v8/management/credentials/models" {
					modelReads.Add(1)
					cancel()
					return nil, ctx.Err()
				}
				return transport.RoundTrip(request)
			})
			var snapshot ConfiguredModelSnapshot
			if isProvenance {
				snapshot, err = client.ListConfiguredModelProvenance(ctx)
			} else {
				snapshot, err = client.ListConfiguredModelSnapshot(ctx)
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("lost cancellation: %v", err)
			}
			if reads := modelReads.Load(); reads == 0 || reads > 4 {
				t.Fatalf("dispatched %d credential reads after cancellation; want at most one in-flight wave", reads)
			}
			if isProvenance {
				if snapshot.Models["inline-model"] != "inline-model" {
					t.Fatal("cancellation discarded already-known inline membership")
				}
			} else if snapshot.Models != nil || snapshot.Providers != nil {
				t.Fatal("pricing must refuse the entire incomplete catalog")
			}
		})
	}
}
