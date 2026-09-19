package api

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
)

/**
 * The outbound-fetch policy the console applies to every URL it did not construct
 * itself: the operator's provider base URL for a model pull, and a plugin's
 * declared logo.
 *
 * It is one policy rather than one per caller because the question is the same -
 * may this process be made to fetch that address - and two copies of an SSRF rule
 * drift, with the copy nobody re-reads becoming the hole. Two properties matter:
 * the operator's credentials must not travel over a public plaintext link, and a
 * fetch must not become a way to reach an address the deployment cannot otherwise
 * be told to visit.
 */

// isOutboundFetchURLAllowed keeps a fetch off public plaintext links while still
// allowing self-hosted relays reached over loopback or private addresses.
func isOutboundFetchURLAllowed(parsed *url.URL) bool {
	if parsed == nil {
		return false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https":
		return true
	case "http":
		return isPlaintextOutboundHostAllowed(parsed.Hostname())
	default:
		return false
	}
}

func isPlaintextOutboundHostAllowed(host string) bool {
	host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(host)), ".")
	if host == "localhost" {
		return true
	}
	if zoneIndex := strings.IndexByte(host, '%'); zoneIndex >= 0 {
		host = host[:zoneIndex]
	}
	address := net.ParseIP(host)
	if address == nil {
		return false
	}
	return address.IsLoopback() || address.IsPrivate()
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
