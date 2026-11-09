package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/modelcatalog"
	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
)

func TestModelSquareHTTPUsesDefaultKeyAndSafeProvenance(t *testing.T) {
	fixture := newProviderTestFixture(t)
	var mutex sync.Mutex
	keys := []string{"directory-fixture-first", "directory-fixture-second"}
	var authorization string
	var hasCachedProvenance atomic.Bool
	upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()
		if request.Method != http.MethodGet {
			t.Errorf("directory triggered mutation: %s %s", request.Method, request.URL.Path)
		}
		if hasCachedProvenance.Load() && request.URL.Path != "/v8/management/config" && request.URL.Path != "/v1/models" {
			t.Errorf("page request bypassed provenance cache: %s", request.URL.Path)
			writer.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		switch request.URL.Path {
		case "/v8/management/config":
			json.NewEncoder(writer).Encode(map[string]any{"access": map[string]any{"api-keys": keys}})
		case "/v1/models":
			authorization = request.Header.Get("Authorization")
			if authorization == "Bearer directory-fixture-second" {
				io.WriteString(writer, `{"data":[{"id":"second-only"}]}`)
			} else {
				io.WriteString(writer, `{"data":[{"id":"team/fast","account":"private-account","secret":"private-secret"},{"id":"runtime-only"}]}`)
			}
		case "/v8/management/config/oauth/model-alias":
			io.WriteString(writer, `{}`)
		case "/v8/management/credentials":
			io.WriteString(writer, `{"files":[]}`)
		case "/v0/management/openai-compatibility":
			io.WriteString(writer, `{"openai-compatibility":[{"name":"relay","base-url":"https://user:password@relay.example.test/v1?token=private-token","api-keys":["upstream-secret"],"prefix":"team","models":[{"name":"gpt-5","alias":"fast"},{"name":"claude-sonnet","alias":"fast"},{"name":"not-advertised"}]}]}`)
		default:
			if strings.HasPrefix(request.URL.Path, "/v0/management/") && strings.HasSuffix(request.URL.Path, "-api-key") {
				io.WriteString(writer, `{}`)
			} else {
				t.Errorf("unexpected read: %s", request.URL.Path)
				writer.WriteHeader(404)
			}
		}
	}))
	defer upstream.Close()
	pointPlaygroundAt(t, fixture.handler, upstream.URL)
	if err := fixture.handler.RefreshModelSquareProvenance(context.Background()); err != nil {
		t.Fatal(err)
	}
	hasCachedProvenance.Store(true)
	path := fixture.baseURL + "/omc/api/v1/management/model-square"
	response, body := getJSON(t, fixture.client, path)
	if response.StatusCode != 200 {
		t.Fatalf("directory: %d %s", response.StatusCode, body)
	}
	if response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("directory may cache key scopes")
	}
	var directory operations.ModelSquareDirectory
	if err := json.Unmarshal(body, &directory); err != nil {
		t.Fatal(err)
	}
	if len(directory.Models) != 2 || len(directory.Routes) != 3 || len(directory.Providers) != 1 || len(directory.Partial) != 0 {
		t.Fatalf("directory = %#v", directory)
	}
	if directory.Providers[0].EndpointHost != "relay.example.test" {
		t.Fatal(directory.Providers)
	}
	for _, forbidden := range []string{"directory-fixture-first", "directory-fixture-second", "private-account", "private-secret", "upstream-secret", "password", "private-token", "relay.example.test/v1", "not-advertised"} {
		if strings.Contains(string(body), forbidden) {
			t.Errorf("unsafe or unadvertised field %q: %s", forbidden, body)
		}
	}
	for _, route := range directory.Routes {
		if route.CallPoint == "runtime-only" && (route.ProviderID != "" || route.UpstreamModel != "") {
			t.Fatal("invented runtime provenance")
		}
	}
	mutex.Lock()
	selectedAuth := authorization
	mutex.Unlock()
	if selectedAuth != "Bearer directory-fixture-first" {
		t.Fatal("directory did not use the first configured key")
	}
	if directory.ModelInfo["gpt-5"].Limit.Context != 400000 {
		t.Fatal("missing models.dev information")
	}
	mutex.Lock()
	keys = nil
	mutex.Unlock()
	response, body = getJSON(t, fixture.client, path)
	if response.StatusCode != 409 || !strings.Contains(string(body), "client_key_required") {
		t.Fatalf("no key: %d %s", response.StatusCode, body)
	}
}

