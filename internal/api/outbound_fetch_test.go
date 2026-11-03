package api

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"golang.org/x/net/dns/dnsmessage"
)

// useProviderDNS keeps provider hostname tests independent of the machine's DNS.
// These tests are serial because Go's default resolver is process-wide.
func useProviderDNS(t *testing.T, records map[string][]net.IP) {
	t.Helper()
	server, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	t.Cleanup(func() {
		_ = server.Close()
		<-done
	})
	go func() {
		defer close(done)
		buffer := make([]byte, 4096)
		for {
			count, peer, err := server.ReadFrom(buffer)
			if err != nil {
				if !errors.Is(err, net.ErrClosed) {
					t.Errorf("read DNS query: %v", err)
				}
				return
			}
			var query dnsmessage.Message
			if err := query.Unpack(buffer[:count]); err != nil {
				t.Errorf("decode DNS query: %v", err)
				return
			}
			answer := dnsmessage.Message{
				Header:    dnsmessage.Header{ID: query.ID, Response: true, Authoritative: true},
				Questions: query.Questions,
			}
			for _, question := range query.Questions {
				for _, address := range records[question.Name.String()] {
					header := dnsmessage.ResourceHeader{Name: question.Name, Type: question.Type, Class: dnsmessage.ClassINET}
					if ipv4 := address.To4(); question.Type == dnsmessage.TypeA && ipv4 != nil {
						answer.Answers = append(answer.Answers, dnsmessage.Resource{Header: header, Body: &dnsmessage.AResource{A: [4]byte(ipv4)}})
					} else if question.Type == dnsmessage.TypeAAAA && ipv4 == nil {
						answer.Answers = append(answer.Answers, dnsmessage.Resource{Header: header, Body: &dnsmessage.AAAAResource{AAAA: [16]byte(address.To16())}})
					}
				}
			}
			wire, err := answer.Pack()
			if err != nil {
				t.Errorf("encode DNS answer: %v", err)
				return
			}
			if _, err := server.WriteTo(wire, peer); err != nil && !errors.Is(err, net.ErrClosed) {
				t.Errorf("send DNS answer: %v", err)
				return
			}
		}
	}()
	previous := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, server.LocalAddr().String())
		},
	}
	t.Cleanup(func() { net.DefaultResolver = previous })
}

func TestProviderHTTPHostnamePinsValidatedAddresses(t *testing.T) {
	useProviderDNS(t, map[string][]net.IP{"ai-manager.": {net.ParseIP("127.0.0.1")}})
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/models" {
			http.Redirect(writer, request, "/v1/models", http.StatusFound)
			return
		}
		if !strings.HasPrefix(request.Host, "ai-manager:") || request.Header.Get("Authorization") != "Bearer sk-pinned-test" {
			http.Error(writer, "missing provider authority or authorization", http.StatusBadRequest)
			return
		}
		writer.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(upstream.Close)
	target, err := url.Parse(strings.Replace(upstream.URL, "127.0.0.1", "ai-manager", 1) + "/models")
	if err != nil {
		t.Fatal(err)
	}
	addresses, isAllowed := resolveProviderURLAddresses(context.Background(), target)
	if !isAllowed {
		t.Fatal("private hostname rejected")
	}
	// DNS no longer supplies the approved peer. Neither the first request nor
	// its same-origin redirect may resolve the name again.
	useProviderDNS(t, nil)
	transport := pinProviderHostname(&http.Transport{}, target, addresses)
	t.Cleanup(transport.CloseIdleConnections)
	client := &http.Client{Transport: transport, CheckRedirect: sameOriginRedirectGuard(errModelPullRedirectRefused, MAX_MODEL_PULL_REDIRECTS)}
	request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, target.String(), nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer sk-pinned-test")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		t.Fatalf("pinned request = %d, want 204", response.StatusCode)
	}
}

func TestProviderHTTPHostnameDialBudget(t *testing.T) {
	for _, testCase := range []struct {
		name          string
		timeout       time.Duration
		shouldConnect bool
	}{
		{name: "stalled first address", timeout: 15 * time.Second, shouldConnect: true},
		{name: "earlier caller deadline", timeout: time.Second},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				target, err := url.Parse("http://ai-manager:7864/v1")
				if err != nil {
					t.Fatal(err)
				}
				connection, peer := net.Pipe()
				defer connection.Close()
				defer peer.Close()
				var attempts []string
				transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
					if err := ctx.Err(); err != nil {
						return nil, err
					}
					if network != "tcp" {
						t.Fatalf("dial network = %q, want tcp", network)
					}
					attempts = append(attempts, address)
					if address == "[fd00::1]:7864" {
						<-ctx.Done()
						return nil, ctx.Err()
					}
					return connection, nil
				}}
				pinProviderHostname(transport, target, []net.IPAddr{
					{IP: net.ParseIP("fd00::1")},
					{IP: net.ParseIP("172.20.0.3")},
				})
				ctx, cancel := context.WithTimeout(t.Context(), testCase.timeout)
				defer cancel()
				connected, err := transport.DialContext(ctx, "tcp", target.Host)
				if !testCase.shouldConnect {
					if connected != nil || !errors.Is(err, context.DeadlineExceeded) {
						t.Fatalf("cancelled dial = %v, %v, want deadline exceeded", connected, err)
					}
					return
				}
				if err != nil || connected != connection {
					t.Fatalf("fallback dial = %v, %v, want the working connection", connected, err)
				}
				if !slices.Equal(attempts, []string{"[fd00::1]:7864", "172.20.0.3:7864"}) {
					t.Fatalf("dialed addresses = %v, want only the validated candidates", attempts)
				}
				if ctx.Err() != nil {
					t.Fatal("fallback exhausted the caller deadline")
				}
			})
		})
	}
}
