package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

type listedConfigBackups struct {
	Backups []struct {
		ID     int64  `json:"id"`
		Layout string `json:"layout"`
		Reason string `json:"reason"`
	} `json:"backups"`
	Settings struct {
		Retention    int `json:"retention"`
		RetentionMin int `json:"retention_min"`
		RetentionMax int `json:"retention_max"`
	} `json:"settings"`
}

func listConfigBackupsForTest(t *testing.T, client *http.Client, baseURL string) listedConfigBackups {
	t.Helper()
	resp, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/config/backups")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list status = %d body %s", resp.StatusCode, payload)
	}
	var listed listedConfigBackups
	if err := json.Unmarshal(payload, &listed); err != nil {
		t.Fatal(err)
	}
	return listed
}

// Every configuration write keeps the stored file first, and a kept v8 file is
// written back whole without its content ever reaching the browser.
func TestConfigBackupIsTakenBeforeEveryWriteAndRestoresServerSide(t *testing.T) {
	stored := "config-version: 8\nmanagement:\n    secret-key: stored-secret\n"
	fixture := &configFixtureCPA{}
	client, baseURL, _ := startDashboardTestServerStoring(t, stored, fixture.serve)

	_, payload := getJSON(t, client, baseURL+"/omc/api/v1/management/config")
	var loaded struct {
		Revision string `json:"revision"`
	}
	_ = json.Unmarshal(payload, &loaded)
	body, _ := json.Marshal(map[string]any{"revision": loaded.Revision, "changes": []any{map[string]any{"path": []string{"observability", "logs", "debug"}, "value": true}}})
	if resp, payload := doJSON(t, client, http.MethodPatch, baseURL+"/omc/api/v1/management/config", string(body)); resp.StatusCode != http.StatusOK {
		t.Fatalf("patch status = %d body %s", resp.StatusCode, payload)
	}
	listed := listConfigBackupsForTest(t, client, baseURL)
	if len(listed.Backups) != 1 || listed.Backups[0].Layout != "v8" || listed.Backups[0].Reason != "config_changes" {
		t.Fatalf("backups = %+v", listed.Backups)
	}

	resp, payload := doJSON(t, client, http.MethodPost, fmt.Sprintf("%s/omc/api/v1/management/config/backups/%d/restore", baseURL, listed.Backups[0].ID), "")
	if resp.StatusCode != http.StatusOK || strings.Contains(string(payload), "stored-secret") || !strings.Contains(string(payload), `"revision"`) {
		t.Fatalf("restore status = %d body %s", resp.StatusCode, payload)
	}
	writes, bodies := fixture.recordedWrites()
	if len(writes) != 2 || writes[1] != "PUT /config.yaml" || bodies[1] != stored {
		t.Fatalf("writes = %v, last body %q", writes, bodies[len(bodies)-1])
	}
	if resp, _ := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/config/backups/999/restore", ""); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("missing backup restore status = %d", resp.StatusCode)
	}
}

func TestALegacyConfigBackupIsDownloadOnly(t *testing.T) {
	legacy := "port: 8317\ndebug: false\n"
	fixture := &configFixtureCPA{}
	client, baseURL, _ := startDashboardTestServerStoring(t, legacy, fixture.serve)
	if resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/config/backups", ""); resp.StatusCode != http.StatusOK || !strings.Contains(string(payload), `"created":true`) {
		t.Fatalf("manual backup status = %d body %s", resp.StatusCode, payload)
	}
	listed := listConfigBackupsForTest(t, client, baseURL)
	if len(listed.Backups) != 1 || listed.Backups[0].Layout != "legacy" || listed.Backups[0].Reason != "manual" {
		t.Fatalf("backups = %+v", listed.Backups)
	}
	resp, payload := doJSON(t, client, http.MethodPost, fmt.Sprintf("%s/omc/api/v1/management/config/backups/%d/restore", baseURL, listed.Backups[0].ID), "")
	if resp.StatusCode != http.StatusConflict || !strings.Contains(string(payload), "config_backup_legacy") {
		t.Fatalf("legacy restore status = %d body %s", resp.StatusCode, payload)
	}
	if writes, _ := fixture.recordedWrites(); len(writes) != 0 {
		t.Fatalf("a legacy restore wrote %v", writes)
	}
}

func TestConfigBackupManualCopySettingsAndDeletion(t *testing.T) {
	fixture := &configFixtureCPA{}
	client, baseURL, _ := startDashboardTestServer(t, fixture.serve)
	listed := listConfigBackupsForTest(t, client, baseURL)
	if len(listed.Backups) != 0 || listed.Settings.Retention != 20 || listed.Settings.RetentionMin != 5 || listed.Settings.RetentionMax != 100 {
		t.Fatalf("initial = %+v", listed)
	}

	// The same stored file is not kept twice, and the answer says so.
	if resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/config/backups", ""); resp.StatusCode != http.StatusOK || !strings.Contains(string(payload), `"created":true`) {
		t.Fatalf("first manual backup = %d %s", resp.StatusCode, payload)
	}
	if resp, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/config/backups", ""); resp.StatusCode != http.StatusOK || !strings.Contains(string(payload), `"created":false`) {
		t.Fatalf("repeated manual backup = %d %s", resp.StatusCode, payload)
	}

	if resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/backups/settings", `{"retention":4}`); resp.StatusCode != http.StatusBadRequest || !strings.Contains(string(payload), "config_backup_retention_invalid") {
		t.Fatalf("out-of-range retention = %d %s", resp.StatusCode, payload)
	}
	if resp, payload := doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/management/config/backups/settings", `{"retention":10}`); resp.StatusCode != http.StatusOK || !strings.Contains(string(payload), `"retention":10`) {
		t.Fatalf("retention = %d %s", resp.StatusCode, payload)
	}

	listed = listConfigBackupsForTest(t, client, baseURL)
	if len(listed.Backups) != 1 || listed.Settings.Retention != 10 {
		t.Fatalf("after settings = %+v", listed)
	}
	target := fmt.Sprintf("%s/omc/api/v1/management/config/backups/%d", baseURL, listed.Backups[0].ID)
	if resp, payload := doJSON(t, client, http.MethodDelete, target, ""); resp.StatusCode != http.StatusOK {
		t.Fatalf("delete = %d %s", resp.StatusCode, payload)
	}
	if resp, _ := doJSON(t, client, http.MethodDelete, target, ""); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("second delete = %d", resp.StatusCode)
	}
	if listed = listConfigBackupsForTest(t, client, baseURL); len(listed.Backups) != 0 {
		t.Fatalf("after delete = %+v", listed.Backups)
	}
}
