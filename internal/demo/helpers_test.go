package demo

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// The helpers below exist so a test states what it is asking the fixture and what it
// expects back, rather than repeating the request plumbing that gets in the way of
// reading the assertion.

func startTestUpstream(t *testing.T) *Upstream {
	t.Helper()
	upstream, err := StartUpstream(nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = upstream.Close() })
	if !strings.HasPrefix(upstream.BaseURL(), "http://127.0.0.1:") {
		t.Fatalf("fixture bound %q, want a loopback address", upstream.BaseURL())
	}
	return upstream
}

// fixtureTransport attaches the fixture's key to the fixture's own address and to
// nothing else. A call written in a test therefore reads as the call the console
// makes, and a mistake in the address cannot leak the key to another host.
type fixtureTransport struct {
	base  string
	key   string
	inner *http.Transport
}

func (t *fixtureTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	if strings.HasPrefix(request.URL.String(), t.base) {
		request.Header.Set("Authorization", "Bearer "+t.key)
	}
	return t.inner.RoundTrip(request)
}

// upstreamClient talks to one fixture over a connection pool of its own, with
// keep-alives off.
//
// Both details are deliberate. Every fixture prefers the port a gateway normally uses,
// so consecutive tests in this package listen on the same address; a pooled connection
// surviving into the next test is handed to a server that has already shut down, and the
// call fails with an `EOF` that has nothing to do with what the test asserts. Sharing
// `http.DefaultTransport` did exactly that, on CI, while passing on the machine it was
// written on.
func upstreamClient(upstream *Upstream) *http.Client {
	inner := http.DefaultTransport.(*http.Transport).Clone()
	inner.DisableKeepAlives = true
	// The fixture is on loopback; a proxy from the environment must not be asked to
	// reach it.
	inner.Proxy = nil
	return &http.Client{Transport: &fixtureTransport{base: upstream.BaseURL(), key: upstream.ManagementKey(), inner: inner}}
}

func postJSON(t *testing.T, client *http.Client, url string, payload any) *http.Response {
	t.Helper()
	return sendJSON(t, client, http.MethodPost, url, payload)
}

func patchJSON(t *testing.T, client *http.Client, url string, payload any) *http.Response {
	t.Helper()
	return sendJSON(t, client, http.MethodPatch, url, payload)
}

func sendJSON(t *testing.T, client *http.Client, method, url string, payload any) *http.Response {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(method, url, bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func getWithClient(t *testing.T, client *http.Client, url string) *http.Response {
	t.Helper()
	response, err := client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func readJSONBody(t *testing.T, response *http.Response, wantStatus int) string {
	t.Helper()
	body := readBody(t, response)
	if response.StatusCode != wantStatus {
		t.Fatalf("status = %d (%s), want %d", response.StatusCode, body, wantStatus)
	}
	return body
}

func readBody(t *testing.T, response *http.Response) string {
	t.Helper()
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(data))
}