func TestModelSquareLiveDirectorySurvivesEnrichmentFailure(t *testing.T) {
	fixture := newProviderTestFixture(t)
	upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v8/management/config":
			io.WriteString(writer, `{"access":{"api-keys":["directory-enrichment-fixture"]}}`)
		case "/v1/models":
			io.WriteString(writer, `{"data":[{"id":"runtime-only"}]}`)
		default:
			writer.WriteHeader(503)
			io.WriteString(writer, `{"error":"private-upstream-failure"}`)
		}
	}))
	defer upstream.Close()
	pointPlaygroundAt(t, fixture.handler, upstream.URL)
	if err := fixture.handler.RefreshModelSquareProvenance(context.Background()); err == nil {
		t.Fatal("unavailable provenance unexpectedly refreshed")
	}
	response, body := getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/model-square")
	var directory operations.ModelSquareDirectory
	if err := json.Unmarshal(body, &directory); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || len(directory.Models) != 1 || len(directory.Routes) != 1 || directory.Routes[0].UpstreamModel != "" || len(directory.Partial) == 0 || strings.Contains(string(body), "private-upstream-failure") {
		t.Fatalf("partial live directory: %d %s", response.StatusCode, body)
	}

	for _, hasAliases := range []bool{true, false} {
		t.Run(fmt.Sprintf("cancelled-with-known-aliases=%t", hasAliases), func(t *testing.T) {
			fixture := newProviderTestFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var shouldCancel atomic.Bool
			upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				switch request.URL.Path {
				case "/v8/management/config":
					io.WriteString(writer, `{"access":{"api-keys":["directory-cancel-fixture"]}}`)
				case "/v1/models":
					io.WriteString(writer, `{"data":[{"id":"scale-alias"},{"id":"scale-unresolved"}]}`)
				case "/v8/management/credentials":
					io.WriteString(writer, `{"files":[{"provider":"claude","models":[{"id":"scale-alias"}]},{"provider":"grok","models":[{"id":"scale-alias"}]},{"provider":"codex","name":"slow.json"}]}`)
				case "/v8/management/config/oauth/model-alias":
					if shouldCancel.Load() && !hasAliases {
						writer.WriteHeader(http.StatusServiceUnavailable)
					}
					io.WriteString(writer, `{"claude":[{"name":"scale-first","alias":"scale-alias"}],"grok":[{"name":"scale-second","alias":"scale-alias"}]}`)
				case "/v8/management/credentials/models":
					// Cancel a later sweep after it has observed different membership.
					if shouldCancel.Load() {
						cancel()
					}
					io.WriteString(writer, `{"models":[{"id":"scale-unresolved"}]}`)
				default:
					io.WriteString(writer, `{}`)
				}
			}))
			defer upstream.Close()
			pointPlaygroundAt(t, fixture.handler, upstream.URL)
			if err := fixture.handler.RefreshModelSquareProvenance(context.Background()); err != nil {
				t.Fatal(err)
			}
			path := fixture.baseURL + "/omc/api/v1/management/model-square"
			beforeResponse, before := getJSON(t, fixture.client, path)
			if beforeResponse.StatusCode != http.StatusOK {
				t.Fatalf("primed directory: %d %s", beforeResponse.StatusCode, before)
			}
			shouldCancel.Store(true)
			if err := fixture.handler.RefreshModelSquareProvenance(ctx); !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelled refresh error = %v", err)
			}
			recorder := httptest.NewRecorder()
			fixture.handler.listModelSquare(recorder, httptest.NewRequest(http.MethodGet, "/", nil))
			if recorder.Code != http.StatusOK {
				t.Fatalf("cancelled enrichment: %d %s", recorder.Code, recorder.Body)
			}
			if recorder.Body.String() != string(before) {
				t.Fatalf("cancelled sweep changed published directory: before=%s after=%s", before, recorder.Body.String())
			}
		})
	}
}

