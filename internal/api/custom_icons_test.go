package api

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func TestCustomIconHTTPCRUDAndCaching(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	base := baseURL + "/omc/api/v1/custom-icons"
	imageData := base64.StdEncoding.EncodeToString([]byte(`<svg viewBox="0 0 24 24"><circle r="10"/></svg>`))
	response, payload := doJSON(t, client, http.MethodPost, base+"/preview", `{"data":"`+imageData+`"}`)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(payload), "data:image/svg+xml;base64,") {
		t.Fatalf("preview: %d %s", response.StatusCode, payload)
	}
	response, payload = doJSON(t, client, http.MethodPost, base, `{"name":"Team","data":"`+imageData+`"}`)
	var icon repository.CustomIcon
	if response.StatusCode != http.StatusCreated || json.Unmarshal(payload, &icon) != nil || icon.ID == "" {
		t.Fatalf("create: %d %s", response.StatusCode, payload)
	}
	if strings.Contains(string(payload), imageData) || strings.Contains(string(payload), "content") {
		t.Fatal("artwork leaked into metadata")
	}
	response, payload = getJSON(t, client, base)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(payload), icon.ID) {
		t.Fatalf("list: %d %s", response.StatusCode, payload)
	}
	contentResponse, err := client.Get(base + "/" + icon.ID + "/content")
	if err != nil {
		t.Fatal(err)
	}
	content, _ := io.ReadAll(contentResponse.Body)
	contentResponse.Body.Close()
	tag := contentResponse.Header.Get("ETag")
	if contentResponse.StatusCode != 200 || !strings.Contains(string(content), "circle") || tag == "" || contentResponse.Header.Get("Content-Type") != "image/svg+xml" || contentResponse.Header.Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("content: %d %s", contentResponse.StatusCode, content)
	}
	request, _ := http.NewRequest(http.MethodGet, base+"/"+icon.ID+"/content", nil)
	request.Header.Set("If-None-Match", tag)
	contentResponse, err = client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	contentResponse.Body.Close()
	if contentResponse.StatusCode != 304 {
		t.Fatalf("cache: %d", contentResponse.StatusCode)
	}
	replacement := base64.StdEncoding.EncodeToString([]byte(`<svg><rect width="5" height="5"/></svg>`))
	response, payload = doJSON(t, client, http.MethodPatch, base+"/"+icon.ID, `{"name":"Renamed","data":"`+replacement+`"}`)
	if response.StatusCode != 200 {
		t.Fatalf("update: %d %s", response.StatusCode, payload)
	}
	contentResponse, err = client.Get(base + "/" + icon.ID + "/content")
	if err != nil {
		t.Fatal(err)
	}
	contentResponse.Body.Close()
	if contentResponse.Header.Get("ETag") == tag {
		t.Fatal("replacement reused ETag")
	}
	preferenceURL := baseURL + "/omc/api/v1/preferences/provider_icons"
	response, payload = doJSON(t, client, http.MethodPut, preferenceURL, `{"provider":"custom:`+icon.ID+`"}`)
	if response.StatusCode != 200 {
		t.Fatalf("assign: %s", payload)
	}
	response, payload = doJSON(t, client, http.MethodDelete, base+"/"+icon.ID, "")
	if response.StatusCode != 204 {
		t.Fatalf("referenced deletion: %d %s", response.StatusCode, payload)
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/preferences")
	if response.StatusCode != 200 || strings.Contains(string(payload), "custom:"+icon.ID) {
		t.Fatalf("provider reference was not cleared: %d %s", response.StatusCode, payload)
	}
	response, _ = getJSON(t, client, base+"/"+icon.ID+"/content")
	if response.StatusCode != 404 {
		t.Fatalf("missing: %d", response.StatusCode)
	}
	response, _ = doJSON(t, client, http.MethodPost, base, `{"name":"Too large","data":"`+strings.Repeat("A", 1024*1024)+`"}`)
	if response.StatusCode != 413 {
		t.Fatalf("oversized body: %d", response.StatusCode)
	}
	response, _ = doJSON(t, client, http.MethodPost, base+"/preview", `{"data":"`+imageData+`"}`+strings.Repeat(" ", 1024*1024))
	if response.StatusCode != 413 {
		t.Fatalf("oversized trailing body: %d", response.StatusCode)
	}
	response, payload = doJSON(t, client, http.MethodPost, base+"/preview", `{"data":"not-an-image"}`)
	if response.StatusCode != 400 || !strings.Contains(string(payload), `"code":"custom_icon_invalid_image"`) {
		t.Fatalf("localized error code: %d %s", response.StatusCode, payload)
	}
	response, _ = doJSON(t, client, http.MethodPost, base, `{"name":"Invalid","data":"https://example.com","unknown":1}`)
	if response.StatusCode != 400 {
		t.Fatalf("unknown field: %d", response.StatusCode)
	}
	anonymous, err := http.Get(base)
	if err != nil {
		t.Fatal(err)
	}
	anonymous.Body.Close()
	if anonymous.StatusCode != 401 {
		t.Fatalf("unauthenticated list: %d", anonymous.StatusCode)
	}
	anonymous, err = http.Get(base + "/" + icon.ID + "/content")
	if err != nil {
		t.Fatal(err)
	}
	anonymous.Body.Close()
	if anonymous.StatusCode != 401 {
		t.Fatalf("unauthenticated artwork: %d", anonymous.StatusCode)
	}
}
