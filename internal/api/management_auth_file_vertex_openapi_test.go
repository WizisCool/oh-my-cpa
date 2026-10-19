package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"
)

// vertexOpenAPIUpstream keeps one Vertex service account and one Codex credential
// as CPA does: a field PATCH stores each value under its key, null included,
// and the download returns the whole file, private key and all.
func vertexOpenAPIUpstream(t *testing.T) (func(http.ResponseWriter, *http.Request), func() map[string]any) {
	t.Helper()
	var mu sync.Mutex
	vertex := map[string]any{
		"type":            "vertex",
		"project_id":      "vertex-project",
		"location":        "us-central1",
		"service_account": map[string]any{"private_key": "-----BEGIN PRIVATE KEY-----vertex-private-key"},
		"openapi":         "false",
		"openapi-models":  "meta/llama-3.3-70b-instruct-maas, Meta/Llama-3.3-70B-Instruct-MAAS",
		"models":          []any{map[string]any{"name": "qwen/qwen3-coder-maas"}},
	}
	codex := map[string]any{"type": "codex", "access_token": "codex-access-token"}
	files := map[string]map[string]any{"vertex-sa.json": vertex, "codex.json": codex}
	handler := func(writer http.ResponseWriter, request *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/v8/management/credentials":
			_, _ = writer.Write([]byte(`{"files":[{"id":"vertex-sa.json","name":"vertex-sa.json","auth_index":"vertex-1","provider":"vertex","type":"vertex"},{"id":"codex.json","name":"codex.json","auth_index":"codex-1","provider":"codex","type":"codex"}]}`))
		case request.Method == http.MethodGet && request.URL.Path == "/v8/management/credentials/download":
			file, ok := files[request.URL.Query().Get("name")]
			if !ok {
				writer.WriteHeader(http.StatusNotFound)
				return
			}
			_ = json.NewEncoder(writer).Encode(file)
		case request.Method == http.MethodPatch && request.URL.Path == "/v8/management/credentials/fields":
			var patch map[string]any
			if err := json.NewDecoder(request.Body).Decode(&patch); err != nil {
				t.Errorf("decode patch: %v", err)
			}
			file := files[patch["name"].(string)]
			delete(patch, "name")
			for key, value := range patch {
				// CPA renames hyphenated metadata keys before it applies a patch.
				if key == "openapi_models" {
					delete(file, "openapi-models")
				}
				file[key] = value
			}
			_, _ = writer.Write([]byte(`{"status":"ok"}`))
		default:
			_, _ = writer.Write([]byte(`{}`))
		}
	}
	return handler, func() map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return vertex
	}
}

