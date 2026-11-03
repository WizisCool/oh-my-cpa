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

/**
 * What this process may be told to fetch, and where it may go.
 *
 * Two callers fetch an address they did not construct, and they do not have the same
 * authority behind them:
 *
 *   - Provider model-list pulls and probes target a base URL the operator typed.
 *     That operator is allowed to point it at their own LAN - a self-hosted relay is
 *     the normal case - so plaintext HTTP is permitted for localhost, loopback and
 *     private addresses, including hostnames whose resolved addresses are all loopback
 *     or private. Direct hostname connections are pinned to the checked addresses. A proxy
 *     would resolve the name elsewhere, so this HTTP-only exception requires a direct
 *     connection (or a literal private IP when a proxy is required).
 *   - A plugin logo URL is declared by an installed plugin's manifest, and the
 *     operator never typed it. A plugin is not trusted to choose what this process
 *     connects to: `isPluginLogoURLAllowed` allows public HTTPS, or HTTP only to the
 *     machine itself, and `pluginLogoDialControl` then refuses the resolved address if
 *     it is private, link-local, multicast, unspecified or a reserved block. Checking
 *     the resolved address at dial time is what makes that a real boundary rather than
 *     a name check: a hostname that resolves into internal space is refused where the
 *     connection would actually be made. That is also why the logo fetch does not use
 *     an environment proxy - through one, the dialer would see the proxy's address and
 *     the target would be unverifiable.
 *
 * The redirect rule underneath them is the same and is shared, because it answers a
 * question neither policy restates: may this fetch be moved somewhere else.
 */

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

// isLoopbackPlaintextHostAllowed allows HTTP only to the machine this process runs on,
// which is how a plugin served locally publishes its own artwork.
func isLoopbackPlaintextHostAllowed(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "localhost" {
		return true
	}
	address := hostAddressLiteral(host)
	return address != nil && address.IsLoopback()
}

// isResolvedAddressAllowed reports whether a connection may be made to an address that
// has already been resolved. Loopback is permitted - the machine itself is not a
// destination a plugin can use to reach anything new - and everything that is not
// public internet space is not: the operator's network, the ranges an ISP or an overlay
// network shares, and the addresses a cloud deployment answers on.
//
// `IsPrivate` alone is not that rule. It covers RFC 1918 and IPv6 unique-local space, and
// leaves out the blocks the IANA special-purpose registry reserves - carrier-grade NAT
// (`100.64.0.0/10`, which is also what an overlay network such as Tailscale hands out),
// benchmarking, IETF protocol assignments and the documentation ranges. A plugin manifest
// must not be able to reach any of them, and the list is deliberately wider than the
// strict minimum because the cost of a false refusal is one fallback to the bundled mark.
func isResolvedAddressAllowed(address net.IP) bool {
	if address == nil {
		return false
	}
	if address.IsLoopback() {
		return true
	}
	if address.IsPrivate() ||
		address.IsLinkLocalUnicast() ||
		address.IsLinkLocalMulticast() ||
		address.IsInterfaceLocalMulticast() ||
		address.IsMulticast() ||
		address.IsUnspecified() {
		return false
	}
	return !isSpecialPurposeAddress(address)
}

// specialPurposeRanges are the IPv4 blocks that are not public internet space and that
// `net.IP`'s own predicates do not cover.
var specialPurposeRanges = func() []*net.IPNet {
	const list = "100.64.0.0/10 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 240.0.0.0/4"
	ranges := make([]*net.IPNet, 0, 8)
	for _, value := range strings.Fields(list) {
		_, block, err := net.ParseCIDR(value)
		if err != nil {
			continue
		}
		ranges = append(ranges, block)
	}
	return ranges
}()

func isSpecialPurposeAddress(address net.IP) bool {
	for _, block := range specialPurposeRanges {
		if block.Contains(address) {
			return true
		}
	}
	return false
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
