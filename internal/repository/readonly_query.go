package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

// The operator's read-only window onto this database.
//
// Four independent layers keep a query from changing anything or reading what it must not:
//
//  1. It runs on its own connection opened with `mode=ro` and `query_only`, so SQLite itself
//     refuses every write, and with `SQLITE_LIMIT_ATTACHED` at zero, so no other file can be
//     opened through it.
//  2. The text must be exactly one SELECT (or WITH ... SELECT) statement.
//  3. The compiled program is read before it runs. Every table or index it opens must belong to a
//     table this file classifies as readable, every column it reads must not be a redacted one,
//     no index it opens may cover a redacted column (a seek on one would answer yes or no about
//     the hidden value without ever reading it), and a program that writes a real table, opens a
//     virtual table, or touches a database other than `main` is refused. Reading the program
//     rather than the text is what makes aliases, views, subqueries and CTEs unable to route
//     around the policy.
//  4. What comes back is bounded - rows, cell length, total size, time - and text that looks like
//     a credential, an email address or a URL's userinfo is masked before it leaves the process,
//     in cells and in error messages alike. Masking is best-effort, not a boundary: it matches
//     shapes, so a value transformed in SQL (hex, replace, substr) passes unmasked. What must not
//     leave is kept out by layer 3, through the hidden tables and redacted columns.
//
// Tables are opt-in: a table a migration adds is unreadable until it is classified here, and the
// classification test fails until that decision is made.

// QUERY_READABLE_TABLES maps every table an operator query may read to the columns it must not.
var QUERY_READABLE_TABLES = map[string][]string{
	"audit_events":                  nil,
	"client_key_aliases":            nil,
	"connections":                   nil,
	"cpa_bindings":                  nil,
	"cpa_config_backup_settings":    nil,
	"discovered_resources":          {"details_json"},
	"error_events":                  {"body"},
	"ingest_gaps":                   nil,
	"model_price_versions":          nil,
	"model_prices":                  nil,
	"pricing_catalog_state":         nil,
	"pricing_channel_versions":      nil,
	"pricing_channels":              nil,
	"pricing_model_catalog":         nil,
	"pricing_model_links":           nil,
	"pricing_match_reviews":         nil,
	"pricing_sync_state":            nil,
	"pricing_upstream_catalog":      nil,
	"quota_snapshots":               nil,
	"release_check_state":           nil,
	"release_index":                 nil,
	"resource_overrides":            nil,
	"schema_migrations":             nil,
	"sqlite_sequence":               nil,
	"usage_aggregation_checkpoints": nil,
	"usage_events":                  nil,
	"usage_overview_daily_stats":    nil,
	"usage_overview_hourly_stats":   nil,
}

// QUERY_HIDDEN_TABLES are never readable, with the reason recorded for the next reviewer.
var QUERY_HIDDEN_TABLES = map[string]string{
	"custom_icons":       "operator-uploaded artwork is only returned by the authenticated image endpoint",
	"agent_documents":    "encrypted agent conversations and pending operations",
	"cpa_config_backups": "encrypted copies of CPA configuration files, which carry every secret in them",
	"cpa_instances":      "the encrypted CPA management key",
	"ui_preferences":     "operator preferences, including the playground's saved conversation",
	"usage_inboxes":      "raw usage payloads as CPA published them, which can carry client keys",
}

const (
	MAX_QUERY_SQL_BYTES  = 8 << 10
	MAX_QUERY_ROWS       = 200
	DEFAULT_QUERY_ROWS   = 50
	MAX_QUERY_CELL_CHARS = 500
	// MAX_QUERY_RESULT_BYTES leaves headroom under the capability payload cap for the envelope.
	MAX_QUERY_RESULT_BYTES = 24 << 10
	QUERY_TIMEOUT          = 5 * time.Second
	// MAX_QUERY_VALUE_BYTES bounds any string or blob a query can build, so `randomblob` or a
	// runaway `group_concat` fails instead of allocating without limit.
	MAX_QUERY_VALUE_BYTES = 1 << 20
)

// QueryError is a refusal or failure the caller may show to whoever wrote the query: the code is
// stable, and the detail names what to change.
type QueryError struct {
	Code   string
	Detail string
}