func TestVertexOpenAPIFieldsSafeProjectionAndVerifiedWrites(t *testing.T) {
	upstream, stored := vertexOpenAPIUpstream(t)
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", upstream)
	fieldsURL := baseURL + "/omc/api/v1/management/auth-files/fields"

	response, raw := doJSON(t, client, http.MethodGet, baseURL+"/omc/api/v1/management/auth-files/safe-fields?name=vertex-sa.json&auth_index=vertex-1", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("safe fields = %d body = %s", response.StatusCode, raw)
	}
	if strings.Contains(string(raw), "private") || strings.Contains(string(raw), "service_account") {
		t.Fatalf("safe fields leaked the service account: %s", raw)
	}
	var fields managementAuthFileSafeFields
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	// CPA reads the string "false" as an explicit opt-out, the hyphenated key as
	// the model list, and the `models` key as further names it registers.
	if fields.OpenAPI == nil || *fields.OpenAPI || fields.OpenAPILocation != "" ||
		!equalStringSlices(fields.OpenAPIModels, []string{"meta/llama-3.3-70b-instruct-maas"}) ||
		!equalStringSlices(fields.OpenAPILegacyModels, []string{"qwen/qwen3-coder-maas"}) {
		t.Fatalf("projected overrides = %#v", fields)
	}

	response, raw = doJSON(t, client, http.MethodPatch, fieldsURL, `{"name":"vertex-sa.json","auth_index":"vertex-1","openapi":true,"openapi-location":" global ","openapi_models":[" deepseek-ai/deepseek-v3.1-maas ","DeepSeek-AI/DeepSeek-V3.1-MAAS"]}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("set overrides = %d body = %s", response.StatusCode, raw)
	}
	var saved struct {
		Fields managementAuthFileSafeFields `json:"fields"`
	}
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Fields.OpenAPI == nil || !*saved.Fields.OpenAPI || saved.Fields.OpenAPILocation != "global" ||
		!equalStringSlices(saved.Fields.OpenAPIModels, []string{"deepseek-ai/deepseek-v3.1-maas"}) {
		t.Fatalf("verified readback = %#v", saved.Fields)
	}
	if strings.Contains(string(raw), "private") {
		t.Fatalf("write response leaked the service account: %s", raw)
	}
	var lastPatch map[string]any
	for _, request := range recordedCPARequests(recorder) {
		if request.Method == http.MethodPatch {
			lastPatch = nil
			if err := json.Unmarshal([]byte(request.Body), &lastPatch); err != nil {
				t.Fatal(err)
			}
		}
	}
	if lastPatch["openapi"] != true || lastPatch["openapi_location"] != "global" || len(lastPatch["openapi_models"].([]any)) != 1 {
		t.Fatalf("CPA patch = %#v", lastPatch)
	}

	// Null returns each override to inheritance; CPA keeps the key as null and
	// reads it as absent. The rest of the file is untouched.
	response, raw = doJSON(t, client, http.MethodPatch, fieldsURL, `{"name":"vertex-sa.json","auth_index":"vertex-1","openapi":null,"openapi_location":"","openapi_models":[]}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("clear overrides = %d body = %s", response.StatusCode, raw)
	}
	saved.Fields = managementAuthFileSafeFields{}
	if err := json.Unmarshal(raw, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Fields.OpenAPI != nil || saved.Fields.OpenAPILocation != "" || len(saved.Fields.OpenAPIModels) != 0 ||
		!equalStringSlices(saved.Fields.OpenAPILegacyModels, []string{"qwen/qwen3-coder-maas"}) {
		t.Fatalf("cleared readback = %#v", saved.Fields)
	}
	file := stored()
	for _, key := range []string{"openapi", "openapi_location", "openapi_models"} {
		if value, exists := file[key]; !exists || value != nil {
			t.Fatalf("%s stored as %#v, want null", key, value)
		}
	}
	if file["service_account"] == nil || file["location"] != "us-central1" || file["models"] == nil {
		t.Fatalf("unrelated metadata changed: %#v", file)
	}
}

func TestVertexOpenAPIFieldsRefuseInvalidValuesAndOtherCredentials(t *testing.T) {
	upstream, _ := vertexOpenAPIUpstream(t)
	client, baseURL, recorder := startAuthFilesTestServer(t, "management-secret-value", upstream)
	fieldsURL := baseURL + "/omc/api/v1/management/auth-files/fields"
	for _, body := range []string{
		`{"name":"vertex-sa.json","openapi":"yes"}`,
		`{"name":"vertex-sa.json","openapi_location":"us-central1/../config"}`,
		`{"name":"vertex-sa.json","openapi_location":"US Central"}`,
		`{"name":"vertex-sa.json","openapi_models":"meta/llama"}`,
		`{"name":"vertex-sa.json","openapi_models":["meta/a,meta/b"]}`,
		`{"name":"vertex-sa.json","openapi_models":[""]}`,
		`{"name":"vertex-sa.json","openapi_models":[` + strings.Repeat(`"m",`, maxVertexOpenAPIModels) + `"m"]}`,
		`{"name":"vertex-sa.json","openapi_models":null,"openapi-models":null}`,
	} {
		if response, raw := doJSON(t, client, http.MethodPatch, fieldsURL, body); response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s = %d body = %s, want 400", body, response.StatusCode, raw)
		}
	}
	// A credential CPA never reads the overrides for is refused before the write.
	if response, raw := doJSON(t, client, http.MethodPatch, fieldsURL, `{"name":"codex.json","auth_index":"codex-1","openapi":true}`); response.StatusCode != http.StatusBadRequest {
		t.Fatalf("codex override = %d body = %s, want 400", response.StatusCode, raw)
	}
	for _, request := range recordedCPARequests(recorder) {
		if request.Method == http.MethodPatch {
			t.Fatalf("a refused override reached CPA: %s", request.Body)
		}
	}
}

func TestVertexOpenAPIFieldsProjectOnlyForVertex(t *testing.T) {
	fields, err := projectManagementAuthFileSafeFields("codex.json", []byte(`{"type":"codex","openapi":true,"models":["gpt-5"],"openapi_location":"global"}`))
	if err != nil {
		t.Fatal(err)
	}
	if fields.OpenAPI != nil || fields.OpenAPILocation != "" || fields.OpenAPIModels != nil || fields.OpenAPILegacyModels != nil {
		t.Fatalf("non-Vertex credential projected Vertex overrides: %#v", fields)
	}
	// CPA ignores any other spelling of the boolean, so it reads as inherited.
	fields, err = projectManagementAuthFileSafeFields("vertex.json", []byte(`{"type":"vertex","openapi":"yes","openapi_models":"a/b, c/d"}`))
	if err != nil {
		t.Fatal(err)
	}
	if fields.OpenAPI != nil || !equalStringSlices(fields.OpenAPIModels, []string{"a/b", "c/d"}) {
		t.Fatalf("vertex projection = %#v", fields)
	}
}
