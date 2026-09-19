package api

import (
	"fmt"
	"net"
	"net/http"
	"strings"
)

/**
 * What this process may be told to fetch, and where it may go.
 *
 * Two callers fetch an address they did not construct, and they do not have the same
 * authority behind them:
 *
 *   - A model-list pull targets a base URL the operator typed for a provider they run.
 *     That operator is allowed to point it at their own LAN - a self-hosted relay is
 *     the normal case - so plaintext HTTP is permitted for localhost, loopback and
 *     private literals.
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
