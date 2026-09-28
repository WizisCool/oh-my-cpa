package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// AuditEvent is one append-only operator audit log record.
type AuditEvent struct {
	ID            int64          `json:"id"`
	OccurredAtMS  int64          `json:"occurred_at_ms"`
	Action        string         `json:"action"`
	TargetType    string         `json:"target_type"`
	TargetID      string         `json:"target_id"`
	Result        string         `json:"result"`
	RequestID     string         `json:"request_id"`
	SourceSummary string         `json:"source_summary"`
	Details       map[string]any `json:"details,omitempty"`
}

// RecordAuditEvent writes one audit record to the append-only audit_events table.
// Target identifiers, action names, and details are sanitized to ensure no secret
// material is retained in audit logs.
func (r *Repository) RecordAuditEvent(ctx context.Context, event AuditEvent) (int64, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	if event.OccurredAtMS <= 0 {
		event.OccurredAtMS = time.Now().UnixMilli()
	}
	action := security.RedactText(strings.TrimSpace(event.Action))
	if action == "" {
		return 0, errors.New("audit action is required")
	}
	targetType := security.RedactText(strings.TrimSpace(event.TargetType))
	if targetType == "" {
		return 0, errors.New("audit target type is required")
	}
	targetID := security.RedactText(strings.TrimSpace(event.TargetID))
	result := security.RedactText(strings.TrimSpace(event.Result))
	if result == "" {
		result = "success"
	}
	requestID := security.RedactText(strings.TrimSpace(event.RequestID))
	sourceSummary := security.RedactText(strings.TrimSpace(event.SourceSummary))

	detailsJSON := "{}"
	if len(event.Details) > 0 {
		encoded, err := json.Marshal(event.Details)
		if err == nil {
			redacted, redErr := security.RedactJSON(encoded)
			if redErr == nil {
				detailsJSON = string(redacted)
			}
		}
	}

	res, err := r.SQL().ExecContext(ctx, `
		INSERT INTO audit_events (
			occurred_at_ms, action, target_type, target_id, result,
			request_id, source_summary, details_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		event.OccurredAtMS, action, targetType, targetID, result,
		requestID, sourceSummary, detailsJSON,
	)
	if err != nil {
		return 0, fmt.Errorf("insert audit event: %w", err)
	}
	id, _ := res.LastInsertId()
	return id, nil
}

// ListAuditEvents returns the most recent audit records in descending order.
func (r *Repository) ListAuditEvents(ctx context.Context, limit int) ([]AuditEvent, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	rows, err := r.SQL().QueryContext(ctx, `
		SELECT id, occurred_at_ms, action, target_type, target_id, result,
		       request_id, source_summary, details_json
		FROM audit_events
		ORDER BY occurred_at_ms DESC, id DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("list audit events: %w", err)
	}
	defer rows.Close()

	events := make([]AuditEvent, 0)
	for rows.Next() {
		var event AuditEvent
		var detailsRaw string
		if err := rows.Scan(
			&event.ID, &event.OccurredAtMS, &event.Action, &event.TargetType,
			&event.TargetID, &event.Result, &event.RequestID, &event.SourceSummary,
			&detailsRaw,
		); err != nil {
			return nil, fmt.Errorf("scan audit event: %w", err)
		}
		if detailsRaw != "" && detailsRaw != "{}" {
			_ = json.Unmarshal([]byte(detailsRaw), &event.Details)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return events, nil
}

// AuditQuery narrows one page of the audit trail.
type AuditQuery struct {
	// Limit is the page size; 1..AuditPageMax, defaulting to 50.
	Limit int
	// Before is the keyset cursor of the last row already shown; zero starts at
	// the newest row.
	Before AuditCursor
	// Categories keeps actions whose first segment is one of these (`provider`
	// keeps `provider.update`). Empty keeps every action.
	Categories []string
	// Outcome keeps only rows of one result class: AuditOutcomeFailed,
	// AuditOutcomeSucceeded or AuditOutcomeUnfinished (an `attempt` row; with
	// FoldAttempts, one whose outcome never landed). Empty keeps every result.
	Outcome string
	// Search is a case-insensitive substring of the action, target or request id.
	Search string
	// SinceMS keeps rows at or after this instant; zero keeps everything.
	SinceMS int64
	// FoldAttempts hides an `attempt` row once the same request has recorded the
	// action's outcome, so a write reads as one entry. An attempt with no outcome
	// stays visible: that is an operation the trail never saw finish.
	FoldAttempts bool
}

// AuditCursor is the (time, id) position of a row in the trail's newest-first
// order. The id alone is not enough because a caller may backdate OccurredAtMS.
type AuditCursor struct {
	OccurredAtMS int64
	ID           int64
}

// AuditPage is one page of the trail, newest first.
type AuditPage struct {
	Events []AuditEvent
	// Next is the cursor for the following page; nil when this page is the last.
	Next *AuditCursor
}

const (
	// auditFoldWindowMS bounds how long after an attempt an outcome may land and
	// still be read as its outcome when the two rows carry different request ids.
	auditFoldWindowMS = 60_000
	// auditStableRequestIDMigration is the schema version that shipped with one
	// request id per request; its applied_at marks where exact pairing begins.
	auditStableRequestIDMigration = 27

	// AuditPageMax bounds one page, and therefore one export.
	AuditPageMax = 5000

	AuditOutcomeFailed     = "failed"
	AuditOutcomeSucceeded  = "succeeded"
	AuditOutcomeUnfinished = "unfinished"
)

// Result classes. Everything not named here (`attempt`, and the Agent's
// `prepared`/`decision`) is neither and matches no outcome filter.
var (
	auditFailedResults    = []string{"failure", "error", "rejected", "denied", "uncertain", "partial"}
	auditSucceededResults = []string{"success", "checked", "cached", "admitted"}
)

// QueryAuditEvents returns one filtered page of the trail, newest first.
func (r *Repository) QueryAuditEvents(ctx context.Context, query AuditQuery) (AuditPage, error) {
	if r == nil || r.SQL() == nil {
		return AuditPage{}, errors.New("repository is not initialized")
	}
	limit := query.Limit
	if limit <= 0 {
		limit = 50
	}
	if limit > AuditPageMax {
		limit = AuditPageMax
	}

	where, args := auditFilterClauses(query)
	statement := `
		SELECT e.id, e.occurred_at_ms, e.action, e.target_type, e.target_id, e.result,
		       e.request_id, e.source_summary, e.details_json
		FROM audit_events e`
	if len(where) > 0 {
		statement += "\n\t\tWHERE " + strings.Join(where, "\n\t\t  AND ")
	}
	statement += "\n\t\tORDER BY e.occurred_at_ms DESC, e.id DESC\n\t\tLIMIT ?"
	// One extra row answers "is there another page" without a count query.
	args = append(args, limit+1)

	rows, err := r.SQL().QueryContext(ctx, statement, args...)
	if err != nil {
		return AuditPage{}, fmt.Errorf("query audit events: %w", err)
	}
	defer rows.Close()

	events := make([]AuditEvent, 0, limit)
	for rows.Next() {
		var event AuditEvent
		var detailsRaw string
		if err := rows.Scan(
			&event.ID, &event.OccurredAtMS, &event.Action, &event.TargetType,
			&event.TargetID, &event.Result, &event.RequestID, &event.SourceSummary,
			&detailsRaw,
		); err != nil {
			return AuditPage{}, fmt.Errorf("scan audit event: %w", err)
		}
		if detailsRaw != "" && detailsRaw != "{}" {
			_ = json.Unmarshal([]byte(detailsRaw), &event.Details)
		}
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return AuditPage{}, err
	}

	page := AuditPage{Events: events}
	if len(events) > limit {
		page.Events = events[:limit]
		last := page.Events[limit-1]
		page.Next = &AuditCursor{OccurredAtMS: last.OccurredAtMS, ID: last.ID}
	}
	return page, nil
}

// auditFilterClauses turns a query into WHERE clauses over `audit_events e`, shared by
// the page read and the summary so both count exactly the rows the timeline would show.
func auditFilterClauses(query AuditQuery) ([]string, []any) {
	where := make([]string, 0, 6)
	args := make([]any, 0, 16)
	if query.Before.ID > 0 {
		where = append(where, "(e.occurred_at_ms < ? OR (e.occurred_at_ms = ? AND e.id < ?))")
		args = append(args, query.Before.OccurredAtMS, query.Before.OccurredAtMS, query.Before.ID)
	}
	if query.SinceMS > 0 {
		where = append(where, "e.occurred_at_ms >= ?")
		args = append(args, query.SinceMS)
	}
	if len(query.Categories) > 0 {
		clauses := make([]string, 0, len(query.Categories))
		for _, category := range query.Categories {
			// Categories are validated identifiers, but the prefix match still
			// escapes LIKE's wildcards so `_` in `api_key` matches only itself.
			clauses = append(clauses, `(e.action = ? OR e.action LIKE ? ESCAPE '\')`)
			args = append(args, category, escapeLikePattern(category)+".%")
		}
		where = append(where, "("+strings.Join(clauses, " OR ")+")")
	}
	switch query.Outcome {
	case AuditOutcomeUnfinished:
		// With folding on, an attempt left in the result is one whose outcome was never
		// recorded; without it every attempt would match, finished or not.
		where = append(where, "e.result = 'attempt'")
	case AuditOutcomeFailed:
		where = append(where, "e.result IN ("+placeholders(len(auditFailedResults))+")")
		args = appendStrings(args, auditFailedResults)
	case AuditOutcomeSucceeded:
		where = append(where, "e.result IN ("+placeholders(len(auditSucceededResults))+")")
		args = appendStrings(args, auditSucceededResults)
	}
	if search := strings.TrimSpace(query.Search); search != "" {
		pattern := "%" + escapeLikePattern(strings.ToLower(search)) + "%"
		where = append(where, `(lower(e.action) LIKE ? ESCAPE '\' OR lower(e.target_type) LIKE ? ESCAPE '\' OR lower(e.target_id) LIKE ? ESCAPE '\' OR lower(e.request_id) LIKE ? ESCAPE '\')`)
		args = append(args, pattern, pattern, pattern, pattern)
	}
	if query.FoldAttempts {
		// The request-id pairing is exact. The second arm pairs rows written before
		// request ids were stable per request: an outcome for the same action and
		// target that followed within auditFoldWindowMS is the same operation. Both rows
		// must be older than migration 027, which shipped with stable ids, so neither a
		// later attempt nor a later outcome is ever paired by guesswork.
		where = append(where, `NOT (e.result = 'attempt' AND (
			(e.request_id <> '' AND EXISTS (
				SELECT 1 FROM audit_events o
				WHERE o.request_id = e.request_id AND o.action = e.action AND o.result <> 'attempt'))
			OR (e.occurred_at_ms < COALESCE((SELECT applied_at FROM schema_migrations WHERE version = ?), 0) * 1000
				AND EXISTS (
					SELECT 1 FROM audit_events o
					WHERE o.action = e.action AND o.target_id = e.target_id AND o.result <> 'attempt'
					  AND o.occurred_at_ms BETWEEN e.occurred_at_ms AND e.occurred_at_ms + ?
					  AND o.occurred_at_ms < COALESCE((SELECT applied_at FROM schema_migrations WHERE version = ?), 0) * 1000))))`)
		args = append(args, auditStableRequestIDMigration, auditFoldWindowMS, auditStableRequestIDMigration)
	}

	return where, args
}

func placeholders(count int) string {
	return strings.TrimSuffix(strings.Repeat("?,", count), ",")
}

func appendStrings(args []any, values []string) []any {
	for _, value := range values {
		args = append(args, value)
	}
	return args
}

// AuditBucket counts the trail's rows for one action prefix and one outcome class.
type AuditBucket struct {
	// Prefix is the action's first segment (`provider` for `provider.update`).
	Prefix string `json:"prefix"`
	// Outcome is AuditOutcomeSucceeded, AuditOutcomeFailed, AuditOutcomeUnfinished,
	// or "other" for results that are neither (the Agent's `prepared`/`decision`).
	Outcome string `json:"outcome"`
	Count   int64  `json:"count"`
}

// auditSummaryOther classes a result that is neither a success, a failure nor an attempt.
const auditSummaryOther = "other"

// SummarizeAuditEvents counts the rows QueryAuditEvents would return for the same
// query, as a matrix of action prefix by outcome class. Cursor, category and outcome
// are ignored: the matrix is what the console derives both facets from, and each
// facet's counts must hold the other facet's selection, not its own.
func (r *Repository) SummarizeAuditEvents(ctx context.Context, query AuditQuery) ([]AuditBucket, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	query.Before = AuditCursor{}
	query.Categories = nil
	query.Outcome = ""
	where, args := auditFilterClauses(query)
	statement := `
		SELECT CASE WHEN instr(e.action, '.') > 0 THEN substr(e.action, 1, instr(e.action, '.') - 1) ELSE e.action END,
		       e.result, COUNT(1)
		FROM audit_events e`
	if len(where) > 0 {
		statement += "\n\t\tWHERE " + strings.Join(where, "\n\t\t  AND ")
	}
	statement += "\n\t\tGROUP BY 1, 2"
	rows, err := r.SQL().QueryContext(ctx, statement, args...)
	if err != nil {
		return nil, fmt.Errorf("summarize audit events: %w", err)
	}
	defer rows.Close()

	counts := make(map[[2]string]int64)
	for rows.Next() {
		var prefix, result string
		var count int64
		if err := rows.Scan(&prefix, &result, &count); err != nil {
			return nil, fmt.Errorf("scan audit summary: %w", err)
		}
		counts[[2]string{prefix, auditOutcomeClass(result)}] += count
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	buckets := make([]AuditBucket, 0, len(counts))
	for key, count := range counts {
		buckets = append(buckets, AuditBucket{Prefix: key[0], Outcome: key[1], Count: count})
	}
	sort.Slice(buckets, func(i, j int) bool {
		if buckets[i].Prefix != buckets[j].Prefix {
			return buckets[i].Prefix < buckets[j].Prefix
		}
		return buckets[i].Outcome < buckets[j].Outcome
	})
	return buckets, nil
}

// auditOutcomeClass maps a stored result onto the outcome filter's classes, from the
// same lists the filter uses, so a facet count always equals what its filter returns.
func auditOutcomeClass(result string) string {
	switch {
	case result == "attempt":
		return AuditOutcomeUnfinished
	case slices.Contains(auditSucceededResults, result):
		return AuditOutcomeSucceeded
	case slices.Contains(auditFailedResults, result):
		return AuditOutcomeFailed
	default:
		return auditSummaryOther
	}
}
