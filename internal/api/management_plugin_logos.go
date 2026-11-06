package api

import (
	"encoding/base64"
	"net/url"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// maxPluginLogoBytes bounds the inline artwork one plugin may add to a response. It is measured on
// the image, not its encoding; see inlineImageMediaType.
const maxPluginLogoBytes = 512 * 1024

var renderableLogoMediaTypes = map[string]bool{
	"image/svg+xml":            true,
	"image/png":                true,
	"image/jpeg":               true,
	"image/gif":                true,
	"image/webp":               true,
	"image/avif":               true,
	"image/x-icon":             true,
	"image/vnd.microsoft.icon": true,
}

/**
 * projectPluginLogo is the one artwork rule every surface that draws a plugin's mark applies.
 *
 * A plugin publishes its logo as an inline image or an absolute URL, and the browser loads it
 * directly: the console has no egress proxy of its own, so a deployment without an outbound route
 * still shows the publisher's artwork. The same rule therefore covers the installed list, the
 * catalog, and the identity a catalog entry fills for an installed plugin. A second rule for
 * catalog entries is what drew a wall of placeholders: browsing a registry is how an operator finds
 * a plugin, so hiding every publisher mark until the plugin was installed hid the very artwork the
 * cards exist to show.
 *
 * What stays refused is a source the browser cannot load as an image: relative paths (resolved
 * against the console's origin they request the wrong resource), credential-bearing URLs, and
 * anything that is neither HTTP(S) nor a bounded inline image. The public demo withholds external
 * artwork separately, because its dataset must not make a reader's browser contact a publisher.
 */
func projectPluginLogo(logo string) string {
	logo = strings.TrimSpace(logo)
	if inline := projectInlinePluginLogo(logo); inline != "" {
		return inline
	}
	if httpURLOrEmpty(logo) == "" {
		return ""
	}
	parsed, _ := url.Parse(logo)
	if parsed.Hostname() == "" || parsed.User != nil {
		return ""
	}
	return logo
}

// The public demo uses only self-contained plugin artwork.
func projectInlinePluginLogo(logo string) string {
	logo = strings.TrimSpace(logo)
	if _, ok := inlineImageMediaType(logo); !ok {
		return ""
	}
	return logo
}

// pluginLogoURL prefers the installed entry's artwork over registration metadata.
func pluginLogoURL(plugin management.PluginItem) string {
	candidate := strings.TrimSpace(plugin.Logo)
	if candidate == "" && plugin.Metadata != nil {
		candidate = strings.TrimSpace(plugin.Metadata.Logo)
	}
	return projectPluginLogo(candidate)
}

// inlineImageMediaType bounds the image payload, not its encoded representation.
func inlineImageMediaType(raw string) (string, bool) {
	rest, found := strings.CutPrefix(raw, "data:")
	if !found {
		return "", false
	}
	header, payload, found := strings.Cut(rest, ",")
	if !found || len(payload) == 0 {
		return "", false
	}
	isBase64 := strings.HasSuffix(strings.ToLower(strings.TrimSpace(header)), ";base64")
	if !isBase64 && len(payload) > maxPluginLogoBytes {
		return "", false
	}
	if isBase64 && base64DecodedLen(payload) > maxPluginLogoBytes {
		return "", false
	}
	mediaType := strings.ToLower(strings.TrimSpace(strings.SplitN(header, ";", 2)[0]))
	if !renderableLogoMediaTypes[mediaType] {
		return "", false
	}
	return mediaType, true
}

// DecodedLen rounds up to whole groups without subtracting padding.
func base64DecodedLen(payload string) int {
	padding := 0
	switch {
	case strings.HasSuffix(payload, "=="):
		padding = 2
	case strings.HasSuffix(payload, "="):
		padding = 1
	}
	return base64.StdEncoding.DecodedLen(len(payload)) - padding
}