// TestModelSquareCachesEveryCredentialWithoutPageEnrichment proves late credentials
// are resolved by the background sweep and subsequent page reads do no model discovery.
func TestModelSquareCachesEveryCredentialWithoutPageEnrichment(t *testing.T) {
	fixture := newProviderTestFixture(t)
	var modelReads atomic.Int64
	upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v8/management/config":
			io.WriteString(writer, `{"access":{"api-keys":["directory-scale-fixture"]}}`)
		case "/v1/models":
			io.WriteString(writer, `{"data":[{"id":"scale-free"},{"id":"scale-paid"},{"id":"team/scale-native"},{"id":"scale-inline"}]}`)
		case "/v8/management/credentials":
			files := []map[string]any{}
			for index := range 32 {
				files = append(files, map[string]any{"name": fmt.Sprintf("scale-%d.json", index), "provider": "grok"})
			}
			// Both the last queried credential and inline membership must survive the sweep.
			files = append(files, map[string]any{"provider": "codex", "models": []map[string]string{{"id": "scale-inline"}}})
			json.NewEncoder(writer).Encode(map[string]any{"files": files})
		case "/v8/management/credentials/models":
			modelReads.Add(1)
			if request.URL.Query().Get("name") == "scale-31.json" {
				io.WriteString(writer, `{"models":[{"id":"scale-paid"}]}`)
			} else {
				io.WriteString(writer, `{"models":[{"id":"scale-free"}]}`)
			}
		case "/v8/management/config/oauth/model-alias":
			io.WriteString(writer, `{}`)
		case "/v0/management/openai-compatibility":
			io.WriteString(writer, `{"openai-compatibility":[{"name":"relay","prefix":"team","models":[{"name":"scale-upstream","alias":"scale-native"}]}]}`)
		default:
			io.WriteString(writer, `{}`)
		}
	}))
	defer upstream.Close()
	pointPlaygroundAt(t, fixture.handler, upstream.URL)
	if err := fixture.handler.RefreshModelSquareProvenance(context.Background()); err != nil {
		t.Fatal(err)
	}
	response, body := getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/model-square")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("directory: %d %s", response.StatusCode, body)
	}
	if reads := modelReads.Load(); reads != 32 {
		t.Fatalf("credential-model reads = %d, want one background read for each of 32 credentials", reads)
	}
	var directory operations.ModelSquareDirectory
	if err := json.Unmarshal(body, &directory); err != nil {
		t.Fatal(err)
	}
	if len(directory.Models) != 4 || len(directory.Routes) != 4 || len(directory.Providers) != 3 || len(directory.Partial) != 0 {
		t.Fatalf("full provenance: %s", body)
	}
	for _, route := range directory.Routes {
		if route.ProviderID == "" || route.UpstreamModel == "" {
			t.Fatalf("unresolved credential route: %#v", route)
		}
	}
	response, body = getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/model-square")
	if response.StatusCode != http.StatusOK || modelReads.Load() != 32 {
		t.Fatalf("cached re-read: status=%d model reads=%d body=%s", response.StatusCode, modelReads.Load(), body)
	}

	// Pricing must still visit the late credential with a different account tier.
	client, err := management.NewClient(upstream.URL, "catalog-scale-fixture", time.Second, false)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := client.ListConfiguredModelSnapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Models["scale-paid"] != "scale-paid" || modelReads.Load() != 64 {
		t.Fatalf("pricing discovery was bounded: paid=%q, total model reads=%d", snapshot.Models["scale-paid"], modelReads.Load())
	}
}

