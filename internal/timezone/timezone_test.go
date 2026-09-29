package timezone

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
	"time"
)

func TestDeploymentAndOverride(t *testing.T) {
	t.Setenv("TZ", "Asia/Kathmandu")
	settings := New(ServerLocation())
	if settings.Location().String() != "Asia/Kathmandu" {
		t.Fatal(settings.Location())
	}
	if err := settings.Set("America/New_York"); err != nil {
		t.Fatal(err)
	}
	instant := time.Date(2026, 1, 1, 18, 45, 0, 0, time.UTC)
	if got := instant.In(settings.Location()).Format(time.RFC3339); got != "2026-01-01T13:45:00-05:00" {
		t.Fatal(got)
	}
	for _, name := range []string{"Local", "/etc/localtime", "../UTC", "Invalid/Zone"} {
		if err := settings.Set(name); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	if settings.Location().String() != "America/New_York" {
		t.Fatal("invalid zone replaced current zone")
	}
	if err := settings.Set(""); err != nil || settings.Location().String() != "Asia/Kathmandu" {
		t.Fatal("reset did not restore deployment zone", err)
	}
}
func TestLoggerResolvesTimezoneForEachRecord(t *testing.T) {
	var output bytes.Buffer
	settings := New(time.UTC)
	handler := Handler{Handler: slog.NewJSONHandler(&output, nil), Location: settings.Location}.WithAttrs([]slog.Attr{slog.String("component", "test")}).WithGroup("request")
	record := slog.NewRecord(time.Date(2026, 1, 1, 18, 45, 0, 0, time.UTC), slog.LevelInfo, "entry", 0)
	_ = handler.Handle(context.Background(), record)
	_ = settings.Set("Asia/Kathmandu")
	_ = handler.Handle(context.Background(), record)
	if !strings.Contains(output.String(), "2026-01-01T18:45:00Z") || !strings.Contains(output.String(), "2026-01-02T00:30:00+05:45") {
		t.Fatal(output.String())
	}
}
