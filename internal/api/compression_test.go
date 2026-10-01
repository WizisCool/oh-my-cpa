package api

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func decompressBody(t *testing.T, data []byte) []byte {
	t.Helper()
	reader, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	return decoded
}

func TestGzipNegotiation(t *testing.T) {
	for _, entry := range []struct {
		header     string
		isAccepted bool
	}{
		{"", false}, {"br", false}, {"gzip", true}, {"br, GZip; q=0.5", true},
		{"gzip;q=0", false}, {"*;q=1, gzip;q=0", false}, {"gzip;q=0, *;q=1", false},
		{"*;q=0.5", true}, {"*;q=0", false}, {"gzip;q=broken", false}, {"gzip;q=1.5", false},
		{"gzip;q=NaN", false}, {"gzip;q=-0.1", false}, {"gzip;q=0.001", true},
	} {
		t.Run(entry.header, func(t *testing.T) {
			header := make(http.Header)
			header.Set("Accept-Encoding", entry.header)
			if acceptsGzip(header) != entry.isAccepted {
				t.Fatalf("negotiation %q", entry.header)
			}
		})
	}
	header := http.Header{"Accept-Encoding": {"br", "gzip"}}
	if !acceptsGzip(header) {
		t.Fatal("multiple header lines lost")
	}
}

func TestJSONCompressionPreservesResponsesAndSkipsStreamingAndDownloads(t *testing.T) {
	payload := `{"data":"` + strings.Repeat("usage", 1000) + `"}`
	for _, entry := range []struct {
		name, method, encoding, contentType, disposition, cacheControl, contentEncoding, cookie, rangeHeader string
		status                                                                                               int
		isCompressed                                                                                         bool
	}{
		{name: "json", encoding: "gzip", contentType: "application/json; charset=utf-8", status: 200, isCompressed: true},
		{name: "identity", contentType: "application/json", status: 200},
		{name: "refused", encoding: "*;q=1, gzip;q=0", contentType: "application/json", status: 200},
		{name: "error", encoding: "gzip", contentType: "application/json", status: 409, isCompressed: true},
		{name: "sse", encoding: "gzip", contentType: "text/event-stream", status: 200},
		{name: "json-download", encoding: "gzip", contentType: "application/json", disposition: "attachment; filename=diagnostics.json", status: 200},
		{name: "head", method: "HEAD", encoding: "gzip", contentType: "application/json", status: 200},
		{name: "empty", encoding: "gzip", contentType: "application/json", status: 204},
		{name: "unmodified", encoding: "gzip", contentType: "application/json", status: 304},
		{name: "encoded", encoding: "gzip", contentType: "application/json", contentEncoding: "br", status: 200},
		{name: "no-transform", encoding: "gzip", contentType: "application/json", cacheControl: "private, no-transform", status: 200},
		{name: "login", encoding: "gzip", contentType: "application/json", cookie: "session=fixture", status: 200},
		{name: "range", encoding: "gzip", contentType: "application/json", rangeHeader: "bytes=0-100", status: 206},
	} {
		t.Run(entry.name, func(t *testing.T) {
			method := entry.method
			if method == "" {
				method = http.MethodGet
			}
			request := httptest.NewRequest(method, "/omc/api/v1/example", nil)
			request.Header.Set("Accept-Encoding", entry.encoding)
			request.Header.Set("Range", entry.rangeHeader)
			recorder := httptest.NewRecorder()
			compressAPIResponses(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				writer.Header().Set("Content-Type", entry.contentType)
				writer.Header().Set("Vary", "Origin")
				writer.Header().Set("Content-Length", strconv.Itoa(len(payload)))
				writer.Header().Set("Content-Disposition", entry.disposition)
				writer.Header().Set("Content-Encoding", entry.contentEncoding)
				writer.Header().Set("Cache-Control", entry.cacheControl)
				if entry.cookie != "" {
					writer.Header().Set("Set-Cookie", entry.cookie)
				}
				writer.WriteHeader(entry.status)
				writer.WriteHeader(http.StatusInternalServerError)
				if method != "HEAD" && entry.status != 204 && entry.status != 304 {
					_, _ = io.WriteString(writer, payload)
				}
			})).ServeHTTP(recorder, request)
			if recorder.Code != entry.status {
				t.Fatalf("status: %d", recorder.Code)
			}
			if (recorder.Header().Get("Content-Encoding") == "gzip") != entry.isCompressed {
				t.Fatalf("headers: %v", recorder.Header())
			}
			if entry.isCompressed {
				if decoded := string(decompressBody(t, recorder.Body.Bytes())); decoded != payload {
					t.Fatal("JSON changed")
				}
				if recorder.Header().Get("Content-Length") != "" {
					t.Fatal("retained uncompressed length")
				}
				if strings.Join(recorder.Header().Values("Vary"), ",") != "Origin,Accept-Encoding" {
					t.Fatalf("vary lost: %v", recorder.Header())
				}
			} else if method != "HEAD" && entry.status != 204 && entry.status != 304 && recorder.Body.String() != payload {
				t.Fatal("identity response changed")
			}
			if entry.name == "identity" && !strings.Contains(strings.Join(recorder.Header().Values("Vary"), ","), "Accept-Encoding") {
				t.Fatal("identity cache does not vary")
			}
		})
	}
}

