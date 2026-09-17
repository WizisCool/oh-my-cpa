package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/usage"
)

const providersDashboardPath = "/omc/api/v1/management/dashboard/providers"

func TestDashboardProvidersRequiresAuthentication(t *testing.T) {
	_, baseURL, _ := startDashboardTestServer(t, nil)
	response, err := http.Get(baseURL + providersDashboardPath)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want 401", response.StatusCode)
	}
}

func TestDashboardProvidersWindowAggregation(t *testing.T) {
	client, baseURL, repo := startDashboardTestServer(t, nil)

	baseTime := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	events := []usage.Event{
		{
			InstanceID:  "default",
			EventKey:    "evt-1",
			Provider:    "codex",
			Model:       "gpt-4o",
			TimestampMS: baseTime.UnixMilli(),
			Failed:      false,
			TotalTokens: 100,
		},
		{
			InstanceID:  "default",
			EventKey:    "evt-2",
			Provider:    "codex",
			Model:       "gpt-4o",
			TimestampMS: baseTime.Add(time.Minute).UnixMilli(),
			Failed:      true,
			TotalTokens: 50,
		},
		{
			InstanceID:  "default",
			EventKey:    "evt-3",
			Provider:    "openai-compatible-cline",
			Model:       "claude-3-5-sonnet",
			TimestampMS: baseTime.Add(2 * time.Minute).UnixMilli(),
			Failed:      false,
			TotalTokens: 200,
		},
		{
			InstanceID:  "default",
			EventKey:    "evt-4",
			Provider:    "antigravity",
			Model:       "claude-3-5-sonnet",
			TimestampMS: baseTime.Add(3 * time.Minute).UnixMilli(),
			Failed:      false,
			TotalTokens: 150,
		},
		// Outside window
		{
			InstanceID:  "default",
			EventKey:    "evt-old",
			Provider:    "codex",
			Model:       "gpt-4o",
			TimestampMS: baseTime.Add(-2 * time.Hour).UnixMilli(),
			Failed:      false,
			TotalTokens: 500,
		},
	}

	if _, err := repo.InsertUsageEvents(context.Background(), events); err != nil {
		t.Fatal(err)
	}

	fromMS := baseTime.Add(-10 * time.Minute).UnixMilli()
	toMS := baseTime.Add(10 * time.Minute).UnixMilli()
	query := fmt.Sprintf("?from=%d&to=%d", fromMS, toMS)

	resp, body := getJSON(t, client, baseURL+providersDashboardPath+query)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %s", resp.StatusCode, body)
	}

	var parsed dashboardProvidersResponse
	if err := json.Unmarshal([]byte(body), &parsed); err != nil {
		t.Fatal(err)
	}

	if len(parsed.Providers) != 3 {
		t.Fatalf("expected 3 providers in window, got %d: %#v", len(parsed.Providers), parsed.Providers)
	}

	var codex *dashboardProviderTraffic
	var cline *dashboardProviderTraffic
	var antigravity *dashboardProviderTraffic

	for i := range parsed.Providers {
		p := &parsed.Providers[i]
		if p.ID == "codex" {
			codex = p
		} else if p.ID == "cline" {
			cline = p
		} else if p.ID == "antigravity" {
			antigravity = p
		}
	}

	if codex == nil || codex.Total != 2 || codex.Success != 1 || codex.Failure != 1 {
		t.Fatalf("unexpected codex traffic: %#v", codex)
	}
	if codex.SuccessRate == nil || *codex.SuccessRate != 50.0 {
		t.Fatalf("expected codex success rate 50%%, got %#v", codex.SuccessRate)
	}

	if cline == nil || cline.Total != 1 || cline.Success != 1 || cline.Failure != 0 {
		t.Fatalf("unexpected cline traffic: %#v", cline)
	}
	if cline.SuccessRate == nil || *cline.SuccessRate != 100.0 {
		t.Fatalf("expected cline success rate 100%%, got %#v", cline.SuccessRate)
	}

	if antigravity == nil || antigravity.Total != 1 || antigravity.Success != 1 {
		t.Fatalf("unexpected antigravity traffic: %#v", antigravity)
	}
}
