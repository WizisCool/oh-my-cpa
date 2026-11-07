// Package pluginregistry names the plugin registry Oh My CPA uses for CPA's
// plugin store.
//
// The registry document lives in the omc-community/omc-plugins repository (`registry.json`)
// and is served from its `main` branch, so the address is a compile-time fact rather
// than an operator setting: every installation has the source, and the console is
// what switches it off when the operator asks.
package pluginregistry

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

const (
	// OMCSourceURL is where CPA reads Oh My CPA's plugin registry.
	OMCSourceURL = "https://raw.githubusercontent.com/omc-community/omc-plugins/main/registry.json"
	// OMCSourceName is what the console calls the registry. CPA derives a source's
	// name from the URL's host, which for a raw GitHub address says nothing about
	// who publishes it.
	OMCSourceName = "Oh My CPA"
)

// SourceID is the id CPA assigns a configured registry: `source-` followed by the
// first 12 hex characters of the URL's SHA-256. Mirrored here because a fixture or a
// test that names the source by id has to name the one the gateway computes.
func SourceID(registryURL string) string {
	sum := sha256.Sum256([]byte(strings.TrimSpace(registryURL)))
	return "source-" + hex.EncodeToString(sum[:])[:12]
}
