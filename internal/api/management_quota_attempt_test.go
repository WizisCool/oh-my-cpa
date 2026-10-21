package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// TestQuotaRefreshFailureStaysOnThePage covers the defect an operator hit as "the toast said the
// refresh failed, the row still said Normal": the failed read is never stored as an observation,
// so the overview has to say what the last attempt did on its own.
func TestQuotaRefreshFailureStaysOnThePage(t *testing.T) {
	const managementKey = "management-secret"

	usageStatus := http.StatusOK
	cpaServer := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+managementKey {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v8/management/credentials":
			_, _ = writer.Write([]byte(`{"files":[{
				"id":"file-1","name":"codex-main.json","auth_index":"codex-idx-1",
				"type":"codex","provider":"codex","disabled":false
			}]}`))
		case "/v8/management/requests/api-call":
			var payload struct {
				URL string `json:"url"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			switch {
			case strings.Contains(payload.URL, "wham/usage"):
				if usageStatus != http.StatusOK {
					writer.Write([]byte(`{"status_code":` + itoa(usageStatus) + `,"body":{"message":"upstream refused"}}`))
					return
				}
				// A four-hour reset keeps the age rule out of this test: the reading it
				// describes cannot have outlived its own boundary.
				writer.Write([]byte(`{"status_code":200,"body":{
					"plan_type":"pro",
					"rate_limit":{"primary_window":{"used_percent":15,"limit_window_seconds":18000,"reset_after_seconds":14400}}
				}}`))
			default:
				writer.Write([]byte(`{"status_code":200,"body":{}}`))
			}
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer cpaServer.Close()

	handler := testHandler(t, "")
	appServer := httptest.NewServer(handler.Router())
	defer appServer.Close()

	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte(managementKey))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if err := handler.repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 cpaServer.URL,
		UsageAddr:               strings.TrimPrefix(cpaServer.URL, "http://"),
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatal(err)
	}

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	loginResp, err := client.Post(appServer.URL+"/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	loginResp.Body.Close()

	refresh := func() quota.NormalizedQuota {
		t.Helper()
		response, err := client.Post(appServer.URL+"/api/v1/management/quota/refresh", "application/json", bytes.NewBufferString(`{"auth_index":"codex-idx-1"}`))
		if err != nil {
			t.Fatalf("POST /quota/refresh failed: %v", err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("refresh status = %d, want 200", response.StatusCode)
		}
		var result struct {
			Quota quota.NormalizedQuota `json:"quota"`
		}
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatalf("decode refresh result failed: %v", err)
		}
		return result.Quota
	}
	readCredential := func() (QuotaItemDTO, quota.QuotaOverviewSummary) {
		t.Helper()
		response, err := client.Get(appServer.URL + "/api/v1/management/quota")
		if err != nil {
			t.Fatalf("GET /quota failed: %v", err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("overview status = %d, want 200", response.StatusCode)
		}
		var overview struct {
			Summary quota.QuotaOverviewSummary `json:"summary"`
			Quotas  []QuotaItemDTO             `json:"quotas"`
		}
		if err := json.NewDecoder(response.Body).Decode(&overview); err != nil {
			t.Fatalf("decode overview failed: %v", err)
		}
		if len(overview.Quotas) != 1 {
			t.Fatalf("quotas = %d, want 1", len(overview.Quotas))
		}
		return overview.Quotas[0], overview.Summary
	}

	// 1. A stored observation from three days ago is what the console presents, and nobody has
	// attempted a read since it was taken.
	observedAt := time.Now().Add(-72 * time.Hour).UnixMilli()
	resetAt := time.Now().Add(4 * time.Hour).UnixMilli()
	if err := handler.repo.SaveQuotaSnapshot(context.Background(), repository.QuotaSnapshotRecord{
		AuthIndex:    "codex-idx-1",
		Provider:     "codex",
		Status:       "healthy",
		WindowsJSON:  `[{"id":"five_hour","label":"5h","kind":"five_hour","scope":"standard","remaining_percent":85,"used_percent":15,"period_hours":5,"reset_at_ms":` + itoa64(resetAt) + `}]`,
		ObservedAtMS: observedAt,
	}); err != nil {
		t.Fatal(err)
	}
	stored, _ := readCredential()
	if stored.Status != "healthy" || stored.LastRefresh != nil {
		t.Fatalf("stored row = %q last_refresh=%+v, want the reading and no attempt", stored.Status, stored.LastRefresh)
	}
	if stored.ObservedAtMS != observedAt || len(stored.Windows) != 1 {
		t.Fatalf("stored reading = %d windows=%d, want the seeded observation", stored.ObservedAtMS, len(stored.Windows))
	}

	// 2. An auth failure is reported as needing a new sign-in, and the reading it failed to
	// replace stays on the page rather than being blanked or presented as current.
	usageStatus = http.StatusUnauthorized
	if reading := refresh(); reading.Status != "error" {
		t.Fatalf("failed read status = %q, want error", reading.Status)
	}
	failed, summary := readCredential()
	if failed.Status != "error" {
		t.Fatalf("row status = %q, want error after a 401 refresh", failed.Status)
	}
	if failed.LastRefresh == nil || failed.LastRefresh.Outcome != repository.QuotaRefreshAttemptFailed {
		t.Fatalf("last_refresh = %+v, want the failed attempt", failed.LastRefresh)
	}
	if !strings.Contains(failed.LastRefresh.Error, "401") || !strings.Contains(failed.Error, "401") {
		t.Fatalf("last_refresh.error = %q row error = %q, want the provider's 401", failed.LastRefresh.Error, failed.Error)
	}
	if failed.Recommendation.Action != "reauth" {
		t.Fatalf("recommendation = %+v, want the reauth action", failed.Recommendation)
	}
	if failed.ObservedAtMS != observedAt {
		t.Fatalf("observed_at_ms = %d, want the previous observation %d", failed.ObservedAtMS, observedAt)
	}
	if len(failed.Windows) != 1 {
		t.Fatalf("windows = %d, want the previous reading's window", len(failed.Windows))
	}
	if summary.AttentionCount != 1 {
		t.Fatalf("attention_count = %d, want the failing credential counted", summary.AttentionCount)
	}

	// 3. A provider that refuses without an auth problem leaves the numbers standing and says the
	// reading is stale, rather than claiming it is current or calling it a dead credential.
	usageStatus = http.StatusInternalServerError
	if reading := refresh(); reading.Status != "stale" {
		t.Fatalf("upstream-failure read status = %q, want stale", reading.Status)
	}
	stale, _ := readCredential()
	if stale.Status != "stale" {
		t.Fatalf("row status = %q, want stale after a 500 refresh", stale.Status)
	}
	if stale.Recommendation.Action != "refresh" || len(stale.Windows) != 1 {
		t.Fatalf("row = %+v, want a refresh hint beside the retained window", stale.Recommendation)
	}
	if stale.LastRefresh == nil || !strings.Contains(stale.LastRefresh.Error, "500") {
		t.Fatalf("last_refresh = %+v, want the 500 that caused it", stale.LastRefresh)
	}

	// 4. The next successful read clears the failure: a row cannot stay red once the console has
	// answered the question again.
	usageStatus = http.StatusOK
	if reading := refresh(); reading.Status != "healthy" {
		t.Fatalf("recovered read status = %q, want healthy", reading.Status)
	}
	recovered, summary := readCredential()
	if recovered.Status != "healthy" || recovered.Error != "" {
		t.Fatalf("row = %q error=%q, want a clean reading", recovered.Status, recovered.Error)
	}
	if recovered.LastRefresh == nil || recovered.LastRefresh.Outcome != repository.QuotaRefreshAttemptSucceeded || recovered.LastRefresh.Error != "" {
		t.Fatalf("last_refresh = %+v, want the successful attempt with no reason left over", recovered.LastRefresh)
	}
	if summary.AttentionCount != 0 {
		t.Fatalf("attention_count = %d, want none after recovery", summary.AttentionCount)
	}
}

// itoa64 keeps the seeded window's reset instant readable in the JSON it builds.
func itoa64(value int64) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 20)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

// itoa keeps the fake gateway's status injection readable without an fmt import in this file.
func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 3)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

// TestQuotaRefreshFailureWithoutAReading covers the credential the console has never read: there is
// no observation for the failure to sit beside, so the attempt is the only fact there is - and a
// page that presented it as "idle, never read" would hide the sign-in that has to happen.
func TestQuotaRefreshFailureWithoutAReading(t *testing.T) {
	const managementKey = "management-secret"

	cpaServer := newFakeCPA(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+managementKey {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v8/management/credentials":
			_, _ = writer.Write([]byte(`{"files":[{
				"id":"file-1","name":"codex-fresh.json","auth_index":"codex-idx-1",
				"type":"codex","provider":"codex","disabled":false
			}]}`))
		case "/v8/management/requests/api-call":
			_, _ = writer.Write([]byte(`{"status_code":401,"body":{"message":"token expired"}}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer cpaServer.Close()

	handler := testHandler(t, "")
	appServer := httptest.NewServer(handler.Router())
	defer appServer.Close()

	cipher, err := crypto.New("01234567890123456789012345678901")
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, nonce, err := cipher.Encrypt([]byte(managementKey))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if err := handler.repo.UpsertInstance(context.Background(), domain.CPAInstance{
		ID:                      "default",
		Name:                    "Default",
		BaseURL:                 cpaServer.URL,
		UsageAddr:               strings.TrimPrefix(cpaServer.URL, "http://"),
		ManagementKeyCiphertext: ciphertext,
		ManagementKeyNonce:      nonce,
		CreatedAt:               now,
		UpdatedAt:               now,
	}); err != nil {
		t.Fatal(err)
	}

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Jar: jar}
	loginResp, err := client.Post(appServer.URL+"/api/auth/login", "application/json", bytes.NewBufferString(`{"password":"management-secret"}`))
	if err != nil {
		t.Fatal(err)
	}
	loginResp.Body.Close()

	refreshResp, err := client.Post(appServer.URL+"/api/v1/management/quota/refresh", "application/json", bytes.NewBufferString(`{"auth_index":"codex-idx-1"}`))
	if err != nil {
		t.Fatalf("POST /quota/refresh failed: %v", err)
	}
	defer refreshResp.Body.Close()
	if refreshResp.StatusCode != http.StatusOK {
		t.Fatalf("refresh status = %d, want 200", refreshResp.StatusCode)
	}

	overviewResp, err := client.Get(appServer.URL + "/api/v1/management/quota")
	if err != nil {
		t.Fatalf("GET /quota failed: %v", err)
	}
	defer overviewResp.Body.Close()
	var overview struct {
		Summary quota.QuotaOverviewSummary `json:"summary"`
		Quotas  []QuotaItemDTO             `json:"quotas"`
	}
	if err := json.NewDecoder(overviewResp.Body).Decode(&overview); err != nil {
		t.Fatalf("decode overview failed: %v", err)
	}
	if len(overview.Quotas) != 1 {
		t.Fatalf("quotas = %d, want 1", len(overview.Quotas))
	}
	row := overview.Quotas[0]
	if row.Status != "error" {
		t.Fatalf("row status = %q, want error: a failed first read is not 'never read'", row.Status)
	}
	if row.Recommendation.Action != "reauth" {
		t.Fatalf("recommendation = %+v, want the reauth action", row.Recommendation)
	}
	if row.LastRefresh == nil || row.LastRefresh.Outcome != repository.QuotaRefreshAttemptFailed || !strings.Contains(row.LastRefresh.Error, "401") {
		t.Fatalf("last_refresh = %+v, want the failed attempt", row.LastRefresh)
	}
	if len(row.Windows) != 0 {
		t.Fatalf("windows = %d, want none: nothing was ever observed", len(row.Windows))
	}
	if overview.Summary.AttentionCount != 1 {
		t.Fatalf("attention_count = %d, want the failing credential counted", overview.Summary.AttentionCount)
	}

	detailResp, err := client.Get(appServer.URL + "/api/v1/management/quota/codex-idx-1")
	if err != nil {
		t.Fatalf("GET /quota/{authIndex} failed: %v", err)
	}
	defer detailResp.Body.Close()
	if detailResp.StatusCode != http.StatusOK {
		t.Fatalf("detail status = %d, want 200", detailResp.StatusCode)
	}
	var detail struct {
		Quota       quota.NormalizedQuota            `json:"quota"`
		LastRefresh *QuotaRefreshAttemptDTO          `json:"last_refresh"`
		History     []repository.QuotaSnapshotRecord `json:"history"`
	}
	if err := json.NewDecoder(detailResp.Body).Decode(&detail); err != nil {
		t.Fatalf("decode detail failed: %v", err)
	}
	if detail.Quota.Status != "error" || detail.Quota.Recommendation.Action != "reauth" {
		t.Fatalf("detail quota = %q/%+v, want error with reauth", detail.Quota.Status, detail.Quota.Recommendation)
	}
	if detail.LastRefresh == nil || detail.LastRefresh.Outcome != repository.QuotaRefreshAttemptFailed {
		t.Fatalf("detail last_refresh = %+v, want the failed attempt", detail.LastRefresh)
	}
	if len(detail.History) != 0 {
		t.Fatalf("history = %d, want none: a failed read is not an observation", len(detail.History))
	}
}
