package repository

import (
	"context"
	"errors"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

func TestReadOnlyDSNPreservesAbsolutePaths(t *testing.T) {
	for _, example := range []struct {
		name, path, want string
	}{
		{"unix", "/var/lib/omc/query.db", "file:///var/lib/omc/query.db"},
		{"windows drive", "C:/Users/runner/query.db", "file:///C:/Users/runner/query.db"},
		{"lowercase drive", "d:/OMC data/query.db", "file:///d:/OMC%20data/query.db"},
		{"escaped filename", "C:/OMC 数据/query #100%?.db", "file:///C:/OMC%20%E6%95%B0%E6%8D%AE/query%20%23100%25%3F.db"},
		{"unix backslash", `/var/lib/omc/query\name.db`, "file:///var/lib/omc/query%5Cname.db"},
	} {
		t.Run(example.name, func(t *testing.T) {
			dsn := formatReadOnlyDSN(example.path)
			location, err := url.Parse(dsn)
			if err != nil {
				t.Fatal(err)
			}
			if location.Scheme != "file" || location.Host != "" || location.Fragment != "" {
				t.Fatalf("database path became a URI authority or fragment: %s", dsn)
			}
			query := location.Query()
			location.RawQuery = ""
			if location.String() != example.want {
				t.Errorf("database URI = %s, want %s", location.String(), example.want)
			}
			if query.Get("mode") != "ro" || strings.Join(query["_pragma"], ",") != "busy_timeout(2000),query_only(1)" {
				t.Fatalf("read-only connection settings changed: %s", dsn)
			}
		})
	}
}

func TestReadOnlyPoolOpensTheSameFileAndRefusesWrites(t *testing.T) {
	ctx := context.Background()
	database, err := Open(ctx, filepath.Join(t.TempDir(), "query 数据 #100%.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	repo := New(database)
	if _, err := repo.SQL().Exec(`INSERT INTO pricing_channels (channel, multiplier, note, updated_at_ms) VALUES ('path-marker', 1, '', 1)`); err != nil {
		t.Fatal(err)
	}
	result, err := repo.ReadOnlyQuery(ctx, `SELECT channel FROM pricing_channels WHERE channel = 'path-marker'`, 0)
	if err != nil || len(result.Rows) != 1 || result.Rows[0][0] != "path-marker" {
		t.Fatalf("read-only pool did not read the writable database: %+v %v", result, err)
	}
	conn, err := repo.readOnlyConn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	var isQueryOnly int
	if err := conn.QueryRowContext(ctx, `PRAGMA query_only`).Scan(&isQueryOnly); err != nil || isQueryOnly != 1 {
		t.Fatalf("query_only = %d, error = %v", isQueryOnly, err)
	}
	assertReadOnlyFailure := func(err error) {
		t.Helper()
		var failure *sqlite.Error
		if !errors.As(err, &failure) || failure.Code() != sqlite3.SQLITE_READONLY {
			t.Fatalf("write must fail with SQLITE_READONLY: %v", err)
		}
	}
	_, err = conn.ExecContext(ctx, `DELETE FROM pricing_channels`)
	assertReadOnlyFailure(err)
	if _, err := conn.ExecContext(ctx, `PRAGMA query_only = OFF`); err != nil {
		t.Fatal(err)
	}
	_, err = conn.ExecContext(ctx, `DELETE FROM pricing_channels`)
	assertReadOnlyFailure(err)
	if _, err := conn.ExecContext(ctx, `ATTACH DATABASE ':memory:' AS other`); err == nil || !strings.Contains(err.Error(), "too many attached databases") {
		t.Fatalf("attachment must fail at the zero-database limit: %v", err)
	}
}

func queryTestRepository(t *testing.T) *Repository {
	t.Helper()
	database, err := Open(context.Background(), filepath.Join(t.TempDir(), "query.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	return New(database)
}

func queryCode(err error) string {
	var failure *QueryError
	if errors.As(err, &failure) {
		return failure.Code
	}
	if err == nil {
		return ""
	}
	return err.Error()
}

// Every table a migration creates is a decision: readable (with its hidden columns named) or
// hidden with a reason. A new table fails here until someone makes that decision.
func TestEveryTableIsClassifiedForOperatorQueries(t *testing.T) {
	repo := queryTestRepository(t)
	rows, err := repo.SQL().Query(`SELECT name FROM sqlite_schema WHERE type = 'table'`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		_, isReadable := QUERY_READABLE_TABLES[name]
		_, isHidden := QUERY_HIDDEN_TABLES[name]
		if isReadable == isHidden {
			t.Errorf("table %s must be in exactly one of QUERY_READABLE_TABLES and QUERY_HIDDEN_TABLES", name)
		}
	}
	schema, err := repo.QuerySchema(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, table := range schema {
		if _, isHidden := QUERY_HIDDEN_TABLES[table.Name]; isHidden {
			t.Errorf("hidden table %s is listed", table.Name)
		}
		if table.Name == "error_events" && (len(table.Redacted) != 1 || table.Redacted[0] != "body") {
			t.Errorf("error_events redaction: %+v", table.Redacted)
		}
		for _, column := range table.Columns {
			if table.Name == "error_events" && column.Name == "body" {
				t.Error("redacted column listed")
			}
		}
	}
}

func TestReadOnlyQueryRefusesWhatItMustNotRead(t *testing.T) {
	repo := queryTestRepository(t)
	ctx := context.Background()
	for _, statement := range []string{
		`SELECT * FROM cpa_instances`,
		`SELECT management_key_nonce FROM cpa_instances`,
		`SELECT pref_value FROM ui_preferences`,
		`SELECT count(*) FROM agent_documents`,
		`SELECT raw_message FROM usage_inboxes`,
		`WITH hidden AS (SELECT * FROM ui_preferences) SELECT * FROM hidden`,
		`SELECT (SELECT pref_value FROM ui_preferences LIMIT 1)`,
		`SELECT id FROM usage_events WHERE instance_id IN (SELECT id FROM cpa_instances)`,
		`SELECT body FROM error_events`,
		`SELECT e.body AS harmless FROM error_events e`,
		`SELECT * FROM error_events`,
		`SELECT length(body) FROM error_events`,
		`SELECT id FROM error_events WHERE body LIKE '%key%'`,
		`SELECT details_json FROM discovered_resources`,
		`SELECT * FROM main.cpa_instances`,
		`SELECT * FROM temp.sqlite_schema`,
		`SELECT * FROM json_each('[1]')`,
		`SELECT * FROM pragma_table_info('usage_events')`,
		`DELETE FROM usage_events`,
		`UPDATE model_prices SET model = 'x'`,
		`WITH x AS (SELECT 1) DELETE FROM usage_events`,
		`INSERT INTO pricing_channels VALUES ('x', 1, '', 0)`,
		`ATTACH DATABASE 'other.db' AS other`,
		`PRAGMA table_info(usage_events)`,
		`SELECT 1; DELETE FROM usage_events`,
		`SELECT 1; SELECT 2`,
		`VACUUM`,
		`CREATE TABLE x (id INTEGER)`,
	} {
		result, err := repo.ReadOnlyQuery(ctx, statement, 10)
		code := queryCode(err)
		if code != "query_forbidden" && code != "query_invalid" {
			t.Errorf("%s: accepted (%v, %+v)", statement, err, result)
		}
	}
}

func TestReadOnlyQueryReadsBoundedAndMasked(t *testing.T) {
	repo := queryTestRepository(t)
	ctx := context.Background()
	if _, err := repo.SQL().Exec(`INSERT INTO pricing_channels (channel, multiplier, note, updated_at_ms) VALUES
		('alpha', 1.5, 'owner alice@example.com', 1),
		('beta', 2, 'key `+"sk-"+`abcdefghijklmnopqrstu', 2),
		('gamma', 1, ?, 3)`, strings.Repeat("x", 512)); err != nil {
		t.Fatal(err)
	}
	result, err := repo.ReadOnlyQuery(ctx, " -- channels\n SELECT channel, multiplier, note FROM pricing_channels ORDER BY channel; ", 2)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(result.Columns, ",") != "channel,multiplier,note" || len(result.Rows) != 2 || !result.IsTruncated {
		t.Fatalf("bounded result: %+v", result)
	}
	if result.Rows[0][2] != "owner a***@example.com" || result.Rows[1][2] != "key [redacted]" {
		t.Fatalf("masking: %+v", result.Rows)
	}
	result, err = repo.ReadOnlyQuery(ctx, `SELECT note FROM pricing_channels WHERE channel = 'gamma'`, 0)
	if err != nil || len([]rune(result.Rows[0][0].(string))) != MAX_QUERY_CELL_CHARS+1 {
		t.Fatalf("cell bound: %+v %v", result, err)
	}
	// Reading a redacted table's other columns, including through its indexes, stays allowed.
	if _, err := repo.ReadOnlyQuery(ctx, `SELECT count(*), max(status_code) FROM error_events WHERE timestamp_ms > 0`, 0); err != nil {
		t.Fatalf("readable columns of a redacted table: %v", err)
	}
	if _, err := repo.ReadOnlyQuery(ctx, `SELECT name FROM sqlite_schema WHERE type = 'table'`, 0); err != nil {
		t.Fatalf("schema read: %v", err)
	}
	if _, err := repo.ReadOnlyQuery(ctx, `SELECT length(randomblob(2000000))`, 0); queryCode(err) != "query_invalid" {
		t.Fatalf("value size bound: %v", err)
	}
	if _, err := repo.ReadOnlyQuery(ctx, `SELECT missing_column FROM usage_events`, 0); queryCode(err) != "query_invalid" || !strings.Contains(err.(*QueryError).Detail, "missing_column") {
		t.Fatalf("invalid query detail: %v", err)
	}
}

// ORDER BY ... LIMIT, UNION, DISTINCT and recursive CTEs fill SQLite's own scratch b-trees with
// row writes; those must not be mistaken for writes to a table.
func TestReadOnlyQueryAllowsScratchTableShapes(t *testing.T) {
	repo := queryTestRepository(t)
	ctx := context.Background()
	if _, err := repo.SQL().Exec(`INSERT INTO pricing_channels (channel, multiplier, note, updated_at_ms) VALUES
		('alpha', 1.5, '', 1), ('beta', 2, '', 2), ('gamma', 1, '', 3)`); err != nil {
		t.Fatal(err)
	}
	for statement, want := range map[string]int{
		`SELECT channel FROM pricing_channels ORDER BY multiplier DESC LIMIT 2`:                                   2,
		`SELECT channel FROM pricing_channels WHERE multiplier > 1 UNION SELECT channel FROM pricing_channels`:    3,
		`SELECT DISTINCT multiplier FROM pricing_channels ORDER BY multiplier`:                                    3,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT i FROM n`:             5,
		`WITH RECURSIVE n(i) AS (SELECT 1 UNION SELECT i + 1 FROM n WHERE i < 4) SELECT i FROM n ORDER BY i DESC`: 4,
	} {
		result, err := repo.ReadOnlyQuery(ctx, statement, 0)
		if err != nil || len(result.Rows) != want {
			t.Errorf("%s: %v %+v", statement, err, result)
		}
	}
}

// An index on a redacted column would let a WHERE seek answer yes or no about the hidden value
// without any column read, so no migration may create one, and a query may not open one.
func TestRedactedColumnsAreNeverIndexed(t *testing.T) {
	repo := queryTestRepository(t)
	ctx := context.Background()
	conn, err := repo.readOnlyConn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	schema, err := loadQuerySchema(ctx, conn)
	if err != nil {
		t.Fatal(err)
	}
	for _, root := range schema.roots {
		if root.isIndex && root.coversDenied {
			t.Errorf("index %s covers a redacted column of %s", root.index, root.table)
		}
	}
	for _, statement := range []string{
		`CREATE INDEX error_events_body ON error_events(body)`,
		`CREATE INDEX error_events_body_length ON error_events(length(body))`,
		`CREATE INDEX error_events_with_body ON error_events(timestamp_ms) WHERE body LIKE '%key%'`,
	} {
		t.Run(statement, func(t *testing.T) {
			repo := queryTestRepository(t)
			if _, err := repo.SQL().Exec(statement); err != nil {
				t.Fatal(err)
			}
			index := strings.Fields(statement)[2]
			conn, err := repo.readOnlyConn(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			schema, err := loadQuerySchema(ctx, conn)
			if err != nil {
				t.Fatal(err)
			}
			isFlagged := false
			for _, root := range schema.roots {
				isFlagged = isFlagged || root.index == index && root.coversDenied
			}
			if !isFlagged {
				t.Errorf("index %s is not recognized as covering a redacted column", index)
			}
			for _, query := range []string{
				`SELECT count(*) FROM error_events INDEXED BY ` + index + ` WHERE timestamp_ms > 0 AND body LIKE '%key%'`,
				`SELECT count(*) FROM error_events WHERE body = 'secret'`,
			} {
				if _, err := repo.ReadOnlyQuery(ctx, query, 0); queryCode(err) != "query_forbidden" {
					t.Errorf("%s: %v", query, err)
				}
			}
		})
	}
}

func TestReadOnlyQueryMasksErrorsAndURLCredentials(t *testing.T) {
	repo := queryTestRepository(t)
	ctx := context.Background()
	if _, err := repo.SQL().Exec(`INSERT INTO pricing_channels (channel, multiplier, note, updated_at_ms) VALUES
		('alpha', 1, ?, 1), ('beta', 1, 'https://admin:hunter2@example.com/v1', 2)`, "sk-"+"abcdefghijklmnopqrstu"); err != nil {
		t.Fatal(err)
	}
	_, err := repo.ReadOnlyQuery(ctx, `SELECT json_extract('{}', note) FROM pricing_channels WHERE channel = 'alpha'`, 0)
	if queryCode(err) != "query_invalid" || strings.Contains(err.(*QueryError).Detail, "abcdefghijklmnopqrstu") {
		t.Fatalf("error text: %v", err)
	}
	result, err := repo.ReadOnlyQuery(ctx, `SELECT note FROM pricing_channels WHERE channel = 'beta'`, 0)
	if err != nil || result.Rows[0][0] != "https://[redacted]@example.com/v1" {
		t.Fatalf("url userinfo: %v %+v", err, result)
	}
}

func TestReadOnlyQueryStopsAtItsTimeLimit(t *testing.T) {
	repo := queryTestRepository(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := repo.ReadOnlyQuery(ctx, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n`, 0)
	if err == nil {
		t.Fatal("cancelled query ran")
	}
}

func TestSingleSelectFindsTheRealStatementBoundary(t *testing.T) {
	for statement, isAccepted := range map[string]bool{
		`SELECT ';' AS semicolon`:                              true,
		`SELECT "a;b" FROM usage_events;`:                      true,
		"SELECT 1 -- trailing; comment":                        true,
		"SELECT 1; /* done */ -- really\n":                     true,
		`(SELECT 1)`:                                           true,
		"/* lead */ WITH x AS (SELECT 1) SELECT * FROM x":      true,
		`SELECT 1;;`:                                           false,
		`SELECT 'unterminated`:                                 false,
		`SELECT 1; DROP TABLE usage_events`:                    false,
		"SELECT 1 /* ; */; SELECT 2":                           false,
		`EXPLAIN SELECT 1`:                                     false,
		`REPLACE INTO pricing_channels VALUES ('x', 1, '', 0)`: false,
	} {
		_, err := singleSelect(statement)
		if (err == nil) != isAccepted {
			t.Errorf("%q: %v", statement, err)
		}
	}
}
