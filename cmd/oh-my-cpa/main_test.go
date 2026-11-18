package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/oh-my-cpa/oh-my-cpa/internal/applog"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

func TestWriteStartupBannerRedactsSecretsAndKeepsNormalVersions(t *testing.T) {
	var stderr bytes.Buffer
	buffer := applog.NewBuffer(8)

	writeStartupBanner(&stderr, buffer, config.BuildInfo{
		Version: "v0.1.0-dev",
		Commit:  "e8bb4f57",
		BuiltAt: "2026-11-18T07:08:48Z",
	}, "dev", "0123456789abcdef0123456789abcdef")

	if got, want := strings.TrimSpace(stderr.String()), "Oh My CPA Version: v0.1.0-dev, Commit: e8bb4f57, BuiltAt: 2026-11-18T07:08:48Z"; got != want {
		t.Fatalf("normal banner = %q, want %q", got, want)
	}

	stderr.Reset()
	writeStartupBanner(&stderr, buffer, config.BuildInfo{
		Version: "sk-live-secret-12345678\nnext-line",
		Commit:  "my-management-secret-key",
		BuiltAt: "2026-11-18T07:08:48Z",
	}, "my-management-secret-key")

	line := strings.TrimSpace(stderr.String())
	if strings.Contains(line, "\n") || strings.Contains(line, "sk-live-secret") || strings.Contains(line, "my-management-secret-key") {
		t.Fatalf("unsanitized or multiline banner = %q", line)
	}
	if !strings.Contains(line, security.RedactedValue) {
		t.Fatalf("expected redaction marker in %q", line)
	}

	page := buffer.Since(0, 8)
	if len(page.Records) != 2 {
		t.Fatalf("service log records = %d, want 2", len(page.Records))
	}
	for _, attr := range page.Records[1].Attrs {
		if strings.Contains(attr.Value, "sk-live-secret") || strings.Contains(attr.Value, "my-management-secret-key") {
			t.Fatalf("secret leaked into service log attr %s = %q", attr.Key, attr.Value)
		}
	}
}
