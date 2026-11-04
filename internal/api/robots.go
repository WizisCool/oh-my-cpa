package api

import (
	"net/http"
	"strconv"
)

// The console is an operator back office, and a reverse proxy routinely puts it on a public
// host. Nothing it serves is meant to be found, so every response tells crawlers to keep out.
//
// Two signals, because each covers what the other cannot. robots.txt is advisory and read only
// at an origin's root, so a console mounted under a base path behind a proxy that forwards only
// that path never gets asked for it. X-Robots-Tag rides every response, including JSON, assets
// and the SPA shell, so a URL that leaked into a crawler's queue is still not indexed even when
// robots.txt was never fetched. index.html repeats it as a meta tag for caches that drop headers.
const (
	robotsTagValue = "noindex, nofollow, noarchive, nosnippet, noimageindex"
	robotsTxt      = "User-agent: *\nDisallow: /\n"
)

func (h *Handler) robots(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-cache")
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	writer.Header().Set("Content-Length", strconv.Itoa(len(robotsTxt)))
	if request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write([]byte(robotsTxt))
}