func TestModelSquareNativeDefaultsRespectPrefixAndExclusions(t *testing.T) {
	fixture := newProviderTestFixture(t)
	upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v8/management/config":
			io.WriteString(writer, `{"access":{"api-keys":["directory-defaults-fixture"]}}`)
		case "/v1/models":
			io.WriteString(writer, `{"data":[{"id":"team/gpt-5"},{"id":"team/gpt-5-mini"}]}`)
		case "/v8/management/config/oauth/model-alias":
			io.WriteString(writer, `{}`)
		case "/v8/management/credentials":
			io.WriteString(writer, `{"files":[]}`)
		case "/v0/management/codex-api-key":
			io.WriteString(writer, `{"codex-api-key":[{"api-key":"private-native-key","prefix":"team","excluded-models":["*-mini"]}]}`)
		case "/v0/management/openai-compatibility":
			io.WriteString(writer, `{"openai-compatibility":[]}`)
		case "/v8/management/routing/model-definitions/codex":
			io.WriteString(writer, `{"models":[{"id":"gpt-5"},{"id":"gpt-5-mini"},{"id":"gpt-5-pro"}]}`)
		default:
			if strings.HasPrefix(request.URL.Path, "/v0/management/") && strings.HasSuffix(request.URL.Path, "-api-key") {
				io.WriteString(writer, `{}`)
			} else {
				t.Errorf("unexpected read: %s", request.URL.Path)
				writer.WriteHeader(404)
			}
		}
	}))
	defer upstream.Close()
	pointPlaygroundAt(t, fixture.handler, upstream.URL)
	if err := fixture.handler.RefreshModelSquareProvenance(context.Background()); err != nil {
		t.Fatal(err)
	}
	response, body := getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/model-square")
	var directory operations.ModelSquareDirectory
	if err := json.Unmarshal(body, &directory); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || len(directory.Routes) != 2 || directory.Routes[0].UpstreamModel != "gpt-5" || directory.Routes[1].UpstreamModel != "" || len(directory.Partial) != 0 {
		t.Fatalf("native defaults: %d %s", response.StatusCode, body)
	}
}

