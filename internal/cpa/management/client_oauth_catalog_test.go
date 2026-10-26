package management

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
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
