package migrations

import "embed"

// Files contains the schema migrations shipped with the application.
//
//go:embed *.sql
var Files embed.FS
