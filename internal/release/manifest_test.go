package release

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestFetchManifestReturnsThePublishedBytes(t *testing.T) {
	requested := make([]string, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requested = append(requested, request.URL.Path)
		switch {
		case strings.HasSuffix(request.URL.Path, "/v1.2.3/"+ManifestAssetName):
			_, _ = writer.Write([]byte("{\n  \"schema\": 1\n}\n"))
		case strings.HasSuffix(request.URL.Path, "/v1.2.3/"+SignatureAssetName):
			_, _ = writer.Write([]byte("c2lnbmF0dXJl\n"))
		default:
			http.NotFound(writer, request)
		}
	}))
	t.Cleanup(server.Close)
	client := NewManifestClientWithTransport(http.DefaultTransport, server.URL)

	manifest, signature, err := client.FetchManifest(context.Background(), "WizisCool/oh-my-cpa", "v1.2.3")
	if err != nil {
		t.Fatalf("fetch: %v", err)
	}
	// The signature covers the bytes as published, so not even whitespace may change.
	if string(manifest) != "{\n  \"schema\": 1\n}\n" || signature != "c2lnbmF0dXJl" {
		t.Errorf("manifest = %q signature = %q", manifest, signature)
	}
	if requested[0] != "/WizisCool/oh-my-cpa/releases/download/v1.2.3/"+ManifestAssetName {
		t.Errorf("path = %q", requested[0])
	}

	if _, _, err := client.FetchManifest(context.Background(), "WizisCool/oh-my-cpa", "v1.2.4"); !errors.Is(err, ErrManifestMissing) {
		t.Errorf("a release without a manifest is reported as such: %v", err)
	}
	before := len(requested)
	for _, tag := range []string{"../../../other/repo", "latest", "v1.2.3-rc1"} {
		if _, _, err := client.FetchManifest(context.Background(), "WizisCool/oh-my-cpa", tag); err == nil {
			t.Errorf("tag %q must be refused", tag)
		}
	}
	if _, _, err := client.FetchManifest(context.Background(), "not a repository", "v1.2.3"); err == nil {
		t.Errorf("an invalid repository must be refused")
	}
	if len(requested) != before {
		t.Errorf("a refused tag or repository must not reach the network")
	}
}

func TestAssetRedirectsStayOnReleaseAssetHosts(t *testing.T) {
	redirect := func(target string) error {
		parsed, err := url.Parse(target)
		if err != nil {
			t.Fatal(err)
		}
		return restrictAssetRedirects(&http.Request{URL: parsed}, []*http.Request{{}})
	}
	if err := redirect("https://release-assets.githubusercontent.com/asset?token=x"); err != nil {
		t.Errorf("GitHub's asset store must be followed: %v", err)
	}
	for _, target := range []string{
		"http://release-assets.githubusercontent.com/asset",
		"https://example.com/asset",
		"https://release-assets.githubusercontent.com.example.com/asset",
		"https://169.254.169.254/latest/meta-data",
	} {
		if err := redirect(target); err == nil {
			t.Errorf("redirect to %s must be refused", target)
		}
	}
}
