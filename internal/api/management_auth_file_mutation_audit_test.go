package api

import (
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCredentialMutationsRespectAuditPhases(t *testing.T) {
	for _, mutation := range []struct {
		name   string
		action string
		body   string
	}{
		{"refresh", "auth_file.refresh", `{"name":"codex.json","auth_index":"idx-1"}`},
		{"vertex-import", "auth_file.vertex_import", `{"project_id":"fixture-project","private_key":"SYNTHETIC-KEY-FIXTURE"}`},
	} {
		for _, phase := range []string{"attempt", "success"} {
			t.Run(mutation.name+"/"+phase, func(t *testing.T) {
				var mutationCount atomic.Int32
				client, baseURL, repo := startDashboardTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
					writer.Header().Set("Content-Type", "application/json")
					switch request.URL.Path {
					case "/v8/management/credentials":
						_, _ = writer.Write([]byte(`{"files":[{"name":"codex.json","auth_index":"idx-1","type":"codex"}]}`))
					case "/v8/management/credentials/refresh":
						mutationCount.Add(1)
						_, _ = writer.Write([]byte(`{"ok":true,"auth":{"metadata":{"refresh_token":"SYNTHETIC-REFRESH-SECRET"}}}`))
					case "/v8/management/oauth/import":
						mutationCount.Add(1)
						_, _ = writer.Write([]byte(`{"status":"ok","auth-file":"/srv/cpa/vertex-fixture-project.json","project_id":"fixture-project","location":"us-central1"}`))
					default:
						_, _ = writer.Write([]byte(`{}`))
					}
				})
				_, err := repo.SQL().Exec(`CREATE TRIGGER reject_credential_mutation_audit BEFORE INSERT ON audit_events
					WHEN NEW.action = '` + mutation.action + `' AND NEW.result = '` + phase + `'
					BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`)
				if err != nil {
					t.Fatal(err)
				}
				response, raw := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/management/auth-files/"+mutation.name, mutation.body)
				if phase == "attempt" {
					if response.StatusCode != http.StatusInternalServerError || mutationCount.Load() != 0 {
						t.Fatalf("refused attempt audit: status=%d writes=%d body=%s", response.StatusCode, mutationCount.Load(), raw)
					}
				} else if response.StatusCode != http.StatusOK || mutationCount.Load() != 1 || !strings.Contains(string(raw), `"status":"ok"`) {
					t.Fatalf("landed mutation with refused outcome audit: status=%d writes=%d body=%s", response.StatusCode, mutationCount.Load(), raw)
				}
				if strings.Contains(string(raw), "SYNTHETIC-REFRESH-SECRET") || strings.Contains(string(raw), "SYNTHETIC-KEY-FIXTURE") {
					t.Fatalf("mutation response contains credential material: %s", raw)
				}
			})
		}
	}
}