// TestModelSquareRefreshDistinguishesMissingDefinitionsFromFailedReads keeps optional
// capability gaps from hiding other providers while preserving last-good data on outages.
func TestModelSquareRefreshDistinguishesMissingDefinitionsFromFailedReads(t *testing.T) {
	for _, status := range []int{http.StatusNotFound, http.StatusMethodNotAllowed, http.StatusNotImplemented, http.StatusServiceUnavailable, http.StatusUnauthorized} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			fixture := newProviderTestFixture(t)
			var definitionStatus atomic.Int32
			definitionStatus.Store(http.StatusOK)
			var definitionReads atomic.Int32
			upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				switch request.URL.Path {
				case "/v8/management/config":
					io.WriteString(writer, `{"access":{"api-keys":["directory-capability-fixture"]}}`)
				case "/v1/models":
					io.WriteString(writer, `{"data":[{"id":"plugin-model"},{"id":"gpt-5"}]}`)
				case "/v8/management/credentials":
					io.WriteString(writer, `{"files":[{"provider":"deepseek","models":[{"id":"plugin-model"}]}]}`)
				case "/v0/management/codex-api-key":
					io.WriteString(writer, `{"codex-api-key":[{"api-key":"first-fixture"},{"api-key":"second-fixture"}]}`)
				case "/v8/management/routing/model-definitions/codex":
					definitionReads.Add(1)
					writer.WriteHeader(int(definitionStatus.Load()))
					io.WriteString(writer, `{"models":[{"id":"gpt-5"}]}`)
				default:
					io.WriteString(writer, `{}`)
				}
			}))
			defer upstream.Close()
			pointPlaygroundAt(t, fixture.handler, upstream.URL)
			if err := fixture.handler.RefreshModelSquareProvenance(context.Background()); err != nil {
				t.Fatal(err)
			}
			definitionStatus.Store(int32(status))
			err := fixture.handler.RefreshModelSquareProvenance(context.Background())
			isMissing := status == http.StatusNotFound || status == http.StatusMethodNotAllowed || status == http.StatusNotImplemented
			if (err == nil) != isMissing {
				t.Fatalf("refresh status=%d err=%v", status, err)
			}
			response, body := getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/model-square")
			var directory operations.ModelSquareDirectory
			if err := json.Unmarshal(body, &directory); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusOK || len(directory.Models) != 2 || definitionReads.Load() != 2 {
				t.Fatalf("partial directory: status=%d reads=%d body=%s", response.StatusCode, definitionReads.Load(), body)
			}
			if isMissing {
				if len(directory.Providers) != 1 || len(directory.Routes) != 2 || !slices.Equal(directory.Partial, []string{"provider_models"}) {
					t.Fatalf("missing definitions hid plugin provenance: %s", body)
				}
			} else if len(directory.Providers) != 3 || len(directory.Routes) != 3 || !slices.Equal(directory.Partial, []string{"routes"}) {
				t.Fatalf("failed refresh discarded cached provenance: %s", body)
			}
			if !slices.ContainsFunc(directory.Routes, func(route operations.ModelSquareRoute) bool {
				return route.CallPoint == "plugin-model" && route.ProviderID == "oauth:deepseek"
			}) {
				t.Fatalf("plugin source missing: %s", body)
			}
		})
	}
}

// TestModelSquareDoesNotReuseAnotherGatewayCache checks the HTTP projection after a gateway switch.
func TestModelSquareDoesNotReuseAnotherGatewayCache(t *testing.T) {
	fixture := newProviderTestFixture(t)
	serve := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v8/management/config":
			io.WriteString(writer, `{"access":{"api-keys":["directory-switch-fixture"]}}`)
		case "/v1/models":
			io.WriteString(writer, `{"data":[{"id":"shared-model"}]}`)
		case "/v8/management/credentials":
			io.WriteString(writer, `{"files":[{"provider":"deepseek","models":[{"id":"shared-model"}]}]}`)
		default:
			io.WriteString(writer, `{}`)
		}
	})
	first := newFakeCPA(serve)
	defer first.Close()
	second := newFakeCPA(serve)
	defer second.Close()
	pointPlaygroundAt(t, fixture.handler, first.URL)
	if err := fixture.handler.RefreshModelSquareProvenance(context.Background()); err != nil {
		t.Fatal(err)
	}
	pointPlaygroundAt(t, fixture.handler, second.URL)
	response, body := getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/model-square")
	var directory operations.ModelSquareDirectory
	if err := json.Unmarshal(body, &directory); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || len(directory.Providers) != 0 || len(directory.Models) != 1 || len(directory.Routes) != 1 || directory.Routes[0].ProviderID != "" || directory.Routes[0].UpstreamModel != "" || !slices.Equal(directory.Partial, []string{"routes"}) {
		t.Fatalf("previous gateway leaked into new directory: %d %s", response.StatusCode, body)
	}
}

