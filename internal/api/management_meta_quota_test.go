package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestMetaQuotaFacadeAuditsBeforeDownloadAndProjectsSnapshots(t *testing.T) {
	var downloads, observations atomic.Int32
	var repo *repository.Repository
	client, baseURL, testRepo := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v8/management/credentials":
			io.WriteString(writer, `{"files":[{"name":"meta-fixture.json","auth_index":"meta-fixture","type":"meta","provider":"meta"}]}`)
		case "/v8/management/credentials/download":
			downloads.Add(1)
			events, err := repo.ListAuditEvents(context.Background(), 100)
			hasAttempt := false
			for _, event := range events {
				if event.Action == "quota.refresh" && event.Result == "attempt" {
					hasAttempt = true
				}
			}
			if err != nil || !hasAttempt {
				t.Error("Meta credential downloaded before its attempt audit")
			}
			io.WriteString(writer, `{"type":"meta","dca_token":"dca:quota-fixture","access_token":"LLM|private-fixture"}`)
		case "/v8/management/requests/api-call":
			observations.Add(1)
			var payload struct {
				URL    string            `json:"url"`
				Header map[string]string `json:"header"`
			}
			if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
				t.Error(err)
			}
			if payload.URL != quota.MetaUsageURL || payload.Header["Authorization"] != "Bearer dca:quota-fixture" {
				t.Error("Meta observation did not use the persisted DCA token")
			}
			io.WriteString(writer, `{"status_code":200,"body":{"api_key":"LLM|private-fixture","email":"private@example.invalid","subs_tier_name":"Muse Pro","is_subs_active":false,"subs_usage":{"window":{"used_percent":25,"window_duration_mins":300},"weekly":{"used_percent":40}}}}`)
		default:
			io.WriteString(writer, `{}`)
		}
	})
	repo = testRepo
	response, err := client.Post(baseURL+"/omc/api/v1/management/quota/refresh", "application/json", bytes.NewBufferString(`{"auth_index":"meta-fixture"}`))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("refresh failed: %d %s %v", response.StatusCode, raw, err)
	}
	for _, secret := range []string{"dca:quota-fixture", "LLM|private-fixture", "private@example.invalid"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("secret in response: %s", raw)
		}
	}
	snapshots, err := repo.GetLatestQuotaSnapshots(context.Background(), []string{"meta-fixture"})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, exists := snapshots["meta-fixture"]
	if !exists || !strings.Contains(snapshot.PlanJSON, `"subscription_active":false`) || !strings.Contains(snapshot.PlanJSON, "Muse Pro") {
		t.Fatalf("plan not persisted: %+v", snapshot)
	}
	if strings.Contains(snapshot.PlanJSON+snapshot.WindowsJSON, "private") || strings.Contains(snapshot.PlanJSON+snapshot.WindowsJSON, "dca:") {
		t.Fatal("secret persisted in quota snapshot")
	}
	for _, path := range []string{"/omc/api/v1/management/quota", "/omc/api/v1/management/quota/meta-fixture"} {
		response, body := getJSON(t, client, baseURL+path)
		if response.StatusCode != http.StatusOK || !strings.Contains(string(body), "Muse Pro") || strings.Contains(string(body), "private-fixture") {
			t.Fatalf("unsafe/unreadable quota after refresh: %d %s", response.StatusCode, body)
		}
	}
	// A repeated selection must not repeat Meta's key exchange or its audit.
	response, err = client.Post(baseURL+"/omc/api/v1/management/quota/refresh", "application/json", bytes.NewBufferString(`{"auth_indexes":["meta-fixture"," meta-fixture ","","meta-fixture"]}`))
	if err != nil {
		t.Fatal(err)
	}
	var batch struct {
		Total  int                     `json:"total"`
		Quotas []quota.NormalizedQuota `json:"quotas"`
	}
	err = json.NewDecoder(response.Body).Decode(&batch)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || batch.Total != 1 || len(batch.Quotas) != 1 {
		t.Fatalf("duplicate batch refresh: status=%d total=%d quotas=%d err=%v", response.StatusCode, batch.Total, len(batch.Quotas), err)
	}
	response, err = client.Post(baseURL+"/omc/api/v1/management/quota/refresh", "application/json", bytes.NewBufferString(`{"auth_indexes":[" ",""]}`))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty batch status=%d", response.StatusCode)
	}

	if _, err := repo.SQL().Exec("DROP TABLE audit_events"); err != nil {
		t.Fatal(err)
	}
	for _, payload := range []string{`{"auth_index":"meta-fixture"}`, `{"auth_indexes":["meta-fixture"]}`} {
		response, err := client.Post(baseURL+"/omc/api/v1/management/quota/refresh", "application/json", bytes.NewBufferString(payload))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != http.StatusInternalServerError {
			t.Fatalf("audit failure status=%d", response.StatusCode)
		}
	}
	if downloads.Load() != 2 || observations.Load() != 2 {
		t.Fatalf("Meta action ran without audit: downloads=%d observations=%d", downloads.Load(), observations.Load())
	}
}
