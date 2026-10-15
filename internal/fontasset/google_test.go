package fontasset

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestGoogleInstallerHostBoundary(t *testing.T) {
	for _, test := range []struct {
		name      string
		base      string
		target    string
		isAllowed bool
	}{
		{"same host", "https://mirror.example.com", "https://mirror.example.com/font.woff2", true},
		{"same site sibling", "https://mirror.example.com", "https://cdn.example.com/font.woff2", true},
		{"same country site", "https://mirror.example.co.uk", "https://cdn.example.co.uk/font.woff2", true},
		{"different country site", "https://mirror.example.co.uk", "https://attacker.co.uk/font.woff2", false},
		{"different Australian site", "https://mirror.example.com.au", "https://attacker.com.au/font.woff2", false},
		{"same private tenant", "https://mirror.operator.github.io", "https://cdn.operator.github.io/font.woff2", true},
		{"different private tenant", "https://operator.github.io", "https://attacker.github.io/font.woff2", false},
		{"suffix lookalike", "https://mirror.example.com", "https://example.com.attacker.net/font.woff2", false},
		{"case insensitive", "https://MIRROR.Example.CO.UK", "https://CDN.EXAMPLE.CO.UK/font.woff2", true},
		{"exact IPv4", "https://192.0.2.1", "https://192.0.2.1/font.woff2", true},
		{"different IPv4", "https://192.0.2.1", "https://198.51.2.1/font.woff2", false},
		{"exact IPv6", "https://[2001:db8::1]", "https://[2001:db8::1]/font.woff2", true},
		{"different IPv6", "https://[2001:db8::1]", "https://[2001:db8::2]/font.woff2", false},
		{"exact localhost", "https://localhost", "https://localhost/font.woff2", true},
		{"localhost subdomain", "https://localhost", "https://fonts.localhost/font.woff2", false},
		{"exact internal host", "https://mirror.internal", "https://mirror.internal/font.woff2", true},
		{"internal subdomain", "https://mirror.internal", "https://fonts.mirror.internal/font.woff2", false},
		{"local sibling", "https://mirror.operator.local", "https://cdn.operator.local/font.woff2", false},
		{"same HTTP origin", "http://localhost:8080", "http://localhost:8080/font.woff2", true},
		{"HTTP port change", "http://localhost:8080", "http://localhost:8081/font.woff2", false},
		{"HTTPS downgrade", "https://mirror.example.com", "http://mirror.example.com/font.woff2", false},
		{"URL credentials", "https://mirror.example.com", "https://user:pass@mirror.example.com/font.woff2", false},
		{"Google static", "https://mirror.example.co.uk", "https://fonts.gstatic.com/font.woff2", true},
		{"Google China static", "https://mirror.example.co.uk", "https://fonts.gstatic.cn/font.woff2", true},
		{"Google stylesheet", "https://mirror.example.co.uk", "https://fonts.googleapis.com/css2", true},
		{"Google China stylesheet", "https://mirror.example.co.uk", "https://fonts.googleapis.cn/css2", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			installer, err := NewGoogleInstaller(test.base, nil)
			if err != nil {
				t.Fatal(err)
			}
			target, err := url.Parse(test.target)
			if err != nil {
				t.Fatal(err)
			}
			if got := installer.isAllowedHost(target); got != test.isAllowed {
				t.Fatalf("isAllowedHost(%s) with mirror %s = %v, want %v", test.target, test.base, got, test.isAllowed)
			}
		})
	}
}

type fontTransport func(*http.Request) (*http.Response, error)

func (transport fontTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestGoogleInstallRejectsCrossSiteDownloadsAndRedirects(t *testing.T) {
	for _, mode := range []string{"font URL", "stylesheet redirect", "font redirect"} {
		t.Run(mode, func(t *testing.T) {
			const mirror = "https://mirror.example.co.uk"
			const forbidden = "https://attacker.co.uk/font.woff2"
			var requests []string
			transport := fontTransport(func(request *http.Request) (*http.Response, error) {
				requests = append(requests, request.URL.String())
				response := &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Request: request}
				body := "wOF2font-content"
				if request.URL.Path == "/css2" {
					target := mirror + "/font.woff2"
					if mode == "font URL" {
						target = forbidden
					}
					body = fmt.Sprintf("@font-face{font-family:'X';font-weight:400;src:url(%s);}", target)
				}
				if mode == "stylesheet redirect" || mode == "font redirect" && request.URL.Path == "/font.woff2" {
					response.StatusCode = http.StatusFound
					response.Header.Set("Location", forbidden)
				}
				response.Body = io.NopCloser(strings.NewReader(body))
				return response, nil
			})
			installer, err := NewGoogleInstaller(mirror, transport)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := installer.Install(context.Background(), "X"); !errors.Is(err, ErrGoogleUnreachable) {
				t.Errorf("cross-site %s returned %v, want %v", mode, err, ErrGoogleUnreachable)
			}
			for _, request := range requests {
				if strings.HasPrefix(request, "https://attacker.co.uk/") {
					t.Errorf("cross-site %s reached the transport: %s", mode, request)
				}
			}
		})
	}
}