func TestModelSquareDTOFieldAllowlists(t *testing.T) {
	isSupported := true
	reference := modelcatalog.Model{
		ID: "research/example", Name: "Example", Description: "Reference description", Family: "example",
		OpenWeights: &isSupported, Reasoning: &isSupported, ToolCall: &isSupported, StructuredOutput: &isSupported,
		Attachment: &isSupported, Temperature: &isSupported, Knowledge: "2026-01", ReleaseDate: "2026-02-01",
		LastUpdated: "2026-03-01", License: "MIT", Limit: modelcatalog.Limits{Context: 1000, Input: 900, Output: 100},
		Modalities: modelcatalog.Modalities{Input: []string{"text"}, Output: []string{"text"}},
		Weights:    []modelcatalog.Link{{Label: "Weights", URL: "https://example.test/weights", Type: "weights"}},
		Links:      []modelcatalog.Link{{Label: "Paper", URL: "https://example.test/paper", Type: "paper"}},
	}
	directory := operations.ModelSquareDirectory{
		Models:    []gateway.Model{{ID: "client-name", CallPoint: "client-name", Vision: "unknown"}},
		Providers: []operations.ModelSquareProvider{{ID: "relay", Family: "openai-compatibility", Name: "Relay", EndpointHost: "relay.example.test", IconID: "OpenAI"}},
		Routes:    []operations.ModelSquareRoute{{ProviderID: "relay", UpstreamModel: reference.ID, CallPoint: "client-name"}},
		Partial:   []string{}, ModelInfo: map[string]modelcatalog.Model{reference.ID: reference}, MetadataUpdatedAt: "2026-03-01",
	}
	data, err := json.Marshal(projectModelSquareDTO(directory))
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(data, &body); err != nil {
		t.Fatal(err)
	}
	assertModelSquareFields(t, data, "models", "providers", "routes", "partial", "model_info", "metadata_updated_at")
	for field, allowed := range map[string][]string{
		"models":    {"id", "call_point", "vision"},
		"providers": {"id", "family", "name", "endpoint_host", "is_oauth", "icon_id"},
		"routes":    {"provider_id", "upstream_model", "call_point"},
	} {
		var items []json.RawMessage
		if err := json.Unmarshal(body[field], &items); err != nil {
			t.Fatal(err)
		}
		if len(items) != 1 {
			t.Fatalf("%s: %s", field, body[field])
		}
		assertModelSquareFields(t, items[0], allowed...)
	}
	var references map[string]json.RawMessage
	if err := json.Unmarshal(body["model_info"], &references); err != nil {
		t.Fatal(err)
	}
	projected := references[reference.ID]
	assertModelSquareFields(t, projected, "id", "name", "description", "family", "open_weights", "reasoning", "tool_call", "structured_output", "attachment", "temperature", "knowledge", "release_date", "last_updated", "license", "limit", "modalities", "weights", "links")
	var metadata map[string]json.RawMessage
	if err := json.Unmarshal(projected, &metadata); err != nil {
		t.Fatal(err)
	}
	assertModelSquareFields(t, metadata["limit"], "context", "input", "output")
	assertModelSquareFields(t, metadata["modalities"], "input", "output")
	for _, field := range []string{"weights", "links"} {
		var links []json.RawMessage
		if err := json.Unmarshal(metadata[field], &links); err != nil {
			t.Fatal(err)
		}
		if len(links) != 1 {
			t.Fatal("missing reference links")
		}
		assertModelSquareFields(t, links[0], "label", "url", "type")
	}
	var roundTrip modelcatalog.Model
	if err := json.Unmarshal(projected, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(roundTrip, reference) {
		t.Fatalf("reference fields were lost: %#v", roundTrip)
	}
}

func assertModelSquareFields(t *testing.T, data []byte, allowed ...string) {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	sort.Strings(allowed)
	if !reflect.DeepEqual(names, allowed) {
		t.Fatalf("JSON fields %v, want %v", names, allowed)
	}
}

func TestModelSquareMissingKeyErrorSurvivesWrapping(t *testing.T) {
	writer := httptest.NewRecorder()
	writeModelSquareError(writer, fmt.Errorf("private operation context: %w", operations.ErrClientKeyRequired))
	if writer.Code != http.StatusConflict || !strings.Contains(writer.Body.String(), "client_key_required") || strings.Contains(writer.Body.String(), "private operation context") {
		t.Fatalf("wrapped key error: %d %s", writer.Code, writer.Body.String())
	}
}