func TestCompressionForwardsImmediateSSEFlushAndResponseController(t *testing.T) {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/omc/api/v1/agent/runs/test", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	compressAPIResponses(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(writer, "data: first\n\n")
		if err := http.NewResponseController(writer).Flush(); err != nil {
			t.Fatal(err)
		}
		if !recorder.Flushed || recorder.Body.String() != "data: first\n\n" {
			t.Fatal("first event buffered")
		}
		_, _ = io.WriteString(writer, "data: second\n\n")
	})).ServeHTTP(recorder, request)
	if recorder.Header().Get("Content-Encoding") != "" {
		t.Fatal("SSE compressed")
	}
	if recorder.Body.String() != "data: first\n\ndata: second\n\n" {
		t.Fatal("events changed")
	}
}

func TestStaticCompressionCacheIsBoundedAndConcurrent(t *testing.T) {
	payload := []byte(strings.Repeat("const data = 'fixture';\n", 1000))
	cache := assetGzipCache{assets: make(map[string][]byte), limit: 1024}
	first := cache.compressAsset("fixture.js", payload)
	if decoded := decompressBody(t, first); !bytes.Equal(decoded, payload) {
		t.Fatal("asset changed")
	}
	var workers sync.WaitGroup
	for i := 0; i < 20; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			compressed := cache.compressAsset("fixture.js", payload)
			if &compressed[0] != &first[0] {
				t.Error("cached bytes replaced")
			}
		}()
	}
	workers.Wait()
	for i := 0; i < 20; i++ {
		cache.compressAsset(strconv.Itoa(i)+".js", payload)
	}
	retainedBytes := 0
	for _, compressed := range cache.assets {
		retainedBytes += len(compressed)
	}
	if cache.bytes != retainedBytes || retainedBytes > cache.limit {
		t.Fatal("unbounded cache")
	}
	if cache.compressAsset("small.svg", []byte("<svg/>")) != nil {
		t.Fatal("small asset inflated")
	}
}

func TestStaticGzipGETAndHEADHaveMatchingHeaders(t *testing.T) {
	payload := []byte(strings.Repeat("const fixture = true;\n", 1000))
	var getHeader http.Header
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		request := httptest.NewRequest(method, "/omc/assets/compression-test.js", nil)
		request.Header.Set("Accept-Encoding", "gzip")
		recorder := httptest.NewRecorder()
		serveAssetRepresentation(recorder, request, "assets/compression-test.js", payload)
		if method == http.MethodGet {
			getHeader = recorder.Header().Clone()
			if !bytes.Equal(decompressBody(t, recorder.Body.Bytes()), payload) {
				t.Fatal("asset changed")
			}
			if getHeader.Get("Content-Encoding") != "gzip" || getHeader.Get("Cache-Control") != "public, max-age=31536000, immutable" {
				t.Fatalf("headers: %v", getHeader)
			}
			if getHeader.Get("Content-Length") != strconv.Itoa(recorder.Body.Len()) {
				t.Fatal("incorrect length")
			}
		} else {
			if recorder.Body.Len() != 0 {
				t.Fatal("HEAD body")
			}
			for _, name := range []string{"Content-Encoding", "Content-Length", "Content-Type", "Cache-Control", "Vary"} {
				if recorder.Header().Get(name) != getHeader.Get(name) {
					t.Fatalf("HEAD %s differs", name)
				}
			}
		}
	}
}

func TestRouterCompressesAPIUnderConfiguredBasePath(t *testing.T) {
	for _, base := range []string{"/", "/omc"} {
		handler := testHandler(t, base)
		request := httptest.NewRequest(http.MethodGet, strings.TrimSuffix(base, "/")+"/api/healthz", nil)
		request.Header.Set("Accept-Encoding", "gzip")
		recorder := httptest.NewRecorder()
		handler.Router().ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Encoding") != "gzip" {
			t.Fatalf("base %s: %d, %v", base, recorder.Code, recorder.Header())
		}
		var response map[string]any
		if err := json.Unmarshal(decompressBody(t, recorder.Body.Bytes()), &response); err != nil {
			t.Fatal(err)
		}
		if response["database_status"] != "ok" {
			t.Fatalf("health response changed: %v", response)
		}
	}
}

func TestExplicitCredentialRevealIsNotCompressed(t *testing.T) {
	for _, value := range []string{"true", "TRUE", "TrUe"} {
		request := httptest.NewRequest(http.MethodGet, "/omc/api/v1/management/api-keys?include_keys="+value, nil)
		request.Header.Set("Accept-Encoding", "gzip")
		recorder := httptest.NewRecorder()
		compressAPIResponses(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writeJSON(writer, http.StatusOK, map[string]string{"key": "fixture-only"})
		})).ServeHTTP(recorder, request)
		if recorder.Header().Get("Content-Encoding") != "" {
			t.Fatal("explicit credential reveal compressed")
		}
	}
}
