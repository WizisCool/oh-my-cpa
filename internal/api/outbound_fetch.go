package api

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Provider model-list pulls and probes target an operator-entered URL. HTTP is
// allowed on the operator's private network; hostname connections are checked and
// pinned before credentials are sent. Redirects remain within the original origin.

// hostAddressLiteral returns the IP a host string names literally, if it names one.
func hostAddressLiteral(host string) net.IP {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if zoneIndex := strings.IndexByte(host, '%'); zoneIndex >= 0 {
		host = host[:zoneIndex]
	}
	return net.ParseIP(host)
}

// isPlaintextOutboundHostAllowed allows HTTP to the operator's own network. It is the
// model-pull half: a relay the operator runs may live on a LAN address.
func isPlaintextOutboundHostAllowed(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "localhost" {
		return true
	}
	address := hostAddressLiteral(host)
	if address == nil {
		return false
	}
	return address.IsLoopback() || address.IsPrivate()
}

// resolveProviderURLAddresses keeps provider credentials off public plaintext links.
// Only DNS names need pinning; localhost and allowed literals retain their policy.
func resolveProviderURLAddresses(ctx context.Context, target *url.URL) ([]net.IPAddr, bool) {
	if target == nil || target.Hostname() == "" {
		return nil, false
	}
	switch strings.ToLower(target.Scheme) {
	case "https":
		return nil, true
	case "http":
		if isPlaintextOutboundHostAllowed(target.Hostname()) {
			return nil, true
		}
		if hostAddressLiteral(target.Hostname()) != nil {
			return nil, false
		}
		addresses, err := net.DefaultResolver.LookupIPAddr(ctx, target.Hostname())
		if err != nil || len(addresses) == 0 {
			return nil, false
		}
		for _, address := range addresses {
			if !address.IP.IsLoopback() && !address.IP.IsPrivate() {
				return nil, false
			}
		}
		return addresses, true
	default:
		return nil, false
	}
}

// pinProviderHostname prevents another DNS lookup from changing an HTTP target
// after validation, without changing the Host header or redirect origin.
func pinProviderHostname(transport *http.Transport, target *url.URL, addresses []net.IPAddr) *http.Transport {
	if len(addresses) == 0 {
		return transport
	}
	if proxy := transport.Proxy; proxy != nil {
		transport.Proxy = func(request *http.Request) (*url.URL, error) {
			selected, err := proxy(request)
			if err != nil {
				return nil, err
			}
			if selected != nil {
				// Proxy-side DNS cannot be pinned by this process. Never bypass an
				// operator's proxy silently or send credentials to an unchecked peer.
				return nil, errors.New("HTTP provider hostnames require a direct connection; add the hostname to NO_PROXY or use a private IP address")
			}
			return nil, nil
		}
	}
	dialContext := transport.DialContext
	if dialContext == nil {
		dialContext = (&net.Dialer{}).DialContext
	}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if !strings.EqualFold(host, target.Hostname()) {
			return nil, errors.New("provider connection left its configured host")
		}
		var failures []error
		for _, candidate := range addresses {
			// A stalled address must leave time for other validated candidates.
			attemptCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			connection, err := dialContext(attemptCtx, network, net.JoinHostPort(candidate.String(), port))
			cancel()
			if err == nil {
				return connection, nil
			}
			failures = append(failures, err)
		}
		return nil, errors.Join(failures...)
	}
	return transport
}

// sameOriginRedirectGuard refuses a redirect that leaves the origin, instead of
// trying to scrub known credential headers from it: a fetcher's headers can carry
// secrets too, and a scheme change could downgrade any credential that survived.
func sameOriginRedirectGuard(refusal error, maxRedirects int) func(*http.Request, []*http.Request) error {
	return func(redirectedRequest *http.Request, via []*http.Request) error {
		if len(via) >= maxRedirects {
			return fmt.Errorf("%w: stopped after %d redirects", refusal, maxRedirects)
		}
		if len(via) == 0 {
			return nil
		}
		origin := via[0].URL
		if !strings.EqualFold(redirectedRequest.URL.Scheme, origin.Scheme) ||
			!strings.EqualFold(redirectedRequest.URL.Host, origin.Host) {
			return fmt.Errorf("%w: cross-origin redirect", refusal)
		}
		return nil
	}
}
