package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
