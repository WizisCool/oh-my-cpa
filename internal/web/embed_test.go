package web

import (
	"bytes"
	"testing"
	"testing/fstest"
)

func TestIndexHTMLServesTheBuildWhenThereIsOne(t *testing.T) {
	built := []byte("<!doctype html><html><head></head><body>built</body></html>")
	dist := fstest.MapFS{"dist/index.html": {Data: built}, "dist/.gitkeep": {}}
	got, err := IndexHTML(dist)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, built) {
		t.Fatalf("IndexHTML = %q, want the built document", got)
	}
}

// A checkout that has not built the console still has to compile, pass its tests
// and answer with a page, so the missing build falls back rather than failing.
func TestIndexHTMLFallsBackToThePlaceholderWithoutABuild(t *testing.T) {
	got, err := IndexHTML(fstest.MapFS{"dist/.gitkeep": {}})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, placeholderIndex) {
		t.Fatalf("IndexHTML = %q, want the placeholder", got)
	}
	// The server injects its runtime configuration into <head>; a placeholder without
	// one would be served without the configuration the console expects.
	if !bytes.Contains(got, []byte("<head>")) || !bytes.Contains(got, []byte("window.__OMCPA_CONFIG__")) {
		t.Fatalf("placeholder has no <head> or configuration slot: %q", got)
	}
}
