// Package testkit is the golden-file runner the Go suites share.
//
// A parser or projection is tested by its whole output, not by a list of field
// assertions: an input file under testdata/golden/ goes in, and the encoded result must
// equal the golden file beside it. Adding a case is adding a file, and accepting an
// intended change is regenerating the golden files and reviewing their diff:
//
//	UPDATE_GOLDEN=1 go test ./internal/quota
//
// An environment variable rather than a flag, so the same command works across
// `./...`, where packages that do not import this one would refuse an unknown flag.
package testkit

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Case is one input file: why it exists, the instant it is evaluated at, and the body
// handed to the code under test.
type Case struct {
	Name  string          `json:"-"`
	Why   string          `json:"why"`
	NowMS int64           `json:"now_ms"`
	Body  json.RawMessage `json:"body"`
}

// PinUTC evaluates the rest of the test in UTC, through both TZ and time.Local, so
// a golden file records the same instants and labels on every machine. Tests that
// call it must not run in parallel.
func PinUTC(t testing.TB) {
	t.Helper()
	t.Setenv("TZ", "UTC")
	previous := time.Local
	time.Local = time.UTC
	t.Cleanup(func() { time.Local = previous })
}

func isUpdating() bool { return os.Getenv("UPDATE_GOLDEN") != "" }

// Golden requires got, encoded as indented JSON, to equal the file at path.
func Golden(t testing.TB, path string, got any) {
	t.Helper()
	encoded, err := json.MarshalIndent(got, "", "  ")
	if err != nil {
		t.Fatalf("encode golden output: %v", err)
	}
	encoded = append(encoded, '\n')
	if isUpdating() {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("create %s: %v", filepath.Dir(path), err)
		}
		if err := os.WriteFile(path, encoded, 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v (UPDATE_GOLDEN=1 creates it)", path, err)
	}
	if !bytes.Equal(want, encoded) {
		t.Errorf("%s differs from the current output (UPDATE_GOLDEN=1 accepts it):\n%s", path, firstDifference(want, encoded))
	}
}

// Cases runs run for every <dir>/*.input.json and compares what it returns with the
// .golden.json file of the same name.
func Cases(t *testing.T, dir string, run func(t *testing.T, input Case) any) {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, "*.input.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no golden cases under %s", dir)
	}
	for _, file := range files {
		name := strings.TrimSuffix(filepath.Base(file), ".input.json")
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile(file)
			if err != nil {
				t.Fatalf("read %s: %v", file, err)
			}
			input := Case{Name: name}
			if err := json.Unmarshal(raw, &input); err != nil {
				t.Fatalf("decode %s: %v", file, err)
			}
			Golden(t, strings.TrimSuffix(file, ".input.json")+".golden.json", run(t, input))
		})
	}
}

// firstDifference shows the first line the two renderings disagree on, which is
// where a reviewer starts reading the diff.
func firstDifference(want, got []byte) string {
	wantLines := strings.Split(string(want), "\n")
	gotLines := strings.Split(string(got), "\n")
	for index := 0; index < len(wantLines) || index < len(gotLines); index++ {
		var wantLine, gotLine string
		if index < len(wantLines) {
			wantLine = wantLines[index]
		}
		if index < len(gotLines) {
			gotLine = gotLines[index]
		}
		if wantLine != gotLine {
			return "line " + strconv.Itoa(index+1) + "\n  want: " + wantLine + "\n  got:  " + gotLine
		}
	}
	return "(byte-level difference)"
}