func (e *QueryError) Error() string         { return e.Code }
func (e *QueryError) FailureDetail() string { return e.Detail }

func queryError(code, format string, args ...any) error {
	return &QueryError{Code: code, Detail: fmt.Sprintf(format, args...)}
}

type QueryResult struct {
	Columns     []string `json:"columns"`
	Rows        [][]any  `json:"rows"`
	IsTruncated bool     `json:"is_truncated"`
}

type QueryColumn struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

type QueryTable struct {
	Name     string        `json:"name"`
	Columns  []QueryColumn `json:"columns"`
	Redacted []string      `json:"redacted,omitempty"`
}

// readOnlyPool opens, once, the connection pool operator queries run on.
func (db *DB) readOnlyPool() (*sql.DB, error) {
	db.readOnlyOnce.Do(func() {
		if !isFileDatabase(db.path) {
			db.readOnlyErr = errors.New("capability_unavailable")
			return
		}
		absolute, err := filepath.Abs(db.path)
		if err != nil {
			db.readOnlyErr = err
			return
		}
		location := (&url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}).String()
		pool, err := sql.Open("sqlite", location+"?mode=ro&_pragma=busy_timeout(2000)&_pragma=query_only(1)")
		if err != nil {
			db.readOnlyErr = err
			return
		}
		pool.SetMaxOpenConns(2)
		pool.SetMaxIdleConns(1)
		pool.SetConnMaxIdleTime(time.Minute)
		db.readOnly = pool
	})
	return db.readOnly, db.readOnlyErr
}

func (r *Repository) readOnlyConn(ctx context.Context) (*sql.Conn, error) {
	pool, err := r.db.readOnlyPool()
	if err != nil {
		return nil, err
	}
	conn, err := pool.Conn(ctx)
	if err != nil {
		return nil, err
	}
	// Limits belong to a connection, not a pool, so they are applied to the one about to be used.
	for _, limit := range [][2]int{
		{sqlite3.SQLITE_LIMIT_ATTACHED, 0},
		{sqlite3.SQLITE_LIMIT_LENGTH, MAX_QUERY_VALUE_BYTES},
		{sqlite3.SQLITE_LIMIT_SQL_LENGTH, MAX_QUERY_SQL_BYTES + 64},
		{sqlite3.SQLITE_LIMIT_COMPOUND_SELECT, 16},
		{sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 200},
	} {
		if _, err := sqlite.Limit(conn, limit[0], limit[1]); err != nil {
			conn.Close()
			return nil, err
		}
	}
	return conn, nil
}

type queryTableInfo struct {
	columns []string
	denied  map[string]bool
	// hasDeniedColumns on a WITHOUT ROWID table denies the whole table: its cursor's column order
	// is the primary key's, so a column number cannot be trusted to name the same column.
	isWithoutRowID bool
}

type querySchema struct {
	tables map[string]*queryTableInfo
	// roots maps a b-tree root page to the table it stores and, for an index, the table column
	// each index column holds (-1 is the rowid, -2 an expression).
	roots map[int64]queryRoot
}

type queryRoot struct {
	table   string
	indexed []int
	isIndex bool
	// index names the index for a refusal; coversDenied marks one whose key, expression or
	// partial-index condition involves a redacted column.
	index        string
	coversDenied bool
}

