package applog

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

func TestBufferSinceResumesAndReportsGaps(t *testing.T) {
	buffer := NewBuffer(3)
	if page := buffer.Since(0, 10); len(page.Records) != 0 || page.Gap || page.LatestSeq != 0 {
		t.Fatalf("empty buffer page = %#v", page)
	}
	for i := 0; i < 5; i++ {
		buffer.Append(Record{Message: string(rune('a' + i))})
	}

	first := buffer.Since(0, 10)
	if got := messages(first.Records); got != "cde" || first.Gap {
		t.Fatalf("first read = %q gap=%v, want the retained tail without a gap", got, first.Gap)
	}
	if first.OldestSeq != 3 || first.LatestSeq != 5 {
		t.Fatalf("bounds = %d..%d, want 3..5", first.OldestSeq, first.LatestSeq)
	}
	if page := buffer.Since(5, 10); len(page.Records) != 0 || page.Gap {
		t.Fatalf("caught-up read = %#v", page)
	}

	// A reader that last saw seq 1 lost seq 2 to eviction.
	if page := buffer.Since(1, 10); messages(page.Records) != "cde" || !page.Gap {
		t.Fatalf("evicted read = %q gap=%v, want cde with a gap", messages(page.Records), page.Gap)
	}
	// A limit keeps the newest records and says it skipped the rest.
	if page := buffer.Since(2, 2); messages(page.Records) != "de" || !page.Gap {
		t.Fatalf("limited read = %q gap=%v, want de with a gap", messages(page.Records), page.Gap)
	}
}

func TestHandlerTeesRedactedRecords(t *testing.T) {
	var stderr bytes.Buffer
	buffer := NewBuffer(10)
	logger := slog.New(NewHandler(slog.NewJSONHandler(&stderr, &slog.HandlerOptions{Level: slog.LevelInfo}), buffer))
	if BufferOf(logger) != buffer {
		t.Fatal("BufferOf did not find the tee buffer")
	}

	logger.Debug("hidden")
	logger.With("component", "ingest").WithGroup("cpa").Warn(
		"upstream failed Authorization: Bearer sk-live-abcdefghijklmnop",
		"api_key", "opaque-value",
		"error", errors.New("dial tcp: refused"),
		slog.Group("retry", "attempt", 3),
	)

	page := buffer.Since(0, 10)
	if len(page.Records) != 1 {
		t.Fatalf("records = %#v, want only the warning", page.Records)
	}
	record := page.Records[0]
	if record.Level != "warn" || strings.Contains(record.Message, "sk-live") {
		t.Fatalf("record = %#v, want a redacted warning", record)
	}
	got := map[string]string{}
	for _, attr := range record.Attrs {
		got[attr.Key] = attr.Value
	}
	want := map[string]string{
		"component":         "ingest",
		"cpa.api_key":       security.RedactedValue,
		"cpa.error":         "dial tcp: refused",
		"cpa.retry.attempt": "3",
	}
	for key, value := range want {
		if got[key] != value {
			t.Fatalf("attr %s = %q, want %q (all: %#v)", key, got[key], value, got)
		}
	}
	if strings.Contains(stderr.String(), "hidden") || !strings.Contains(stderr.String(), "upstream failed") {
		t.Fatalf("stderr = %q, want the same records the buffer kept", stderr.String())
	}
}

func messages(records []Record) string {
	var builder strings.Builder
	for _, record := range records {
		builder.WriteString(record.Message)
	}
	return builder.String()
}
