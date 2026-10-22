package api

import (
	"fmt"
	"io/fs"
	"net/http"
	"strconv"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/web"
)

// The installable-app surface: the web app manifest and the icons it names.
//
// They are served from the console root rather than through asset() for two reasons
// the manifest makes load-bearing:
//
//   - Content type. A manifest answered as octet-stream or, through the SPA fallback,
//     as index.html is not a manifest, and every browser reports it as invalid.
//   - Cache policy. asset() answers with a year-long immutable policy, which suits
//     Vite's content-hashed files. The manifest and icon names are fixed by the
//     manifest contract, so an immutable response would keep a year-old copy in a
//     browser and an installed app would never observe a manifest change. These
//     revalidate instead.
//
// Every URL inside the manifest is relative: start_url, scope and the icon sources
// resolve against the manifest's URL, so one committed file is correct at the site
// root, under /omc and under a nested base path. Omission of an `id` is part of that
// decision, not an oversight: a relative id resolves against start_url's *origin*, so
// "./" would give every mount point the same installed identity. The default identity
// is the resolved start_url, which already differs per mount. pwa_test.go pins both.
const (
	manifestFile = "manifest.webmanifest"
	iconDir      = "icons/"
)

// consoleRootFiles is the directory the installable-app routes read from.
//
// A checkout with no frontend build still constructs the handler and these routes answer
// 404 until the console is built, the same way web.IndexHTML falls back to its
// placeholder for a binary without one; only an invalid sub-path is impossible here,
// because "dist" is the compile-time constant the build writes into.
func consoleRootFiles() fs.FS {
	root, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		panic(fmt.Sprintf("embed the built console at dist: %v", err))
	}
	return root
}

func (h *Handler) manifest(writer http.ResponseWriter, request *http.Request) {
	h.serveConsoleFile(writer, request, manifestFile, "application/manifest+json")
}

func (h *Handler) appIcon(writer http.ResponseWriter, request *http.Request) {
	name := strings.TrimPrefix(request.URL.Path, h.cfg.BasePath)
	name = strings.TrimPrefix(name, "/")
	if !strings.HasPrefix(name, iconDir) || strings.Contains(name, "..") {
		h.notFound(writer, request)
		return
	}
	h.serveConsoleFile(writer, request, name, iconMediaType(name))
}

func (h *Handler) serveConsoleFile(writer http.ResponseWriter, request *http.Request, name, mediaType string) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		h.methodNotAllowed(writer, request)
		return
	}
	data, err := fs.ReadFile(h.consoleRoot, name)
	if err != nil {
		h.notFound(writer, request)
		return
	}
	writer.Header().Set("Cache-Control", "no-cache")
	writer.Header().Set("Content-Type", mediaType)
	writer.Header().Set("Content-Length", strconv.Itoa(len(data)))
	if request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write(data)
}

func iconMediaType(name string) string {
	switch {
	case strings.HasSuffix(name, ".png"):
		return "image/png"
	case strings.HasSuffix(name, ".svg"):
		return "image/svg+xml"
	default:
		return "application/octet-stream"
	}
}