func loadQuerySchema(ctx context.Context, conn *sql.Conn) (*querySchema, error) {
	schema := &querySchema{tables: map[string]*queryTableInfo{}, roots: map[int64]queryRoot{1: {table: "sqlite_schema"}}}
	rows, err := conn.QueryContext(ctx, `SELECT type, name, tbl_name, rootpage, COALESCE(sql, '') FROM main.sqlite_schema WHERE type IN ('table', 'index') AND rootpage > 0`)
	if err != nil {
		return nil, err
	}
	type entry struct {
		kind, name, table, sql string
		root                   int64
	}
	var entries []entry
	for rows.Next() {
		var item entry
		if err := rows.Scan(&item.kind, &item.name, &item.table, &item.root, &item.sql); err != nil {
			rows.Close()
			return nil, err
		}
		entries = append(entries, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, item := range entries {
		if item.kind != "table" {
			continue
		}
		info := &queryTableInfo{denied: map[string]bool{}, isWithoutRowID: strings.Contains(strings.ToUpper(item.sql), "WITHOUT ROWID")}
		columns, err := conn.QueryContext(ctx, `SELECT name FROM pragma_table_info(?)`, item.name)
		if err != nil {
			return nil, err
		}
		for columns.Next() {
			var name string
			if err := columns.Scan(&name); err != nil {
				columns.Close()
				return nil, err
			}
			info.columns = append(info.columns, name)
		}
		columns.Close()
		if err := columns.Err(); err != nil {
			return nil, err
		}
		for _, name := range QUERY_READABLE_TABLES[item.name] {
			info.denied[name] = true
		}
		schema.tables[item.name] = info
		schema.roots[item.root] = queryRoot{table: item.name}
	}
	for _, item := range entries {
		if item.kind != "index" {
			continue
		}
		root := queryRoot{table: item.table, isIndex: true, index: item.name}
		denied := schema.tables[item.table].deniedSet()
		for name := range denied {
			if sqlMentions(item.sql, name) {
				root.coversDenied = true
			}
		}
		columns, err := conn.QueryContext(ctx, `SELECT cid FROM pragma_index_xinfo(?) ORDER BY seqno`, item.name)
		if err != nil {
			return nil, err
		}
		for columns.Next() {
			var cid int
			if err := columns.Scan(&cid); err != nil {
				columns.Close()
				return nil, err
			}
			root.indexed = append(root.indexed, cid)
			info := schema.tables[item.table]
			if len(denied) > 0 && (cid == -2 || cid >= 0 && cid < len(info.columns) && denied[info.columns[cid]]) {
				root.coversDenied = true
			}
		}
		columns.Close()
		if err := columns.Err(); err != nil {
			return nil, err
		}
		schema.roots[item.root] = root
	}
	return schema, nil
}

func (info *queryTableInfo) deniedSet() map[string]bool {
	if info == nil {
		return nil
	}
	return info.denied
}

// sqlMentions reports whether `name` appears in a schema statement as a whole word, which is
// deliberately loose: a false match only refuses an index, never admits one.
func sqlMentions(statement, name string) bool {
	return regexp.MustCompile(`(?i)(^|[^A-Za-z0-9_])` + regexp.QuoteMeta(name) + `($|[^A-Za-z0-9_])`).MatchString(statement)
}

// isReadable is the table-level policy: classified as readable, and not a WITHOUT ROWID table
// that also hides columns.
func (s *querySchema) isReadable(table string) bool {
	if table == "sqlite_schema" {
		return true
	}
	denied, isListed := QUERY_READABLE_TABLES[table]
	info := s.tables[table]
	return isListed && info != nil && !(info.isWithoutRowID && len(denied) > 0)
}

// Opcodes that change a database. A SELECT never compiles to one of them; seeing one means the
// statement is not what it appears to be.
var forbiddenOpcodes = map[string]bool{
	"OpenWrite": true, "Clear": true, "Destroy": true, "CreateBtree": true, "ParseSchema": true,
	"SqlExec": true, "Vacuum": true, "IncrVacuum": true, "JournalMode": true, "VUpdate": true,
	"VCreate": true, "VDestroy": true, "LoadAnalysis": true,
}

// Opcodes that open or read a virtual table, which is how table-valued functions compile.
var virtualTableOpcodes = map[string]bool{"VOpen": true, "VFilter": true, "VColumn": true}

// Row writes are how SQLite fills its own scratch b-trees - ORDER BY ... LIMIT, UNION, DISTINCT
// and recursive CTEs all insert into an ephemeral table or sorter - so they are refused only on a
// cursor that is not one of those.
var cursorWriteOpcodes = map[string]bool{"Insert": true, "Delete": true, "IdxInsert": true, "IdxDelete": true}

var scratchOpenOpcodes = map[string]bool{"OpenEphemeral": true, "OpenAutoindex": true, "SorterOpen": true, "OpenPseudo": true}

type queryInstruction struct {
	opcode     string
	p1, p2, p3 int64
}

// checkQueryProgram reads the compiled program of `statement` and refuses it unless every read
// it makes is allowed.
func checkQueryProgram(ctx context.Context, conn *sql.Conn, schema *querySchema, statement string) error {
	rows, err := conn.QueryContext(ctx, "EXPLAIN "+statement)
	if err != nil {
		return queryError("query_invalid", "%s", sqliteMessage(err))
	}
	defer rows.Close()
	var program []queryInstruction
	for rows.Next() {
		var address, p5 int64
		var instruction queryInstruction
		var p4, comment sql.NullString
		if err := rows.Scan(&address, &instruction.opcode, &instruction.p1, &instruction.p2, &instruction.p3, &p4, &p5, &comment); err != nil {
			return err
		}
		program = append(program, instruction)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	// Cursors are classified over the whole program before any write is judged, because the
	// listing is not execution order: a loop can write a cursor above the instruction opening it.
	// A cursor number that is ever opened on a real b-tree never counts as scratch.
	scratch, stored := map[int64]bool{}, map[int64]bool{}
	for _, instruction := range program {
		switch {
		case scratchOpenOpcodes[instruction.opcode] || instruction.opcode == "OpenDup":
			scratch[instruction.p1] = true
		case instruction.opcode == "OpenRead" || instruction.opcode == "ReopenIdx" || instruction.opcode == "OpenWrite":
			stored[instruction.p1] = true
		}
	}
	for _, instruction := range program {
		if instruction.opcode == "OpenDup" && !scratch[instruction.p2] {
			stored[instruction.p1] = true
		}
	}
	cursors := map[int64]queryRoot{}
	for _, instruction := range program {
		opcode, p1, p2, p3 := instruction.opcode, instruction.p1, instruction.p2, instruction.p3
		if virtualTableOpcodes[opcode] {
			return queryError("query_forbidden", "table-valued functions such as json_each and pragma_* are not available; use json_extract")
		}
		if forbiddenOpcodes[opcode] || cursorWriteOpcodes[opcode] && (!scratch[p1] || stored[p1]) {
			return queryError("query_forbidden", "the statement would write; only SELECT reads of OMC tables are allowed")
		}
		switch opcode {
		case "Transaction":
			if p2 != 0 {
				return queryError("query_forbidden", "the statement would write")
			}
		case "OpenRead", "ReopenIdx":
			if p3 != 0 {
				return queryError("query_forbidden", "only the main database can be read")
			}
			root, ok := schema.roots[p2]
			if !ok {
				return queryError("query_forbidden", "the statement reads storage that is not an OMC table")
			}
			if !schema.isReadable(root.table) {
				return queryError("query_forbidden", "table %s is not readable", root.table)
			}
			if root.coversDenied {
				return queryError("query_forbidden", "index %s covers a redacted column of %s", root.index, root.table)
			}
			cursors[p1] = root
		case "OpenDup":
			if root, ok := cursors[p2]; ok {
				cursors[p1] = root
			}
		case "Column":
			root, ok := cursors[p1]
			if !ok || root.table == "sqlite_schema" {
				continue
			}
			info := schema.tables[root.table]
			if len(info.denied) == 0 {
				continue
			}
			column := int(p2)
			if root.isIndex {
				if column >= len(root.indexed) {
					return queryError("query_forbidden", "the statement reads an unidentified column of %s", root.table)
				}
				column = root.indexed[column]
				if column == -1 {
					continue
				}
			}
			if column < 0 || column >= len(info.columns) {
				return queryError("query_forbidden", "the statement reads an unidentified column of %s", root.table)
			}
			if info.denied[info.columns[column]] {
				return queryError("query_forbidden", "column %s.%s is redacted", root.table, info.columns[column])
			}
		}
	}
	return nil
}

// QuerySchema lists the tables a read-only query may use, and the columns each hides.
func (r *Repository) QuerySchema(ctx context.Context) ([]QueryTable, error) {
	conn, err := r.readOnlyConn(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	schema, err := loadQuerySchema(ctx, conn)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(schema.tables))
	for name := range schema.tables {
		if schema.isReadable(name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	tables := make([]QueryTable, 0, len(names))
	for _, name := range names {
		table := QueryTable{Name: name, Columns: []QueryColumn{}}
		columns, err := conn.QueryContext(ctx, `SELECT name, type FROM pragma_table_info(?) ORDER BY cid`, name)
		if err != nil {
			return nil, err
		}
		for columns.Next() {
			var column QueryColumn
			if err := columns.Scan(&column.Name, &column.Type); err != nil {
				columns.Close()
				return nil, err
			}
			if schema.tables[name].denied[column.Name] {
				table.Redacted = append(table.Redacted, column.Name)
				continue
			}
			table.Columns = append(table.Columns, column)
		}
		columns.Close()
		if err := columns.Err(); err != nil {
			return nil, err
		}
		tables = append(tables, table)
	}
	return tables, nil
}

// ReadOnlyQuery runs one operator-supplied SELECT under the policy described at the top of this
// file and returns at most maxRows rows.
func (r *Repository) ReadOnlyQuery(ctx context.Context, statement string, maxRows int) (QueryResult, error) {
	statement, err := singleSelect(statement)
	if err != nil {
		return QueryResult{}, err
	}
	if maxRows <= 0 {
		maxRows = DEFAULT_QUERY_ROWS
	}
	maxRows = min(maxRows, MAX_QUERY_ROWS)
	ctx, cancel := context.WithTimeout(ctx, QUERY_TIMEOUT)
	defer cancel()
	conn, err := r.readOnlyConn(ctx)
	if err != nil {
		return QueryResult{}, err
	}
	defer conn.Close()
	schema, err := loadQuerySchema(ctx, conn)
	if err != nil {
		return QueryResult{}, err
	}
	if err := checkQueryProgram(ctx, conn, schema, statement); err != nil {
		return QueryResult{}, err
	}
	rows, err := conn.QueryContext(ctx, statement)
	if err != nil {
		return QueryResult{}, mapQueryFailure(ctx, err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return QueryResult{}, err
	}
	result := QueryResult{Columns: columns, Rows: [][]any{}}
	size := 0
	for _, column := range columns {
		size += len(column) + 3
	}
	values := make([]any, len(columns))
	pointers := make([]any, len(columns))
	for i := range values {
		pointers[i] = &values[i]
	}
	for rows.Next() {
		if len(result.Rows) == maxRows {
			result.IsTruncated = true
			break
		}
		if err := rows.Scan(pointers...); err != nil {
			return QueryResult{}, mapQueryFailure(ctx, err)
		}
		row := make([]any, len(values))
		for i, value := range values {
			row[i] = queryCell(value)
		}
		raw, _ := json.Marshal(row)
		if size+len(raw) > MAX_QUERY_RESULT_BYTES {
			result.IsTruncated = true
			break
		}
		size += len(raw) + 1
		result.Rows = append(result.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return QueryResult{}, mapQueryFailure(ctx, err)
	}
	return result, nil
}

func mapQueryFailure(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return queryError("query_timeout", "the query ran longer than %s; narrow it with WHERE on an indexed time column or aggregate", QUERY_TIMEOUT)
	}
	return queryError("query_invalid", "%s", sqliteMessage(err))
}

// sqliteMessage is the engine's own complaint without the driver's framing, which is what a
// query's author needs to fix it. A runtime error can quote a stored value (json_extract reports
// the path it was given, which can be a column), so the message is masked like a cell. The
// redacted columns cannot reach it: the program check refuses reading them before anything runs.
func sqliteMessage(err error) string {
	message := err.Error()
	if index := strings.LastIndex(message, "): "); index >= 0 {
		message = message[index+3:]
	}
	message = maskSensitiveText(message)
	if utf8.RuneCountInString(message) > 300 {
		message = string([]rune(message)[:300])
	}
	return message
}

// queryCell converts a stored value into something JSON can carry, bounded and masked.
func queryCell(value any) any {
	switch typed := value.(type) {
	case nil, int64, float64, bool:
		return typed
	case []byte:
		if utf8.Valid(typed) {
			return maskQueryText(string(typed))
		}
		return fmt.Sprintf("[blob %d bytes]", len(typed))
	case string:
		return maskQueryText(typed)
	case time.Time:
		return typed.UTC().Format(time.RFC3339Nano)
	default:
		return maskQueryText(fmt.Sprint(typed))
	}
}

var (
	// A URL's userinfo is replaced before emails are looked for, so `user:secret@host` is
	// recognized as credentials rather than as an address.
	urlUserinfoPattern = regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://)[^/\s@]+@`)
	emailPattern       = regexp.MustCompile(`([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})`)
	// Shapes of credentials that commonly end up in text a provider returns: OpenAI-style and
	// Anthropic-style keys, Google API keys and OAuth access tokens, GitHub and Slack tokens,
	// JWTs, and anything presented as a bearer token.
	credentialPattern = regexp.MustCompile(`(?i)\b(?:sk-[A-Za-z0-9_-]{12,}|AIza[0-9A-Za-z_-]{20,}|ya29\.[0-9A-Za-z_.-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})|\bbearer\s+[A-Za-z0-9._~+/=-]{8,}`)
)

func maskQueryText(text string) string {
	text = maskSensitiveText(text)
	if utf8.RuneCountInString(text) > MAX_QUERY_CELL_CHARS {
		runes := []rune(text)
		text = string(runes[:MAX_QUERY_CELL_CHARS]) + "…"
	}
	return text
}

func maskSensitiveText(text string) string {
	text = credentialPattern.ReplaceAllString(text, "[redacted]")
	text = urlUserinfoPattern.ReplaceAllString(text, "$1[redacted]@")
	return emailPattern.ReplaceAllString(text, "$1***@$2")
}

// singleSelect accepts exactly one SELECT or WITH statement, with an optional trailing semicolon,
// and returns it without the semicolon. It tokenizes just enough SQL - quoted strings and
// identifiers, and both comment forms - to find a statement boundary that is really one.
func singleSelect(statement string) (string, error) {
	if len(statement) > MAX_QUERY_SQL_BYTES {
		return "", queryError("query_invalid", "the statement is longer than %d bytes", MAX_QUERY_SQL_BYTES)
	}
	end := len(statement)
scan:
	for i := 0; i < len(statement); i++ {
		switch character := statement[i]; character {
		case '\'', '"', '`', '[':
			closer := character
			if closer == '[' {
				closer = ']'
			}
			closing := strings.IndexByte(statement[i+1:], closer)
			if closing < 0 {
				return "", queryError("query_invalid", "unterminated quoted text or identifier")
			}
			i += closing + 1
		case '-':
			if strings.HasPrefix(statement[i:], "--") {
				newline := strings.IndexByte(statement[i:], '\n')
				if newline < 0 {
					break scan
				}
				i += newline
			}
		case '/':
			if strings.HasPrefix(statement[i:], "/*") {
				closing := strings.Index(statement[i+2:], "*/")
				if closing < 0 {
					return "", queryError("query_invalid", "unterminated comment")
				}
				i += closing + 3
			}
		case ';':
			end = i
			break scan
		}
	}
	if end < len(statement) && skipTrivia(statement[end+1:]) != "" {
		return "", queryError("query_forbidden", "only one statement can run at a time")
	}
	statement = strings.TrimSpace(statement[:end])
	keyword := strings.ToUpper(leadingWord(skipTrivia(strings.TrimLeft(statement, "("))))
	if keyword != "SELECT" && keyword != "WITH" {
		return "", queryError("query_forbidden", "only SELECT statements are allowed")
	}
	return statement, nil
}

// skipTrivia drops leading whitespace and comments; an unterminated comment leaves nothing.
func skipTrivia(text string) string {
	for {
		text = strings.TrimLeft(text, " \t\r\n\f")
		switch {
		case strings.HasPrefix(text, "--"):
			newline := strings.IndexByte(text, '\n')
			if newline < 0 {
				return ""
			}
			text = text[newline:]
		case strings.HasPrefix(text, "/*"):
			closing := strings.Index(text, "*/")
			if closing < 0 {
				return ""
			}
			text = text[closing+2:]
		default:
			return text
		}
	}
}

func leadingWord(text string) string {
	end := strings.IndexFunc(text, func(character rune) bool {
		return !(character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z')
	})
	if end < 0 {
		return text
	}
	return text[:end]
}
