package api

import (
	"net/http"
	"strings"
	"testing"
)

func TestVertexImportForwardsTheKeyAndReportsOnlyItsIdentity(t *testing.T) {
	var forwardedKey, forwardedLocation string
	upstream := func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		if request.URL.Path != "/v8/management/oauth/import" {
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
			return
		}
		if request.URL.Query().Get("provider") != "vertex" {
			t.Errorf("provider = %q, want vertex", request.URL.Query().Get("provider"))
		}
		file, _, err := request.FormFile("file")
		if err != nil {
			t.Errorf("CPA reads the key from the form's file part: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		defer file.Close()
		buffer := make([]byte, 4096)
		read, _ := file.Read(buffer)
		forwardedKey = string(buffer[:read])
		forwardedLocation = request.FormValue("location")
		_, _ = writer.Write([]byte(`{"status":"ok","auth-file":"/srv/cpa/auths/vertex-acme-prod.json","project_id":"acme-prod","email":"runner@acme-prod.iam.gserviceaccount.com","location":"europe-west4"}`))
	}
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", upstream)
	endpoint := baseURL + "/omc/api/v1/management/auth-files/vertex-import"
	key := `{"type":"service_account","project_id":"acme-prod","private_key":"-----BEGIN PRIVATE KEY-----\nKEY-MATERIAL-SECRET\n-----END PRIVATE KEY-----\n","client_email":"runner@acme-prod.iam.gserviceaccount.com"}`

	response, raw := doJSON(t, client, http.MethodPost, endpoint+"?location=europe-west4", key)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("import = %d %s", response.StatusCode, raw)
	}
	if forwardedKey != key || forwardedLocation != "europe-west4" {
		t.Fatalf("forwarded key/location = %q/%q, want the upload verbatim and the chosen region", forwardedKey, forwardedLocation)
	}
	body := string(raw)
	if !strings.Contains(body, `"name":"vertex-acme-prod.json"`) || strings.Contains(body, "/srv/cpa") {
		t.Fatalf("response = %s, want the file name without CPA's directory", body)
	}
	if strings.Contains(body, "KEY-MATERIAL-SECRET") {
		t.Fatalf("response leaked the private key: %s", body)
	}

	for name, tc := range map[string]struct{ query, body, wantReason string }{
		"not json":       {"", `not json`, "not a JSON object"},
		"no private key": {"", `{"type":"authorized_user","project_id":"acme-prod"}`, "no private_key"},
		"no project":     {"", `{"private_key":"x"}`, "no project_id"},
		"bad location":   {"?location=us-central1.evil.test", key, "Google Cloud region"},
	} {
		response, raw = doJSON(t, client, http.MethodPost, endpoint+tc.query, tc.body)
		if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(raw), tc.wantReason) {
			t.Errorf("%s = %d %s, want 400 naming %q", name, response.StatusCode, raw, tc.wantReason)
		}
	}
	if count := recorder.count(http.MethodPost, "/v8/management/oauth/import"); count != 1 {
		t.Fatalf("CPA received %d imports, want a refused upload to send nothing", count)
	}
}
