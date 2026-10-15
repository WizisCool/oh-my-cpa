package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/image/font/gofont/goregular"

	"github.com/oh-my-cpa/oh-my-cpa/internal/fontasset"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func uploadFontFiles(t *testing.T, client *http.Client, url string, family string, files map[string][]byte) (*http.Response, []byte) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if family != "" {
		_ = writer.WriteField("family", family)
	}
	for name, content := range files {
		part, err := writer.CreateFormFile("file", name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = part.Write(content)
	}
	_ = writer.Close()
	request, _ := http.NewRequest(http.MethodPost, url, &body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	payload, _ := io.ReadAll(response.Body)
	return response, payload
}

func TestFontUploadServesTheStoredFileFromThisOrigin(t *testing.T) {
	client, baseURL, _ := startDashboardTestServer(t, nil)
	base := baseURL + "/omc/api/v1/fonts"

	response, payload := uploadFontFiles(t, client, base+"/upload", "", map[string][]byte{"go.ttf": goregular.TTF})
	var font repository.Font
	if response.StatusCode != http.StatusCreated || json.Unmarshal(payload, &font) != nil {
		t.Fatalf("upload: %d %s", response.StatusCode, payload)
	}
	if font.Family != "Go" || font.Source != repository.FontSourceUpload || len(font.Faces) != 1 || font.Faces[0].Format != fontasset.FormatTrueType || font.Faces[0].WeightMin != 400 {
		t.Fatalf("%+v", font)
	}
	response, payload = getJSON(t, client, base)
	if response.StatusCode != http.StatusOK || !strings.Contains(string(payload), font.ID) || strings.Contains(string(payload), `"content"`) {
		t.Fatalf("list: %d %s", response.StatusCode, payload)
	}

	faceResponse, err := client.Get(base + "/" + font.ID + "/faces/" + font.Faces[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	content, _ := io.ReadAll(faceResponse.Body)
	faceResponse.Body.Close()
	if faceResponse.StatusCode != http.StatusOK || !bytes.Equal(content, goregular.TTF) || faceResponse.Header.Get("Content-Type") != "font/ttf" || !strings.Contains(faceResponse.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("face: %d %v", faceResponse.StatusCode, faceResponse.Header)
	}

	response, payload = uploadFontFiles(t, client, base+"/upload", "", map[string][]byte{"page.ttf": []byte("<html><script>alert(1)</script></html>")})
	if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(payload), "font_invalid_file") {
		t.Fatalf("a document was stored as a font: %d %s", response.StatusCode, payload)
	}
	response, payload = uploadFontFiles(t, client, base+"/upload", `Bad"}`, map[string][]byte{"go.ttf": goregular.TTF})
	if response.StatusCode != http.StatusBadRequest || !strings.Contains(string(payload), "font_invalid_family") {
		t.Fatalf("an unquotable family was stored: %d %s", response.StatusCode, payload)
	}

	if response, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/preferences/omc_fonts", `{"ui":"font:`+font.ID+`"}`); response.StatusCode != http.StatusOK {
		t.Fatalf("assign: %d %s", response.StatusCode, payload)
	}
	if response, payload = doJSON(t, client, http.MethodPut, baseURL+"/omc/api/v1/preferences/omc_fonts", `{"ui":"font:0123456789abcdef0123456789abcdef"}`); response.StatusCode != http.StatusNotFound {
		t.Fatalf("a missing family was assigned: %d %s", response.StatusCode, payload)
	}
	if response, payload = doJSON(t, client, http.MethodDelete, base+"/"+font.ID, ""); response.StatusCode != http.StatusNoContent {
		t.Fatalf("delete: %d %s", response.StatusCode, payload)
	}
	response, payload = getJSON(t, client, baseURL+"/omc/api/v1/preferences")
	if response.StatusCode != http.StatusOK || strings.Contains(string(payload), font.ID) {
		t.Fatalf("the deleted family is still assigned: %s", payload)
	}
}

func TestGoogleFontInstallStoresTheFamilyLocally(t *testing.T) {
	var fixture *httptest.Server
	fixture = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/css2" {
			fmt.Fprintf(writer, "@font-face{font-family:'Inter';font-style:normal;font-weight:400;src:url(%[1]s/a.woff2) format('woff2');unicode-range:U+0-FF;}@font-face{font-family:'Inter';font-style:normal;font-weight:700;src:url(%[1]s/a.woff2) format('woff2');unicode-range:U+0-FF;}", fixture.URL)
			return
		}
		_, _ = writer.Write([]byte("wOF2 inter latin slice"))
	}))
	defer fixture.Close()
	client, baseURL, _ := startDashboardTestServer(t, nil, func(handler *Handler) {
		installer, err := fontasset.NewGoogleInstaller(fixture.URL, http.DefaultTransport)
		if err != nil {
			t.Fatal(err)
		}
		handler.fontInstaller = installer
	})
	response, payload := doJSON(t, client, http.MethodPost, baseURL+"/omc/api/v1/fonts/google", `{"family":"Inter"}`)
	var font repository.Font
	if response.StatusCode != http.StatusCreated || json.Unmarshal(payload, &font) != nil {
		t.Fatalf("install: %d %s", response.StatusCode, payload)
	}
	// One file answering both weights is stored once, as a face spanning them.
	if font.Source != repository.FontSourceGoogle || len(font.Faces) != 1 || font.Faces[0].WeightMin != 400 || font.Faces[0].WeightMax != 700 || font.Faces[0].UnicodeRange != "U+0-FF" {
		t.Fatalf("%+v", font)
	}
	if strings.Contains(string(payload), fixture.URL) {
		t.Fatal("the response carries the upstream file URL; the browser must only ever see this origin")
	}
}
