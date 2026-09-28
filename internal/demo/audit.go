package demo

import (
	"context"
	"fmt"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/applog"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// demoAuditSource is the source a visitor's own actions would carry: a masked
// documentation-range network and a browser, never a real address.
const demoAuditSource = "ip=203.0.113.0/24 ua=Mozilla/5.0"

// demoAuditEntry is one operation on the fixture's trail. A write records its
// attempt and its outcome under one request id, as the live handlers do, so the
// console's folding is exercised by the fixture rather than only by tests.
type demoAuditEntry struct {
	ago        time.Duration
	action     string
	targetType string
	targetID   string
	results    []string
	details    map[string]any
}

var demoAuditTrail = []demoAuditEntry{
	{4 * time.Minute, "auth.login", "auth", "operator", []string{"success"}, map[string]any{"ip": "203.0.113.0/24"}},
	{38 * time.Minute, "provider.update", "provider", "openai-compat-0", []string{"attempt", "success"}, map[string]any{"name": "Groq"}},
	{52 * time.Minute, "api_key.reveal", "client_api_key", "list", []string{"success"}, map[string]any{"key_count": 3}},
	{75 * time.Minute, "client_key.alias_set", "client_key", "client_key_alias", []string{"attempt", "success"}, map[string]any{"cleared": false}},
	{2 * time.Hour, "quota.refresh", "quota", "auth-codex-01", []string{"success"}, map[string]any{"status": "healthy"}},
	{3*time.Hour + 10*time.Minute, "auth.login", "auth", "operator", []string{"failure"}, map[string]any{"ip": "198.51.100.0/24"}},
	{5 * time.Hour, "config.save_source", "config", "config_source_yaml", []string{"attempt", "success"}, map[string]any{"bytes": 8574}},
	{8 * time.Hour, "oauth.start", "oauth_provider", "anthropic", []string{"success"}, nil},
	{8*time.Hour - 2*time.Minute, "oauth.callback", "oauth_callback", "anthropic", []string{"attempt", "success"}, nil},
	{26 * time.Hour, "pricing.sync.start", "pricing", "openrouter", []string{"success"}, nil},
	{27 * time.Hour, "plugin.disable", "plugin", "request-logger", []string{"attempt", "failure"}, map[string]any{"error": "CPA returned HTTP 409"}},
	{29 * time.Hour, "capability.usage_aggregate", "capability_operation", "agent-usage-01", []string{"attempt", "success"}, map[string]any{"adapter": "agent"}},
	{30 * time.Hour, "capability.providers_delete", "capability_operation", "agent-provider-02", []string{"prepared", "rejected"}, map[string]any{"adapter": "agent"}},
	{49 * time.Hour, "system.maintenance.checkpoint", "database", "checkpoint", []string{"admitted"}, nil},
	{49*time.Hour - time.Minute, "system.maintenance.wal_checkpoint.completed", "database", "wal_checkpoint", []string{"success"}, map[string]any{"reclaimed_bytes": 2518288}},
	{51 * time.Hour, "provider.delete", "provider", "openai-compat-2", []string{"attempt", "success"}, nil},
	{54 * time.Hour, "auth_file.fields_update", "auth_file", "codex-demo-01.json", []string{"attempt", "success"}, map[string]any{"fields": []string{"proxy_url"}, "verified": true}},
	{70 * time.Hour, "audit.export", "audit_events", "export", []string{"success"}, map[string]any{"count": 118}},
	{71 * time.Hour, "system.check_updates", "system", "release_feed", []string{"checked"}, nil},
}

// seedAudit writes the fixture's operator trail, anchored at now so every row is
// deterministic for a given reference instant.
func seedAudit(ctx context.Context, repo *repository.Repository, now time.Time) (int, error) {
	written := 0
	for index, entry := range demoAuditTrail {
		requestID := fmt.Sprintf("req_demo_audit_%02d", index+1)
		at := now.Add(-entry.ago).UnixMilli()
		for step, result := range entry.results {
			if _, err := repo.RecordAuditEvent(ctx, repository.AuditEvent{
				// The outcome lands a moment after its attempt, as it does live.
				OccurredAtMS:  at + int64(step)*350,
				Action:        entry.action,
				TargetType:    entry.targetType,
				TargetID:      entry.targetID,
				Result:        result,
				RequestID:     requestID,
				SourceSummary: demoAuditSource,
				Details:       entry.details,
			}); err != nil {
				return written, fmt.Errorf("seed audit %s: %w", entry.action, err)
			}
			written++
		}
	}
	return written, nil
}

// SeedServiceLog fills a service log buffer with what a running deployment says
// in its first minutes. The demonstration's own process log names loopback
// fixtures and export machinery, which is neither representative nor
// reproducible, so the demo shows these records instead.
func SeedServiceLog(buffer *applog.Buffer, now time.Time) {
	if buffer == nil {
		return
	}
	records := []struct {
		ago     time.Duration
		level   string
		message string
		attrs   []applog.Attr
	}{
		{95 * time.Minute, "info", "HTTP server listening", []applog.Attr{{Key: "addr", Value: ":8080"}, {Key: "base_path", Value: "/omc"}}},
		{95 * time.Minute, "info", "usage ingestion started", []applog.Attr{{Key: "mode", Value: "auto"}, {Key: "instance", Value: "default"}}},
		{94 * time.Minute, "info", "release check sweep started", []applog.Attr{{Key: "interval", Value: "6h0m0s"}}},
		{93 * time.Minute, "info", "pricing sync completed", []applog.Attr{{Key: "models", Value: "412"}, {Key: "changed", Value: "3"}}},
		{61 * time.Minute, "warn", "usage queue read timed out; retrying", []applog.Attr{{Key: "attempt", Value: "1"}, {Key: "delay", Value: "2s"}}},
		{60 * time.Minute, "info", "usage ingestion resumed", []applog.Attr{{Key: "backlog", Value: "37"}}},
		{27 * time.Minute, "error", "plugin status update failed", []applog.Attr{{Key: "plugin", Value: "request-logger"}, {Key: "error", Value: "CPA returned HTTP 409"}}},
		{12 * time.Minute, "info", "quota refresh completed", []applog.Attr{{Key: "credentials", Value: "6"}, {Key: "duration", Value: "1.84s"}}},
		{3 * time.Minute, "info", "usage batch stored", []applog.Attr{{Key: "events", Value: "24"}, {Key: "duplicates", Value: "0"}}},
	}
	for _, record := range records {
		buffer.Append(applog.Record{
			LoggedAtMS: now.Add(-record.ago).UnixMilli(),
			Level:      record.level,
			Message:    record.message,
			Attrs:      record.attrs,
		})
	}
}
