package web

import (
	"embed"
	"errors"
	"io/fs"
)

// Dist is the console `pnpm build` syncs into dist/. The build output is not
// committed: the directory is tracked only through its .gitkeep, which is why the
// pattern needs `all:` - without it a checkout that has not built the console has
// no embeddable file and the package does not compile.
//
//go:embed all:dist
var Dist embed.FS

// placeholderIndex stands in for the console's entry document in a binary built
// without the console, so the backend compiles, its tests run and the server
// answers with an explanation instead of an error. It is committed beside this
// file rather than in dist/, where a build would replace it and every frontend
// change would then have to commit the regenerated copy.
//
//go:embed placeholder.html
var placeholderIndex []byte

// IndexHTML returns the console's entry document from dist, or the placeholder
// when dist holds no build.
func IndexHTML(dist fs.FS) ([]byte, error) {
	data, err := fs.ReadFile(dist, "dist/index.html")
	if errors.Is(err, fs.ErrNotExist) {
		return placeholderIndex, nil
	}
	return data, err
}
