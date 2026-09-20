package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
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

// The fold canonicalises the labels CPA wrote into the identities the console displays.
//
// One gateway name can arrive in several spellings across a window, and the raw label is not the
// identity: a list that treated each spelling as its own row would report one provider twice, with
// the traffic split between them and each rate computed over part of the window. Blank labels are
// the query's own "unknown" bucket, and must fold with everything else rather than becoming a row.
func TestFoldProviderTrafficCanonicalisesLabels(t *testing.T) {
	rows := []repository.UsageProviderTotalsRow{
		// Same channel, three spellings: only one row may come out.
		{Provider: "openai-compatible-cline", Requests: 10, Failures: 1},
		{Provider: "cline", Requests: 4, Failures: 0},
		// The query has already collapsed blank labels into "unknown".
		{Provider: "unknown", Requests: 2, Failures: 2},
		// A genuinely different channel, so the assertion is not just "everything folds together".
		{Provider: "antigravity", Requests: 8, Failures: 0},
	}

	traffic := foldProviderTraffic(rows)
	if len(traffic) != 3 {
		t.Fatalf("got %d providers, want 3: %#v", len(traffic), traffic)
	}

	var cline, antigravity, unknown *dashboardProviderTraffic
	for index := range traffic {
		switch traffic[index].ID {
		case "cline":
			cline = &traffic[index]
		case "antigravity":
			antigravity = &traffic[index]
		case "unknown":
			unknown = &traffic[index]
		}
	}

	if cline == nil || cline.Total != 14 || cline.Success != 13 || cline.Failure != 1 {
		t.Fatalf("the two cline spellings did not fold into one row: %#v", cline)
	}
	if cline.SuccessRate == nil || *cline.SuccessRate != float64(13)/float64(14)*100 {
		t.Fatalf("cline rate = %v, want the rate over the whole window", cline.SuccessRate)
	}
	if antigravity == nil || antigravity.Total != 8 {
		t.Fatalf("antigravity must stay its own row: %#v", antigravity)
	}
	if unknown == nil || unknown.Total != 2 || unknown.Success != 0 {
		t.Fatalf("the unknown bucket must be a row of its own: %#v", unknown)
	}
	if unknown.SuccessRate == nil || *unknown.SuccessRate != 0 {
		t.Fatalf("a fully failed window has a real rate of 0, not nil: %v", unknown.SuccessRate)
	}

	// Ranked by volume: a provider with more traffic leads, so the busiest channel is read first.
	for index := 1; index < len(traffic); index++ {
		if traffic[index-1].Total < traffic[index].Total {
			t.Fatalf("rows are not ranked by volume: %#v", traffic)
		}
	}
}

// A provider with no requests in the window has no rate, and must report null rather than zero.
//
// "0%" is a claim that traffic failed; a window with no traffic at all has no rate to report, and
// the console distinguishes the two - an absent rate reads neutral, a measured zero reads red. The
// fold is where that distinction is made, so it is asserted here rather than left to the client.
func TestFoldProviderTrafficReportsNoRateForAnEmptyRow(t *testing.T) {
	traffic := foldProviderTraffic([]repository.UsageProviderTotalsRow{
		{Provider: "silent", Requests: 0, Failures: 0},
	})
	if len(traffic) != 1 {
		t.Fatalf("got %d providers, want 1", len(traffic))
	}
	if traffic[0].SuccessRate != nil {
		t.Fatalf("a provider with no requests must report no rate, got %v", *traffic[0].SuccessRate)
	}
	if traffic[0].Total != 0 {
		t.Fatalf("empty row total = %d, want 0", traffic[0].Total)
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
		switch p.ID {
		case "codex":
			codex = p
		case "cline":
			cline = p
		case "antigravity":
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

	// The row carries no per-bucket grid. It used to, for a sparkline this list drew; asserting the
	// field is absent from the wire keeps a later change from quietly reinstating the group-by query
	// that produced it.
	if strings.Contains(string(body), `"buckets"`) {
		t.Fatalf("the provider response still carries a buckets grid: %s", string(body))
	}
}
