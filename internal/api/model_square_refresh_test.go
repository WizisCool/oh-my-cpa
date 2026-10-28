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
