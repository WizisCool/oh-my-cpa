package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
	"github.com/oh-my-cpa/oh-my-cpa/internal/testkit"
)

func TestModelCatalogRefreshHTTP(t *testing.T) {
	testkit.Cases(t, "testdata/golden/model-catalog-refresh", func(t *testing.T, input testkit.Case) any {
		var scenario struct {
			Status               int             `json:"status"`
			Body                 json.RawMessage `json:"response"`
			RawResponse          string          `json:"raw_response"`
			ResponsePaddingBytes int             `json:"response_padding_bytes"`
			FailOutcomeAudit     bool            `json:"fail_outcome_audit"`
		}
		if err := json.Unmarshal(input.Body, &scenario); err != nil {
			t.Fatal(err)
		}
		fixture := newProviderTestFixture(t)
		priceSync := &fakePricing{}
		fixture.handler.SetPricing(priceSync)
		var posts atomic.Int32
		upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			// Manual refresh now rebuilds provenance before returning its catalog result.
			if request.Method == http.MethodGet {
				switch {
				case request.URL.Path == "/v8/management/credentials":
					io.WriteString(writer, `{"files":[]}`)
				case request.URL.Path == "/v8/management/config/oauth/model-alias",
					request.URL.Path == "/v0/management/openai-compatibility",
					strings.HasPrefix(request.URL.Path, "/v0/management/") && strings.HasSuffix(request.URL.Path, "-api-key"):
					io.WriteString(writer, `{}`)
				default:
					t.Errorf("unexpected provenance read: %s", request.URL.Path)
					writer.WriteHeader(http.StatusNotFound)
				}
				return
			}
			if request.Method != http.MethodPost || request.URL.Path != "/v8/management/routing/model-definitions/refresh" || request.URL.RawQuery != "" {
				t.Errorf("unexpected CPA operation: %s %s", request.Method, request.URL)
			}
			body, err := io.ReadAll(request.Body)
			if err != nil || len(body) != 0 || request.Header.Get("Authorization") != "Bearer cpa-management-key" {
				t.Error("refresh changed source policy or lost server-side authentication")
			}
			var attempts int
			if err := fixture.handler.repo.SQL().QueryRow(`SELECT COUNT(*) FROM audit_events WHERE action = 'model_catalog.refresh' AND result = 'attempt'`).Scan(&attempts); err != nil || attempts != 1 {
				t.Error("refresh reached CPA without its attempt audit")
			}
			posts.Add(1)
			if scenario.FailOutcomeAudit {
				if _, err := fixture.handler.repo.SQL().Exec(`CREATE TRIGGER deny_catalog_refresh_outcome BEFORE INSERT ON audit_events WHEN NEW.action = 'model_catalog.refresh' AND NEW.result != 'attempt' BEGIN SELECT RAISE(FAIL, 'audit fixture unavailable'); END`); err != nil {
					t.Error(err)
				}
			}
			writer.WriteHeader(scenario.Status)
			_, _ = io.WriteString(writer, strings.Repeat(" ", scenario.ResponsePaddingBytes))
			if scenario.RawResponse != "" {
				_, _ = io.WriteString(writer, scenario.RawResponse)
			} else {
				_, _ = writer.Write(scenario.Body)
			}
		}))
		defer upstream.Close()
		pointPlaygroundAt(t, fixture.handler, upstream.URL)
		response, body := postJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/model-square/refresh-catalogs")
		if priceSync.notifyCount.Load() != 0 || priceSync.started {
			t.Fatal("catalog refresh triggered pricing synchronization outside CPA")
		}
		if posts.Load() != 1 || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("refresh posts=%d cache=%q", posts.Load(), response.Header.Get("Cache-Control"))
		}
		events, err := fixture.handler.repo.ListAuditEvents(context.Background(), 100)
		if err != nil {
			t.Fatal(err)
		}
		type auditDTO struct {
			Action     string         `json:"action"`
			TargetType string         `json:"target_type"`
			TargetID   string         `json:"target_id"`
			Result     string         `json:"result"`
			Details    map[string]any `json:"details"`
		}
		audits := []auditDTO{}
		for _, event := range events {
			if event.Action == "model_catalog.refresh" {
				audits = append(audits, auditDTO{event.Action, event.TargetType, event.TargetID, event.Result, event.Details})
			}
		}
		slices.Reverse(audits)
		return struct {
			Status int             `json:"status"`
			Body   json.RawMessage `json:"body"`
			Audits []auditDTO      `json:"audits"`
		}{response.StatusCode, body, audits}
	})
}

