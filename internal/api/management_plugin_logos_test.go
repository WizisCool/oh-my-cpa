package api

import (
	"context"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// roundTripFunc turns a function into a transport, so a test can answer a fetch
// without a server (and count whether it was asked at all).
type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func respondWith(status int, contentType, body string) *http.Response {
	header := http.Header{}
	if contentType != "" {
		header.Set("Content-Type", contentType)
	}
	return &http.Response{
		StatusCode: status,
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

// countingFetcher returns a fetcher whose transport answers every request with the
// given handler and counts how many requests were made.
func countingFetcher(t *testing.T, handler roundTripFunc) (*pluginLogoFetcher, *atomic.Int64) {
	t.Helper()
	var calls atomic.Int64
	fetcher := newPluginLogoFetcher()
	fetcher.client = &http.Client{
		Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			return handler(request)
		}),
		CheckRedirect: sameOriginRedirectGuard(errPluginLogoRedirectRefused, maxPluginLogoRedirects),
	}
	return fetcher, &calls
}

func pluginWithLogo(id, logo string) management.PluginItem {
	return management.PluginItem{
		ID:            id,
		Name:          id,
		Enabled:       true,
		SupportsOAuth: true,
		OAuthProvider: id,
		Logo:          logo,
		Metadata:      &management.PluginMetadata{Name: id, Logo: logo},
	}
}

func TestPluginLogoFetcherInlinesAnImageOnBothFields(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if accept := request.Header.Get("Accept"); !strings.Contains(accept, "image/") {
			t.Errorf("Accept = %q, want an image preference", accept)
		}
		writer.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
		_, _ = writer.Write([]byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`))
	}))
	defer server.Close()

	plugins := []management.PluginItem{pluginWithLogo("acme", server.URL+"/logo.svg")}
	newPluginLogoFetcher().inline(context.Background(), plugins)

	want := "data:image/svg+xml;base64," + base64.StdEncoding.EncodeToString([]byte(`<svg xmlns="http://www.w3.org/2000/svg"/>`))
	if plugins[0].Logo != want {
		t.Fatalf("logo = %q, want the inlined data URL", plugins[0].Logo)
	}
	// Both fields carry the resolved value, so a consumer reading either one cannot be
	// handed a URL the browser may not load.
	if plugins[0].Metadata == nil || plugins[0].Metadata.Logo != want {
		t.Fatalf("metadata logo = %#v, want the same inlined data URL", plugins[0].Metadata)
	}
}

func TestPluginLogoFetcherRefusesPublicPlaintextWithoutFetching(t *testing.T) {
	fetcher, calls := countingFetcher(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("a public plaintext logo URL must not be fetched at all")
		return nil, nil
	})

	plugins := []management.PluginItem{pluginWithLogo("acme", "http://example.com/logo.png")}
	fetcher.inline(context.Background(), plugins)

	if calls.Load() != 0 {
		t.Fatalf("fetch calls = %d, want 0", calls.Load())
	}
	if plugins[0].Logo != "" || plugins[0].Metadata.Logo != "" {
		t.Fatalf("logo = %q / %q, want both cleared so the console falls back", plugins[0].Logo, plugins[0].Metadata.Logo)
	}
}

func TestPluginLogoFetcherRefusesAResponseThatIsNotAnImage(t *testing.T) {
	fetcher, _ := countingFetcher(t, func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"text/html; charset=utf-8"}},
			Body:       http.NoBody,
		}, nil
	})

	plugins := []management.PluginItem{pluginWithLogo("acme", "https://cdn.example.test/logo.png")}
	fetcher.inline(context.Background(), plugins)
	if plugins[0].Logo != "" {
		t.Fatalf("logo = %q, want it cleared for a non-image response", plugins[0].Logo)
	}
}

func TestPluginLogoFetcherRefusesAnOversizedResponse(t *testing.T) {
	oversized := strings.Repeat("a", maxPluginLogoBytes+1)
	fetcher, _ := countingFetcher(t, func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"image/png"}},
			Body:       io.NopCloser(strings.NewReader(oversized)),
		}, nil
	})

	plugins := []management.PluginItem{pluginWithLogo("acme", "https://cdn.example.test/logo.png")}
	fetcher.inline(context.Background(), plugins)
	if plugins[0].Logo != "" {
		t.Fatalf("logo = %q, want it cleared above the size ceiling", plugins[0].Logo)
	}
}

func TestPluginLogoFetcherRefusesANonOKResponse(t *testing.T) {
	fetcher, _ := countingFetcher(t, func(*http.Request) (*http.Response, error) {
		resp := respondWith(http.StatusInternalServerError, "image/png", "")
		return resp, nil
	})

	plugins := []management.PluginItem{pluginWithLogo("acme", "https://cdn.example.test/logo.png")}
	fetcher.inline(context.Background(), plugins)
	if plugins[0].Logo != "" {
		t.Fatalf("logo = %q, want it cleared for a 500", plugins[0].Logo)
	}
}

func TestPluginLogoFetcherRefusesACrossOriginRedirect(t *testing.T) {
	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		t.Error("the cross-origin target must not be reached")
	}))
	defer target.Close()

	origin := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, target.URL+"/logo.png", http.StatusFound)
	}))
	defer origin.Close()

	plugins := []management.PluginItem{pluginWithLogo("acme", origin.URL+"/logo.png")}
	newPluginLogoFetcher().inline(context.Background(), plugins)
	if plugins[0].Logo != "" {
		t.Fatalf("logo = %q, want it cleared rather than followed off-origin", plugins[0].Logo)
	}
}

func TestPluginLogoFetcherFollowsASameOriginRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/logo.png" {
			http.Redirect(writer, request, "/real/logo.png", http.StatusFound)
			return
		}
		writer.Header().Set("Content-Type", "image/png")
		_, _ = writer.Write([]byte("png-bytes"))
	}))
	defer server.Close()

	plugins := []management.PluginItem{pluginWithLogo("acme", server.URL+"/logo.png")}
	newPluginLogoFetcher().inline(context.Background(), plugins)
	if !strings.HasPrefix(plugins[0].Logo, "data:image/png;base64,") {
		t.Fatalf("logo = %q, want the redirected image inlined", plugins[0].Logo)
	}
}

func TestPluginLogoFetcherCachesSuccessAndFailure(t *testing.T) {
	var calls atomic.Int64
	fetcher, _ := countingFetcher(t, func(request *http.Request) (*http.Response, error) {
		calls.Add(1)
		if strings.Contains(request.URL.Path, "broken") {
			return respondWith(http.StatusNotFound, "text/plain", ""), nil
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"image/png"}},
			Body:       io.NopCloser(strings.NewReader("png-bytes")),
		}, nil
	})

	// Each poll rebuilds its own slice: `inline` rewrites the plugins it is given, so
	// reusing the first call's slice would short-circuit on the already-inlined value and
	// pass without ever consulting the cache.
	newRound := func() []management.PluginItem {
		return []management.PluginItem{
			pluginWithLogo("acme", "https://cdn.example.test/logo.png"),
			pluginWithLogo("broken", "https://cdn.example.test/broken.png"),
		}
	}
	plugins := newRound()
	fetcher.inline(context.Background(), plugins)
	firstHits := calls.Load()

	second := newRound()
	fetcher.inline(context.Background(), second)
	if calls.Load() != firstHits {
		t.Fatalf("fetch calls grew on a second poll (%d -> %d): the cache must hold the answer", firstHits, calls.Load())
	}
	plugins = second
	if !strings.HasPrefix(plugins[0].Logo, "data:image/png;base64,") {
		t.Fatalf("cached logo = %q, want the inlined image", plugins[0].Logo)
	}
	if plugins[1].Logo != "" {
		t.Fatalf("broken logo = %q, want it cached as absent", plugins[1].Logo)
	}
}

func TestPluginLogoFetcherRefetchesOnceTheEntryExpires(t *testing.T) {
	var calls atomic.Int64
	fetcher, _ := countingFetcher(t, func(*http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"image/png"}},
			Body:       io.NopCloser(strings.NewReader("png-bytes")),
		}, nil
	})

	now := time.Now()
	fetcher.now = func() time.Time { return now }

	// Each round is built from the original URL: `inline` rewrites the plugin it is
	// given, and an already-inlined logo is renderable, so a second call on the same
	// value is a no-op by design rather than a cache hit.
	logoURL := "https://cdn.example.test/logo.png"
	fetcher.inline(context.Background(), []management.PluginItem{pluginWithLogo("acme", logoURL)})
	if calls.Load() != 1 {
		t.Fatalf("fetch calls = %d, want 1", calls.Load())
	}

	now = now.Add(pluginLogoCachingTTL + time.Minute)
	fetcher.inline(context.Background(), []management.PluginItem{pluginWithLogo("acme", logoURL)})
	if calls.Load() != 2 {
		t.Fatalf("fetch calls = %d after the TTL, want a refetch", calls.Load())
	}
}

func TestPluginLogoFetcherDeduplicatesOneURLAcrossPlugins(t *testing.T) {
	fetcher, calls := countingFetcher(t, func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"image/png"}},
			Body:       io.NopCloser(strings.NewReader("png-bytes")),
		}, nil
	})

	shared := "https://cdn.example.test/shared.svg"
	plugins := []management.PluginItem{pluginWithLogo("acme", shared), pluginWithLogo("other", shared)}
	fetcher.inline(context.Background(), plugins)

	if calls.Load() != 1 {
		t.Fatalf("fetch calls = %d, want one fetch for one URL", calls.Load())
	}
	if plugins[0].Logo == "" || plugins[0].Logo != plugins[1].Logo {
		t.Fatalf("logos = %q / %q, want the same inlined value", plugins[0].Logo, plugins[1].Logo)
	}
}

func TestPluginLogoFetcherLeavesInlineArtworkAlone(t *testing.T) {
	fetcher, calls := countingFetcher(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("inline artwork must not be fetched")
		return nil, nil
	})

	inline := "data:image/svg+xml,%3Csvg/%3E"
	rejected := "data:text/html,%3Cscript/%3E"
	plugins := []management.PluginItem{pluginWithLogo("acme", inline), pluginWithLogo("other", rejected)}
	fetcher.inline(context.Background(), plugins)

	if calls.Load() != 0 {
		t.Fatalf("fetch calls = %d, want 0", calls.Load())
	}
	if plugins[0].Logo != inline {
		t.Fatalf("inline logo = %q, want it passed through", plugins[0].Logo)
	}
	if plugins[1].Logo != "" {
		t.Fatalf("non-image data URL = %q, want it cleared", plugins[1].Logo)
	}
}

func TestPluginLogoFetcherSkipsAPluginWithNoLogo(t *testing.T) {
	fetcher, calls := countingFetcher(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("a plugin without a logo must not start a fetch")
		return nil, nil
	})
	plugin := management.PluginItem{ID: "plain", Name: "plain", Enabled: true}
	plugins := []management.PluginItem{plugin}
	fetcher.inline(context.Background(), plugins)
	if calls.Load() != 0 || plugins[0].Logo != "" {
		t.Fatalf("calls=%d logo=%q, want no fetch and no logo", calls.Load(), plugins[0].Logo)
	}
}

func TestPluginLogoFetcherKeepsTheEntryCountBounded(t *testing.T) {
	fetcher, _ := countingFetcher(t, func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"image/png"}},
			Body:       io.NopCloser(strings.NewReader("png-bytes")),
		}, nil
	})

	// One distinct URL per round: repeating a handful of URLs would never cross the cap
	// this test exists to check.
	for index := 0; index < maxPluginLogoCacheEntries+10; index++ {
		logoURL := "https://cdn.example.test/" + strconv.Itoa(index) + ".png"
		plugins := []management.PluginItem{pluginWithLogo("acme", logoURL)}
		fetcher.inline(context.Background(), plugins)
		if plugins[0].Logo == "" {
			t.Fatalf("round %d lost its logo", index)
		}
		if len(fetcher.entries) > maxPluginLogoCacheEntries {
			t.Fatalf("cache holds %d entries, want at most %d", len(fetcher.entries), maxPluginLogoCacheEntries)
		}
	}
}

func TestSameOriginRedirectGuardToleratesAnEmptyChain(t *testing.T) {
	// `http.Client` always fills `via`, but the guard indexes it: a nil chain must be a
	// pass-through rather than a panic.
	guard := sameOriginRedirectGuard(errPluginLogoRedirectRefused, 2)
	request, err := http.NewRequest(http.MethodGet, "https://cdn.example.test/logo.png", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := guard(request, nil); err != nil {
		t.Fatalf("guard(nil via) = %v, want nil", err)
	}
}

func TestPluginLogoFetcherIsConcurrencySafe(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "image/png")
		_, _ = writer.Write([]byte("png-bytes"))
	}))
	defer server.Close()

	fetcher := newPluginLogoFetcher()
	var waitGroup sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			plugins := []management.PluginItem{pluginWithLogo("acme", server.URL+"/logo.png")}
			fetcher.inline(context.Background(), plugins)
			if plugins[0].Logo == "" {
				t.Error("concurrent inline lost the logo")
			}
		}()
	}
	waitGroup.Wait()
}

func TestPluginLogoURLPolicyHoldsAPluginToPublicDestinations(t *testing.T) {
	allowed := []string{
		"https://cdn.example.test/logo.svg",
		"https://203.0.113.7/logo.svg",
		"http://127.0.0.1:8317/logo.svg",
		"http://localhost:8317/logo.svg",
		"http://[::1]:8317/logo.svg",
	}
	for _, raw := range allowed {
		parsed, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if !isPluginLogoURLAllowed(parsed) {
			t.Errorf("isPluginLogoURLAllowed(%q) = false, want true", raw)
		}
	}

	refused := []string{
		// The operator's own network is not somewhere a plugin manifest may send this
		// process, including the metadata endpoints every cloud deployment has.
		"https://169.254.169.254/latest/meta-data",
		"https://10.20.30.40/logo.svg",
		"https://192.168.1.5/logo.svg",
		"https://[fd00::1]/logo.svg",
		"http://example.com/logo.svg",
		"http://192.168.1.5/logo.svg",
		"ftp://cdn.example.test/logo.svg",
		"javascript:alert(1)",
	}
	for _, raw := range refused {
		parsed, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if isPluginLogoURLAllowed(parsed) {
			t.Errorf("isPluginLogoURLAllowed(%q) = true, want false", raw)
		}
	}
}

func TestPluginLogoAddressPolicyRefusesInternalResolutions(t *testing.T) {
	for _, raw := range []string{"127.0.0.1", "::1"} {
		if !isResolvedAddressAllowed(net.ParseIP(raw)) {
			t.Errorf("isResolvedAddressAllowed(%s) = false; the machine itself is reachable", raw)
		}
	}
	for _, raw := range []string{"203.0.113.7", "2606:4700::1111"} {
		if !isResolvedAddressAllowed(net.ParseIP(raw)) {
			t.Errorf("isResolvedAddressAllowed(%s) = false, want true", raw)
		}
	}
	for _, raw := range []string{"10.0.0.1", "192.168.0.1", "172.16.5.4", "169.254.169.254", "fd00::1", "fe80::1", "224.0.0.1", "0.0.0.0"} {
		if isResolvedAddressAllowed(net.ParseIP(raw)) {
			t.Errorf("isResolvedAddressAllowed(%s) = true, want false", raw)
		}
	}
	if isResolvedAddressAllowed(nil) {
		t.Error("isResolvedAddressAllowed(nil) = true, want false")
	}
}

func TestPluginLogoFetcherRefusesAnOversizedInlineLogo(t *testing.T) {
	fetcher, calls := countingFetcher(t, func(*http.Request) (*http.Response, error) {
		t.Fatal("inline artwork must not be fetched")
		return nil, nil
	})

	oversized := "data:image/png;base64," + strings.Repeat("A", maxPluginLogoBytes+1)
	plugins := []management.PluginItem{pluginWithLogo("acme", oversized)}
	fetcher.inline(context.Background(), plugins)

	if calls.Load() != 0 {
		t.Fatalf("fetch calls = %d, want 0", calls.Load())
	}
	// The ceiling has to hold for both routes: a plugin that publishes the artwork
	// inline must not be able to ship something larger than a fetched one.
	if plugins[0].Logo != "" {
		t.Fatalf("logo = %d bytes, want it cleared above the ceiling", len(plugins[0].Logo))
	}
}

func TestPluginLogoFetcherDoesNotCacheAnExhaustedBudget(t *testing.T) {
	var calls atomic.Int64
	fetcher, _ := countingFetcher(t, func(request *http.Request) (*http.Response, error) {
		calls.Add(1)
		<-request.Context().Done()
		return nil, request.Context().Err()
	})

	// A budget that ran out is not an answer about the logo: caching it would cost the
	// plugin its mark for the whole TTL because one poll was slow.
	expired, cancel := context.WithCancel(context.Background())
	cancel()
	plugins := []management.PluginItem{pluginWithLogo("acme", "https://cdn.example.test/logo.png")}
	fetcher.inline(expired, plugins)
	if plugins[0].Logo != "" {
		t.Fatalf("logo = %q, want it absent when the budget ran out", plugins[0].Logo)
	}
	if len(fetcher.entries) != 0 {
		t.Fatalf("cache holds %d entries, want none for an exhausted budget", len(fetcher.entries))
	}
	if calls.Load() == 0 {
		t.Fatal("the fetch was never attempted")
	}
}
