package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

const OAUTH_CALL_MODEL = "gemini-3.8-flash"
const OAUTH_UPSTREAM_MODEL = "gemini-3.8-flash-high"

type oauthCatalogLister struct{ client *management.Client }

func (lister oauthCatalogLister) ListConfiguredModels(ctx context.Context) ([]string, error) {
	return lister.client.ListAllConfiguredModels(ctx)
}
func (lister oauthCatalogLister) ListConfiguredModelSnapshot(ctx context.Context) (pricing.ModelCatalogSnapshot, error) {
	snapshot, err := lister.client.ListConfiguredModelSnapshot(ctx)
	providers := make([]pricing.CatalogProvider, 0, len(snapshot.Providers))
	for _, provider := range snapshot.Providers {
		providers = append(providers, pricing.CatalogProvider{ID: provider.ID, Family: provider.Family, IsOAuth: provider.IsOAuth, Models: provider.ListPricingModelIDs()})
	}
	return pricing.ModelCatalogSnapshot{Models: snapshot.Models, Providers: providers}, err
}

type oauthPriceFetcher struct{}

func (oauthPriceFetcher) Fetch(context.Context) (pricing.Catalog, error) {
	return pricing.NewCatalog([]pricing.UpstreamModel{{ID: "google/gemini-3.8-flash", Author: "google", PromptPricePer1M: 0.75, CompletionPer1M: 3.75}}, time.Now()), nil
}

func TestOAuthAliasCatalogLocksUpstreamPrices(t *testing.T) {
	for _, isFork := range []bool{false, true} {
		t.Run(fmt.Sprintf("fork=%t", isFork), func(t *testing.T) {
			ctx := context.Background()
			var shouldFailAliases atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", "application/json")
				switch {
				case request.URL.Path == "/v8/management/config/config-version":
					_, _ = writer.Write([]byte(`8`))
				case request.URL.Path == "/v8/management/credentials":
					_, _ = writer.Write([]byte(`{"files":[{"name":"antigravity.json","provider":"antigravity"}]}`))
				case request.URL.Path == "/v8/management/credentials/models":
					models := []map[string]string{{"id": OAUTH_CALL_MODEL}}
					if isFork {
						models = append(models, map[string]string{"id": OAUTH_UPSTREAM_MODEL})
					}
					_ = json.NewEncoder(writer).Encode(map[string]any{"models": models})
				case request.URL.Path == "/v0/management/openai-compatibility":
					_, _ = writer.Write([]byte(`{"openai-compatibility":[]}`))
				case request.URL.Path == "/v8/management/config/oauth/model-alias":
					if shouldFailAliases.Load() {
						writer.WriteHeader(http.StatusServiceUnavailable)
						return
					}
					_ = json.NewEncoder(writer).Encode(map[string]any{"antigravity": []map[string]any{{"name": OAUTH_UPSTREAM_MODEL, "alias": OAUTH_CALL_MODEL, "fork": isFork}}})
				default:
					if strings.HasPrefix(request.URL.Path, "/v0/management/") {
						writer.WriteHeader(http.StatusNotFound)
						_, _ = writer.Write([]byte(`{"error":"not_found"}`))
						return
					}
					t.Errorf("unexpected request path: %s", request.URL.Path)
					http.NotFound(writer, request)
				}
			}))
			defer server.Close()
			client, err := management.NewClient(server.URL, "fixture-key", time.Second, false)
			if err != nil {
				t.Fatal(err)
			}
			repository := usageTestRepository(t)
			service := pricing.NewService(repository, oauthPriceFetcher{}, nil)
			service.SetModelLister(oauthCatalogLister{client: client})
			if _, err := service.SyncOnce(ctx); err != nil {
				t.Fatal(err)
			}
			catalog, err := repository.ListPricingModels(ctx)
			if err != nil {
				t.Fatal(err)
			}
			_, hasSource := catalog[OAUTH_UPSTREAM_MODEL]
			if !hasSource || catalog[OAUTH_CALL_MODEL] != OAUTH_UPSTREAM_MODEL {
				t.Fatalf("alias upstream missing: %v", catalog)
			}
			now := time.Now().UnixMilli()
			modelAlias := OAUTH_CALL_MODEL
			eventID, err := repository.InsertUsageEvents(ctx, []usage.Event{{InstanceID: "default", EventKey: "before-link", Model: OAUTH_UPSTREAM_MODEL, ModelAlias: &modelAlias, TimestampMS: now, InputTokens: 1_000_000}})
			if err != nil {
				t.Fatal(err)
			}
			event, err := repository.GetUsageEvent(ctx, eventID)
			if err != nil || event.PricingStatus != "unpriced" || event.CostUSD != nil {
				t.Fatalf("before link: %+v %v", event, err)
			}
			_, err = service.SetModelMode(ctx, pricing.ModeChange{Model: OAUTH_UPSTREAM_MODEL, Mode: pricing.ModeLinked, UpstreamID: "google/gemini-3.8-flash"})
			if err != nil {
				t.Fatal(err)
			}
			var effectiveFrom int64
			if err := repository.SQL().QueryRow(`SELECT max(effective_from_ms) FROM model_price_versions WHERE model=?`, OAUTH_UPSTREAM_MODEL).Scan(&effectiveFrom); err != nil {
				t.Fatal(err)
			}
			newID, err := repository.InsertUsageEvents(ctx, []usage.Event{{InstanceID: "default", EventKey: "after-link", Model: OAUTH_UPSTREAM_MODEL, ModelAlias: &modelAlias, TimestampMS: effectiveFrom, InputTokens: 1_000_000}})
			if err != nil {
				t.Fatal(err)
			}
			newEvent, err := repository.GetUsageEvent(ctx, newID)
			if err != nil || newEvent.CostUSD == nil || *newEvent.CostUSD != 0.75 {
				t.Fatalf("new event: %+v %v", newEvent, err)
			}
			shouldFailAliases.Store(true)
			if _, err := service.SyncOnce(ctx); err == nil {
				t.Fatal("unreadable OAuth rules published a complete catalog")
			}
			retained, err := repository.ListPricingModels(ctx)
			if err != nil || retained[OAUTH_UPSTREAM_MODEL] != OAUTH_UPSTREAM_MODEL || retained[OAUTH_CALL_MODEL] != OAUTH_UPSTREAM_MODEL {
				t.Fatalf("last complete catalog was lost: %v, %v", retained, err)
			}

			oldEvent, err := repository.GetUsageEvent(ctx, eventID)
			if err != nil || oldEvent.CostUSD != nil || oldEvent.PricingStatus != "unpriced" {
				t.Fatalf("history changed: %+v %v", oldEvent, err)
			}
		})
	}
}
