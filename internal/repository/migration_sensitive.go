package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// sanitizeHistoricalDataTx is the governance hook for migration 004. It runs
// inside the migration transaction so a failed cleanup cannot leave a schema
// that claims to be governed while old values remain in place.
func sanitizeHistoricalDataTx(ctx context.Context, tx *sql.Tx, db *DB) error {
	if tx == nil {
		return errors.New("migration transaction is required")
	}
	if err := sanitizeHistoricalResourcesTx(ctx, tx); err != nil {
		return err
	}
	if err := sanitizeHistoricalInboxesTx(ctx, tx, db); err != nil {
		return err
	}
	if err := sanitizeHistoricalErrorsTx(ctx, tx); err != nil {
		return err
	}
	if err := sanitizeHistoricalUsageEventsTx(ctx, tx, db); err != nil {
		return err
	}
	return nil
}

func sanitizeHistoricalResourcesTx(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT id, details_json
		FROM discovered_resources
		WHERE details_json IS NOT NULL AND details_json <> ''`)
	if err != nil {
		return errors.New("read historical resource details")
	}
	defer rows.Close()

	type resourceDetailsUpdate struct {
		id      string
		details string
	}
	updates := make([]resourceDetailsUpdate, 0)
	for rows.Next() {
		var id, raw string
		if err := rows.Scan(&id, &raw); err != nil {
			return errors.New("scan historical resource details")
		}
		sanitized := sanitizeHistoricalResourceDetails(raw)
		if sanitized != raw {
			updates = append(updates, resourceDetailsUpdate{id: id, details: sanitized})
		}
	}
	if err := rows.Err(); err != nil {
		return errors.New("iterate historical resource details")
	}
	for _, update := range updates {
		if _, err := tx.ExecContext(ctx, `UPDATE discovered_resources SET details_json = ? WHERE id = ?`, update.details, update.id); err != nil {
			return errors.New("write sanitized resource details")
		}
	}
	return nil
}

func sanitizeHistoricalResourceDetails(raw string) string {
	var details domain.ResourceDetails
	if err := json.Unmarshal([]byte(raw), &details); err != nil {
		return `{}`
	}
	details = sanitizeResourceDetails(details)
	encoded, err := json.Marshal(details)
	if err != nil {
		return `{}`
	}
	return string(encoded)
}

func sanitizeHistoricalInboxesTx(ctx context.Context, tx *sql.Tx, db *DB) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT id, raw_message, COALESCE(last_error, ''), raw_message_ciphertext, raw_message_nonce
		FROM usage_inboxes`)
	if err != nil {
		return errors.New("read historical usage inboxes")
	}
	defer rows.Close()

	type inboxUpdate struct {
		id         int64
		projection string
		lastError  string
		ciphertext []byte
		nonce      []byte
	}
	updates := make([]inboxUpdate, 0)
	for rows.Next() {
		var update inboxUpdate
		var raw string
		var ciphertext, nonce []byte
		if err := rows.Scan(&update.id, &raw, &update.lastError, &ciphertext, &nonce); err != nil {
			return errors.New("scan historical usage inbox")
		}
		update.projection = security.RedactPayload(raw)
		update.lastError = security.RedactText(update.lastError)
		update.ciphertext = ciphertext
		update.nonce = nonce
		if len(ciphertext) == 0 && strings.TrimSpace(raw) != "" && db != nil && db.cipher != nil {
			encrypted, generatedNonce, err := db.cipher.Encrypt([]byte(raw))
			if err != nil {
				return errors.New("encrypt historical usage inbox")
			}
			update.ciphertext = encrypted
			update.nonce = generatedNonce
		}
		updates = append(updates, update)
	}
	if err := rows.Err(); err != nil {
		return errors.New("iterate historical usage inboxes")
	}
	for _, update := range updates {
		if _, err := tx.ExecContext(ctx, `
			UPDATE usage_inboxes
			SET raw_message = ?, last_error = NULLIF(?, ''),
				raw_message_ciphertext = ?, raw_message_nonce = ?
			WHERE id = ?`, update.projection, update.lastError, update.ciphertext, update.nonce, update.id); err != nil {
			return errors.New("write sanitized usage inbox")
		}
	}
	return nil
}

