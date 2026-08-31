package web

import "embed"

// Dist is replaced by the frontend build before release. The placeholder is
// intentionally valid so backend tests can run before a frontend build.
//
//go:embed dist
var Dist embed.FS
