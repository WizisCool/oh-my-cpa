package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// IngestGap records a loss or potential loss of usage records due to a pop-versus-write
// failure at the network/storage boundary.
type IngestGap struct {
	ID               int64  `json:"id"`
	InstanceID       string `json:"instance_id"`
	SourceMode       string `json:"source_mode"`
	StartedAtMS      int64  `json:"started_at_ms"`
	EndedAtMS        int64  `json:"ended_at_ms"`
	EstimatedCount   int    `json:"estimated_count"`
	ReasonCode       string `json:"reason_code"`
	Summary          string `json:"summary"`
	AcknowledgedAtMS *int64 `json:"acknowledged_at_ms,omitempty"`
}

// RecordIngestGap inserts one durable coverage gap entry.
func (r *Repository) RecordIngestGap(ctx context.Context, gap IngestGap) (int64, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	nowMS := time.Now().UnixMilli()
	if gap.StartedAtMS <= 0 {
		gap.StartedAtMS = nowMS
	}
	if gap.EndedAtMS <= 0 {
		gap.EndedAtMS = nowMS
	}
	instanceID := security.RedactText(strings.TrimSpace(gap.InstanceID))
	if instanceID == "" {
		instanceID = "default"
	}
	sourceMode := security.RedactText(strings.TrimSpace(gap.SourceMode))
	reasonCode := security.RedactText(strings.TrimSpace(gap.ReasonCode))
	if reasonCode == "" {
		reasonCode = "unknown_gap"
	}
	summary := security.RedactText(strings.TrimSpace(gap.Summary))

	res, err := r.SQL().ExecContext(ctx, `
		INSERT INTO ingest_gaps (
			instance_id, source_mode, started_at_ms, ended_at_ms,
			estimated_count, reason_code, summary, acknowledged_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		instanceID, sourceMode, gap.StartedAtMS, gap.EndedAtMS,
		gap.EstimatedCount, reasonCode, summary, gap.AcknowledgedAtMS,
	)
	if err != nil {
		return 0, fmt.Errorf("insert ingest gap: %w", err)
	}
	id, _ := res.LastInsertId()
	return id, nil
}

// ListIngestGaps returns recent coverage gaps for an instance.
func (r *Repository) ListIngestGaps(ctx context.Context, instanceID string, limit int) ([]IngestGap, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	instanceID = strings.TrimSpace(instanceID)
	query := `
		SELECT id, instance_id, source_mode, started_at_ms, ended_at_ms,
		       estimated_count, reason_code, summary, acknowledged_at_ms
		FROM ingest_gaps`
	args := []any{}
	if instanceID != "" {
		query += ` WHERE instance_id = ?`
		args = append(args, instanceID)
	}
	query += ` ORDER BY started_at_ms DESC, id DESC LIMIT ?`
	args = append(args, limit)

	rows, err := r.SQL().QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list ingest gaps: %w", err)
	}
	defer rows.Close()

	var gaps []IngestGap
	for rows.Next() {
		var gap IngestGap
		var ack sql.NullInt64
		if err := rows.Scan(
			&gap.ID, &gap.InstanceID, &gap.SourceMode, &gap.StartedAtMS, &gap.EndedAtMS,
			&gap.EstimatedCount, &gap.ReasonCode, &gap.Summary, &ack,
		); err != nil {
			return nil, fmt.Errorf("scan ingest gap: %w", err)
		}
		if ack.Valid {
			gap.AcknowledgedAtMS = &ack.Int64
		}
		gaps = append(gaps, gap)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return gaps, nil
}

// AcknowledgeIngestGap marks an ingest gap as acknowledged by an operator.
func (r *Repository) AcknowledgeIngestGap(ctx context.Context, id int64) error {
	if r == nil || r.SQL() == nil {
		return errors.New("repository is not initialized")
	}
	nowMS := time.Now().UnixMilli()
	_, err := r.SQL().ExecContext(ctx, `
		UPDATE ingest_gaps SET acknowledged_at_ms = ? WHERE id = ?`, nowMS, id)
	if err != nil {
		return fmt.Errorf("acknowledge ingest gap: %w", err)
	}
	return nil
}