func sanitizeHistoricalErrorsTx(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT id, body, auth_status, quota_reason
		FROM error_events`)
	if err != nil {
		return errors.New("read historical error events")
	}
	defer rows.Close()

	type errorUpdate struct {
		id          int64
		body        string
		authStatus  string
		quotaReason string
	}
	updates := make([]errorUpdate, 0)
	for rows.Next() {
		var update errorUpdate
		if err := rows.Scan(&update.id, &update.body, &update.authStatus, &update.quotaReason); err != nil {
			return errors.New("scan historical error event")
		}
		update.body = security.RedactText(update.body)
		update.authStatus = security.RedactText(update.authStatus)
		update.quotaReason = security.RedactText(update.quotaReason)
		updates = append(updates, update)
	}
	if err := rows.Err(); err != nil {
		return errors.New("iterate historical error events")
	}
	for _, update := range updates {
		if _, err := tx.ExecContext(ctx, `
			UPDATE error_events
			SET body = ?, auth_status = ?, quota_reason = ?
			WHERE id = ?`, update.body, update.authStatus, update.quotaReason, update.id); err != nil {
			return errors.New("write sanitized error event")
		}
	}
	return nil
}

func sanitizeHistoricalUsageEventsTx(ctx context.Context, tx *sql.Tx, db *DB) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT id, api_group_key, source, provider, endpoint, COALESCE(api_group_label, '')
		FROM usage_events`)
	if err != nil {
		return errors.New("read historical usage events")
	}
	defer rows.Close()

	type usageUpdate struct {
		id       int64
		groupKey string
		source   string
		label    string
	}
	updates := make([]usageUpdate, 0)
	for rows.Next() {
		var update usageUpdate
		var provider, endpoint, existingLabel string
		if err := rows.Scan(&update.id, &update.groupKey, &update.source, &provider, &endpoint, &existingLabel); err != nil {
			return errors.New("scan historical usage event")
		}
		update.groupKey, update.label = sanitizeHistoricalGroupKey(db, update.groupKey, provider, endpoint, existingLabel)
		update.source = sanitizeHistoricalSource(db, update.source)
		updates = append(updates, update)
	}
	if err := rows.Err(); err != nil {
		return errors.New("iterate historical usage events")
	}
	for _, update := range updates {
		if _, err := tx.ExecContext(ctx, `
			UPDATE usage_events
			SET api_group_key = ?, source = ?, api_group_label = ?
			WHERE id = ?`, update.groupKey, update.source, update.label, update.id); err != nil {
			return errors.New("write sanitized usage event")
		}
	}
	return nil
}

func sanitizeHistoricalGroupKey(db *DB, value, provider, endpoint, existingLabel string) (string, string) {
	value = strings.TrimSpace(value)
	provider = strings.TrimSpace(provider)
	label := safeHistoricalUsageLabel(existingLabel)
	if value == "" {
		if label == "" {
			label = "unknown"
		}
		return "unknown", label
	}
	if safeEndpoint := security.PublicEndpoint(value); safeEndpoint != "" {
		return safeEndpoint, "endpoint"
	}
	if provider != "" && value == provider && !strings.Contains(security.RedactText(provider), security.RedactedValue) {
		return provider, "provider"
	}
	if strings.HasPrefix(value, "hmac:") || value == security.RedactedValue {
		if label == "" {
			label = "api_key"
		}
		return value, label
	}
	if db != nil && db.cipher != nil {
		if fingerprint, err := db.cipher.Fingerprint("oh-my-cpa", "legacy-usage-api-group", value); err == nil && strings.TrimSpace(fingerprint) != "" {
			return fingerprint, "api_key"
		}
	}
	return security.RedactedValue, "api_key"
}

func sanitizeHistoricalSource(db *DB, value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, "hmac:") || value == security.RedactedValue {
		return value
	}
	if db != nil && db.cipher != nil {
		if fingerprint, err := db.cipher.Fingerprint("oh-my-cpa", "legacy-usage-source", value); err == nil && strings.TrimSpace(fingerprint) != "" {
			return fingerprint
		}
	}
	return security.RedactedValue
}

func safeHistoricalUsageLabel(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "api_key", "apikey":
		return "api_key"
	case "provider":
		return "provider"
	case "endpoint":
		return "endpoint"
	case "unknown":
		return "unknown"
	default:
		return ""
	}
}
