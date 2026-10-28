package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// CredentialDisplayName is the operator-assigned name for one OAuth credential,
// keyed by its auth file name.
type CredentialDisplayName struct {
	FileName    string `json:"file_name"`
	DisplayName string `json:"display_name"`
	Version     int64  `json:"version"`
	CreatedAtMS int64  `json:"created_at_ms"`
	UpdatedAtMS int64  `json:"updated_at_ms"`
}

// MaxCredentialDisplayNameLength bounds a name in runes. It is the title of a
// credential row and of a request record's provider cell, not a description.
const MaxCredentialDisplayNameLength = 64

// ErrCredentialDisplayNameVersionConflict marks a write prepared against a stale read.
var ErrCredentialDisplayNameVersionConflict = errors.New("credential display name version conflict")

// ErrCredentialDisplayNameInvalid marks a name that cannot be stored.
var ErrCredentialDisplayNameInvalid = errors.New("credential display name is not valid")

// NormalizeCredentialDisplayName trims a name and rejects values that cannot be
// rendered safely, under the same rules as a caller-key alias.
func NormalizeCredentialDisplayName(raw string) (string, error) {
	return normalizeOperatorLabel(raw, MaxCredentialDisplayNameLength, ErrCredentialDisplayNameInvalid)
}

// ListCredentialDisplayNames returns every stored name for one instance, keyed by
// auth file name. The auth-file list joins it onto CPA's entries in one read.
func (r *Repository) ListCredentialDisplayNames(ctx context.Context, instanceID string) (map[string]CredentialDisplayName, error) {
	result := map[string]CredentialDisplayName{}
	if r == nil || r.SQL() == nil {
		return result, errors.New("repository is not initialized")
	}
	instanceID = strings.TrimSpace(instanceID)
	if instanceID == "" {
		return result, nil
	}
	rows, err := r.SQL().QueryContext(ctx, `
		SELECT file_name, display_name, version, created_at_ms, updated_at_ms
		FROM credential_display_names
		WHERE instance_id = ?`, instanceID)
	if err != nil {
		return nil, fmt.Errorf("list credential display names: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var entry CredentialDisplayName
		if errScan := rows.Scan(&entry.FileName, &entry.DisplayName, &entry.Version, &entry.CreatedAtMS, &entry.UpdatedAtMS); errScan != nil {
			return nil, fmt.Errorf("scan credential display name: %w", errScan)
		}
		result[entry.FileName] = entry
	}
	if errRows := rows.Err(); errRows != nil {
		return nil, fmt.Errorf("iterate credential display names: %w", errRows)
	}
	return result, nil
}

// SetCredentialDisplayName stores or clears one credential's name.
//
// expectedVersion is the version the caller read: zero means the credential has
// no name yet, which fails if one has since appeared. An empty name deletes the
// row, so "unnamed" has one representation in storage.
func (r *Repository) SetCredentialDisplayName(ctx context.Context, instanceID, fileName, displayName string, expectedVersion int64) (CredentialDisplayName, error) {
	var stored CredentialDisplayName
	instanceID = strings.TrimSpace(instanceID)
	fileName = strings.TrimSpace(fileName)
	if instanceID == "" || fileName == "" {
		return stored, fmt.Errorf("%w: instance id and file name are required", ErrCredentialDisplayNameInvalid)
	}
	if r == nil || r.SQL() == nil {
		return stored, errors.New("repository is not initialized")
	}
	normalized, err := NormalizeCredentialDisplayName(displayName)
	if err != nil {
		return stored, err
	}

	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return stored, fmt.Errorf("begin credential display name write: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var currentVersion int64
	var createdAtMS int64
	err = tx.QueryRowContext(ctx, `
		SELECT version, created_at_ms FROM credential_display_names
		WHERE instance_id = ? AND file_name = ?`, instanceID, fileName).Scan(&currentVersion, &createdAtMS)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return stored, fmt.Errorf("read credential display name version: %w", err)
	}
	if currentVersion != expectedVersion {
		return stored, fmt.Errorf("%w: stored version %d, expected %d",
			ErrCredentialDisplayNameVersionConflict, currentVersion, expectedVersion)
	}

	nowMS := time.Now().UnixMilli()
	if normalized == "" {
		if _, errDelete := tx.ExecContext(ctx, `
			DELETE FROM credential_display_names
			WHERE instance_id = ? AND file_name = ?`, instanceID, fileName); errDelete != nil {
			return stored, fmt.Errorf("clear credential display name: %w", errDelete)
		}
		if errCommit := tx.Commit(); errCommit != nil {
			return stored, fmt.Errorf("commit credential display name clear: %w", errCommit)
		}
		return CredentialDisplayName{FileName: fileName}, nil
	}

	if createdAtMS == 0 {
		createdAtMS = nowMS
	}
	stored = CredentialDisplayName{
		FileName:    fileName,
		DisplayName: normalized,
		Version:     currentVersion + 1,
		CreatedAtMS: createdAtMS,
		UpdatedAtMS: nowMS,
	}
	if _, errUpsert := tx.ExecContext(ctx, `
		INSERT INTO credential_display_names (instance_id, file_name, display_name, version, created_at_ms, updated_at_ms)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(instance_id, file_name) DO UPDATE SET
			display_name = excluded.display_name,
			version = excluded.version,
			updated_at_ms = excluded.updated_at_ms`,
		instanceID, fileName, stored.DisplayName, stored.Version, stored.CreatedAtMS, stored.UpdatedAtMS); errUpsert != nil {
		return CredentialDisplayName{}, fmt.Errorf("write credential display name: %w", errUpsert)
	}
	if errCommit := tx.Commit(); errCommit != nil {
		return CredentialDisplayName{}, fmt.Errorf("commit credential display name write: %w", errCommit)
	}
	return stored, nil
}
