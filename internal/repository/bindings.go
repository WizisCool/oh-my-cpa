package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// CPABinding maps a discovered CPA resource instance to a stable tracking record.
type CPABinding struct {
	ID                 string  `json:"id"`
	InstanceID         string  `json:"instance_id"`
	ResourceID         *string `json:"resource_id,omitempty"`
	CPAResourceType    string  `json:"cpa_resource_type"`
	CPAAuthIndex       string  `json:"cpa_auth_index"`
	BindingFingerprint string  `json:"binding_fingerprint"`
	Status             string  `json:"status"`
	FirstSeenAtMS      int64   `json:"first_seen_at_ms"`
	LastSeenAtMS       int64   `json:"last_seen_at_ms"`
	MissingAtMS        *int64  `json:"missing_at_ms,omitempty"`
}

// ListCPABindings returns current CPA bindings for an instance.
func (r *Repository) ListCPABindings(ctx context.Context, instanceID string) ([]CPABinding, error) {
	if r == nil || r.db == nil || r.db.SQL == nil {
		return nil, errors.New("repository is not initialized")
	}
	instanceID = strings.TrimSpace(instanceID)
	query := `
		SELECT id, instance_id, resource_id, cpa_resource_type, cpa_auth_index,
		       binding_fingerprint, status, first_seen_at_ms, last_seen_at_ms, missing_at_ms
		FROM cpa_bindings`
	args := []any{}
	if instanceID != "" {
		query += ` WHERE instance_id = ?`
		args = append(args, instanceID)
	}
	query += ` ORDER BY last_seen_at_ms DESC, id DESC`

	rows, err := r.db.SQL.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list cpa bindings: %w", err)
	}
	defer rows.Close()

	var bindings []CPABinding
	for rows.Next() {
		var item CPABinding
		var resID sql.NullString
		var missingAt sql.NullInt64
		if err := rows.Scan(
			&item.ID, &item.InstanceID, &resID, &item.CPAResourceType,
			&item.CPAAuthIndex, &item.BindingFingerprint, &item.Status,
			&item.FirstSeenAtMS, &item.LastSeenAtMS, &missingAt,
		); err != nil {
			return nil, fmt.Errorf("scan cpa binding: %w", err)
		}
		if resID.Valid {
			item.ResourceID = &resID.String
		}
		if missingAt.Valid {
			item.MissingAtMS = &missingAt.Int64
		}
		bindings = append(bindings, item)
	}
	return bindings, rows.Err()
}

// GetCPABinding retrieves one binding by ID.
func (r *Repository) GetCPABinding(ctx context.Context, id string) (CPABinding, error) {
	var item CPABinding
	if r == nil || r.db == nil || r.db.SQL == nil {
		return item, errors.New("repository is not initialized")
	}
	var resID sql.NullString
	var missingAt sql.NullInt64
	err := r.db.SQL.QueryRowContext(ctx, `
		SELECT id, instance_id, resource_id, cpa_resource_type, cpa_auth_index,
		       binding_fingerprint, status, first_seen_at_ms, last_seen_at_ms, missing_at_ms
		FROM cpa_bindings WHERE id = ?`, id).Scan(
		&item.ID, &item.InstanceID, &resID, &item.CPAResourceType,
		&item.CPAAuthIndex, &item.BindingFingerprint, &item.Status,
		&item.FirstSeenAtMS, &item.LastSeenAtMS, &missingAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return item, ErrNotFound
		}
		return item, fmt.Errorf("get cpa binding: %w", err)
	}
	if resID.Valid {
		item.ResourceID = &resID.String
	}
	if missingAt.Valid {
		item.MissingAtMS = &missingAt.Int64
	}
	return item, nil
}
