package operations

import (
	"context"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type DatabaseQueryInput struct {
	SQL     string `json:"sql" jsonschema:"One SQLite SELECT (or WITH ... SELECT) statement"`
	MaxRows int    `json:"max_rows,omitempty" jsonschema:"Rows to return, 1-200; defaults to 50"`
}

type DatabaseTables struct {
	Tables []repository.QueryTable `json:"tables"`
}

// registerDatabase exposes OMC's own database to read-only SQL. The policy - which tables and
// columns are readable, and how a statement is proven to be a read - lives with the repository
// (readonly_query.go), so the capability here only describes it to the model.
//
// Only the built-in Agent is offered it (ADR 0036). An MCP client runs outside OMC, on a host and
// a model the operator did not pick on the Agent page, and free-form SQL reaches more of OMC's
// records at once than any declared read; the declared reads remain its surface.
func (s *Service) registerDatabase(registry *capability.Registry) error {
	if err := agentRead(registry, "database_schema", "List the OMC database tables and columns that database_query may read. Redacted columns and hidden tables (credentials, raw payloads, agent sessions, preferences) are not readable.", func(ctx context.Context, _ Empty) (DatabaseTables, error) {
		tables, err := s.Repo.QuerySchema(ctx)
		return DatabaseTables{Tables: tables}, err
	}); err != nil {
		return err
	}
	return agentRead(registry, "database_query", "Run one read-only SQLite SELECT against the OMC database for questions the other capabilities cannot answer; call database_schema first. Times are epoch milliseconds (`*_ms`). Prefer aggregates and WHERE on time columns: at most 200 rows and 5 seconds, and long text is cut. Credential-like text, URL credentials and email addresses are masked on a best-effort basis; hidden tables and redacted columns are what keep secrets out. Table-valued functions (json_each, pragma_*) are unavailable; use json_extract.", func(ctx context.Context, input DatabaseQueryInput) (repository.QueryResult, error) {
		return s.Repo.ReadOnlyQuery(ctx, input.SQL, input.MaxRows)
	})
}

func agentRead[I, O any](registry *capability.Registry, name, description string, handler func(context.Context, I) (O, error)) error {
	metadata := Meta(name, description, "read", "low")
	metadata.Adapters = []string{"agent"}
	return capability.Register(registry, metadata, nil, func(ctx context.Context, input I, _, _ string) (O, error) { return handler(ctx, input) })
}
