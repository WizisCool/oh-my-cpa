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
 *     it is private, link-local, multicast, unspecified or a cloud metadata endpoint.
 *     Checking the resolved address at dial time is what makes that a real boundary
 *     rather than a name check: a hostname that resolves into internal space is
 *     refused where the connection would actually be made.
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
// destination a plugin can use to reach anything new - and everything the operator's
// network holds is not.
func isResolvedAddressAllowed(address net.IP) bool {
	if address == nil {
		return false
	}
	if address.IsLoopback() {
		return true
	}
	return !(address.IsPrivate() ||
		address.IsLinkLocalUnicast() ||
		address.IsLinkLocalMulticast() ||
		address.IsInterfaceLocalMulticast() ||
		address.IsMulticast() ||
		address.IsUnspecified())
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
