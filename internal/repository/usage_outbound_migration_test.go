package repository

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func TestOutboundTierMigrationPreservesRecordsAndSequence(t *testing.T) {
	for _, isEmpty := range []bool{false, true} {
		t.Run(fmt.Sprintf("empty=%t", isEmpty), func(t *testing.T) {
			ctx := context.Background()
			db, err := Open(ctx, fmt.Sprintf("file:outbound_upgrade_%d?mode=memory&cache=shared", usageDSNCounter.Add(1)), withMigrationsUntil(45))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if _, err := db.SQL.ExecContext(ctx, `INSERT INTO cpa_instances(id, name, base_url, usage_addr, management_key_ciphertext, management_key_nonce, created_at, updated_at)
 VALUES ('default', 'Default', 'http://127.0.0.1:8317', '', x'00', x'00', 0, 0)`); err != nil {
				t.Fatal(err)
			}
			if _, err := db.SQL.ExecContext(ctx, `INSERT INTO usage_events(id, instance_id, event_key, api_group_key, provider, request_id, service_tier, response_service_tier, timestamp_ms, created_at_ms, cost_nanos, pricing_status, billed_service_tier, billed_service_tier_source, response_headers, access_provider, stream, model_substituted)
 VALUES (41, 'default', 'before-outbound', 'hmac:fixture', 'codex', 'migration-fixture', 'priority', 'default', 1234, 2345, 6000000, 'priced', 'priority', 'request', '[{"name":"x-test","value":"fixture"}]', 'native', 1, 1),
 (95, 'default', 'retained-high-water', '', '', '', '', '', 1234, 2345, NULL, 'legacy_unpriced', NULL, NULL, '', '', NULL, 0)`); err != nil {
				t.Fatal(err)
			}
			if _, err := db.SQL.ExecContext(ctx, `DELETE FROM usage_events WHERE id = 95`); err != nil {
				t.Fatal(err)
			}
			if isEmpty {
				if _, err := db.SQL.ExecContext(ctx, `DELETE FROM usage_events`); err != nil {
					t.Fatal(err)
				}
			}
			// Capture every existing column, not just the pricing fields, before the rebuild.
			rows, err := db.SQL.QueryContext(ctx, `PRAGMA table_info(usage_events)`)
			if err != nil {
				t.Fatal(err)
			}
			var columns []string
			for rows.Next() {
				var ordinal, notNull, primaryKey int
				var name, kind string
				var defaultValue any
				if err := rows.Scan(&ordinal, &name, &kind, &notNull, &defaultValue, &primaryKey); err != nil {
					t.Fatal(err)
				}
				columns = append(columns, name)
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			rows.Close()
			snapshot := func() string {
				pairs := make([]string, 0, len(columns))
				for _, column := range columns {
					pairs = append(pairs, fmt.Sprintf("'%s', %s", column, column))
				}
				var result string
				if err := db.SQL.QueryRowContext(ctx, `SELECT json_group_array(json(row)) FROM (SELECT json_object(`+strings.Join(pairs, ",")+`) AS row FROM usage_events ORDER BY id)`).Scan(&result); err != nil {
					t.Fatal(err)
				}
				return result
			}
			schemaObjects := func() map[string]string {
				rows, err := db.SQL.QueryContext(ctx, `SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'usage_events' AND type IN ('index', 'trigger')`)
				if err != nil {
					t.Fatal(err)
				}
				defer rows.Close()
				result := map[string]string{}
				for rows.Next() {
					var name, ddl string
					if err := rows.Scan(&name, &ddl); err != nil {
						t.Fatal(err)
					}
					result[name] = ddl
				}
				if err := rows.Err(); err != nil {
					t.Fatal(err)
				}
				return result
			}
			before, objects := snapshot(), schemaObjects()
			db.migrateUntil = 0
			if err := db.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			if after := snapshot(); after != before {
				t.Fatalf("historical rows changed: %s -> %s", before, after)
			}
			if after := schemaObjects(); !reflect.DeepEqual(after, objects) {
				t.Fatalf("indexes or immutability triggers changed: %v -> %v", objects, after)
			}
			if !isEmpty {
				var effective string
				if err := db.SQL.QueryRowContext(ctx, `SELECT effective_service_tier FROM usage_events WHERE id = 41`).Scan(&effective); err != nil || effective != "" {
					t.Fatalf("historical outbound evidence: %q %v", effective, err)
				}
				for _, column := range []string{"cost_nanos", "billed_service_tier", "billed_service_tier_source"} {
					if _, err := db.SQL.ExecContext(ctx, `UPDATE usage_events SET `+column+` = 'changed' WHERE id = 41`); err == nil || !strings.Contains(err.Error(), "immutable") {
						t.Fatalf("%s lost immutability: %v", column, err)
					}
				}
			}
			result, err := db.SQL.ExecContext(ctx, `INSERT INTO usage_events(instance_id, event_key, api_group_key, timestamp_ms, created_at_ms, effective_service_tier, billed_service_tier, billed_service_tier_source) VALUES ('default', 'after-outbound', '', 3456, 3456, 'priority', 'priority', 'outbound')`)
			if err != nil {
				t.Fatal(err)
			}
			id, err := result.LastInsertId()
			if err != nil || id != 96 {
				t.Fatalf("request id high-water lost: %d %v", id, err)
			}
			var integrity string
			if err := db.SQL.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&integrity); err != nil || integrity != "ok" {
				t.Fatalf("integrity: %s %v", integrity, err)
			}
			// The migrated table must retain the foreign-key boundary, not just the row values.
			if _, err := db.SQL.ExecContext(ctx, `INSERT INTO usage_events(instance_id, event_key, api_group_key, timestamp_ms, created_at_ms) VALUES ('missing-instance', 'invalid', '', 0, 0)`); err == nil {
				t.Fatal("instance foreign key was lost")
			}
		})
	}
}