// TestModelCatalogRefreshPublishesProvenanceBeforeResponse exercises the button's
// POST-then-GET contract and the failure response, audit flag and background retry.
func TestModelCatalogRefreshPublishesProvenanceBeforeResponse(t *testing.T) {
	for _, shouldFail := range []bool{false, true} {
		name := "cache updated"
		if shouldFail {
			name = "cache retained after failure"
		}
		t.Run(name, func(t *testing.T) {
			fixture := newProviderTestFixture(t)
			var hasRefreshedCatalog atomic.Bool
			upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				switch request.URL.Path {
				case "/v8/management/routing/model-definitions/refresh":
					if request.Method != http.MethodPost {
						t.Errorf("catalog refresh method=%s", request.Method)
					}
					hasRefreshedCatalog.Store(true)
					io.WriteString(writer, `{"ok":true,"catalogs":{"catalog":{"refreshed":true},"codex-catalog":{"refreshed":true},"devin-catalog":{"refreshed":true}}}`)
				case "/v8/management/config":
					io.WriteString(writer, `{"access":{"api-keys":["refresh-cache-fixture"]}}`)
				case "/v1/models":
					io.WriteString(writer, `{"data":[{"id":"old-model"},{"id":"new-model"}]}`)
				case "/v8/management/credentials":
					model := "old-model"
					if hasRefreshedCatalog.Load() {
						if shouldFail {
							writer.WriteHeader(http.StatusServiceUnavailable)
							io.WriteString(writer, `{"error":"private-refresh-error"}`)
							return
						}
						model = "new-model"
					}
					json.NewEncoder(writer).Encode(map[string]any{"files": []map[string]any{{"provider": "deepseek", "models": []map[string]string{{"id": model}}}}})
				default:
					io.WriteString(writer, `{}`)
				}
			}))
			defer upstream.Close()
			pointPlaygroundAt(t, fixture.handler, upstream.URL)
			if err := fixture.handler.RefreshModelSquareProvenance(context.Background()); err != nil {
				t.Fatal(err)
			}
			response, body := postJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/model-square/refresh-catalogs")
			var result modelCatalogRefreshDTO
			if err := json.Unmarshal(body, &result); err != nil {
				t.Fatal(err)
			}
			wantStatus, wantModel := http.StatusOK, "new-model"
			if shouldFail {
				wantStatus, wantModel = http.StatusBadGateway, "old-model"
				if result.Code != "catalog_refresh_failed" || result.Error != "Model provenance cache refresh failed" {
					t.Fatalf("cache failure contract: %s", body)
				}
			}
			if response.StatusCode != wantStatus || result.OK == shouldFail || len(result.Catalogs) != 3 || strings.Contains(string(body), "private-refresh-error") {
				t.Fatalf("manual refresh: %d %s", response.StatusCode, body)
			}
			hasRetry := false
			select {
			case <-fixture.handler.modelSquareRefreshSignal():
				hasRetry = true
			default:
			}
			if hasRetry != shouldFail {
				t.Fatalf("retry queued=%t, want=%t", hasRetry, shouldFail)
			}
			response, body = getJSON(t, fixture.client, fixture.baseURL+"/omc/api/v1/management/model-square")
			var directory operations.ModelSquareDirectory
			if err := json.Unmarshal(body, &directory); err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != http.StatusOK || len(directory.Models) != 2 || len(directory.Routes) != 2 || len(directory.Providers) != 1 || slices.Contains(directory.Partial, "routes") != shouldFail {
				t.Fatalf("directory after manual refresh: %d %s", response.StatusCode, body)
			}
			if !slices.ContainsFunc(directory.Routes, func(route operations.ModelSquareRoute) bool {
				return route.CallPoint == wantModel && route.ProviderID == "oauth:deepseek"
			}) {
				t.Fatalf("published cache model=%s missing: %s", wantModel, body)
			}
			events, err := fixture.handler.repo.ListAuditEvents(context.Background(), 100)
			if err != nil {
				t.Fatal(err)
			}
			wantOutcome := "success"
			if shouldFail {
				wantOutcome = "failure"
			}
			hasOutcome := false
			for _, event := range events {
				if event.Action == "model_catalog.refresh" && event.Result == wantOutcome {
					hasOutcome = true
					if event.Details["provenance_refreshed"] != !shouldFail {
						t.Fatalf("provenance refresh audit flag: %#v", event.Details)
					}
				}
			}
			if !hasOutcome {
				t.Fatalf("missing %s refresh audit", wantOutcome)
			}
		})
	}
}

func TestModelCatalogRefreshRequiresSessionOriginAndAudit(t *testing.T) {
	for _, scenario := range []struct {
		name       string
		hasCookie  bool
		origin     string
		breakAudit bool
		wantStatus int
	}{
		{name: "anonymous", origin: "same", wantStatus: http.StatusUnauthorized},
		{name: "cross origin", hasCookie: true, origin: "https://untrusted.invalid", wantStatus: http.StatusForbidden},
		{name: "audit unavailable", hasCookie: true, origin: "same", breakAudit: true, wantStatus: http.StatusInternalServerError},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newProviderTestFixture(t)
			var calls atomic.Int32
			upstream := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				calls.Add(1)
				t.Error("unauthorized or unaudited action reached CPA")
			}))
			defer upstream.Close()
			pointPlaygroundAt(t, fixture.handler, upstream.URL)
			if scenario.breakAudit {
				if _, err := fixture.handler.repo.SQL().Exec(`CREATE TRIGGER deny_catalog_refresh_attempt BEFORE INSERT ON audit_events WHEN NEW.action = 'model_catalog.refresh' BEGIN SELECT RAISE(FAIL, 'audit fixture unavailable'); END`); err != nil {
					t.Fatal(err)
				}
			}
			request, err := http.NewRequest(http.MethodPost, fixture.baseURL+"/omc/api/v1/management/model-square/refresh-catalogs", nil)
			if err != nil {
				t.Fatal(err)
			}
			origin := scenario.origin
			if origin == "same" {
				origin = fixture.baseURL
			}
			request.Header.Set("Origin", origin)
			client := fixture.client
			if !scenario.hasCookie {
				client = &http.Client{}
			}
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode != scenario.wantStatus || calls.Load() != 0 {
				t.Fatalf("status=%d calls=%d", response.StatusCode, calls.Load())
			}
		})
	}
}
