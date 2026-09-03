package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

var ErrNotFound = sql.ErrNoRows

type Repository struct {
	db *DB
}

func New(db *DB) *Repository {
	return &Repository{db: db}
}

func (r *Repository) SQL() *sql.DB {
	if r == nil || r.db == nil {
		return nil
	}
	return r.db.SQL
}

func (r *Repository) UpsertInstance(ctx context.Context, instance domain.CPAInstance) error {
	if r == nil || r.db == nil || r.db.SQL == nil {
		return errors.New("repository is not initialized")
	}
	_, err := r.db.SQL.ExecContext(ctx, `
		INSERT INTO cpa_instances (
			id, name, base_url, usage_addr, management_key_ciphertext,
			management_key_nonce, status, last_seen_at, last_error, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			name = excluded.name,
			base_url = excluded.base_url,
			usage_addr = excluded.usage_addr,
			management_key_ciphertext = excluded.management_key_ciphertext,
			management_key_nonce = excluded.management_key_nonce,
			updated_at = excluded.updated_at
	`, instance.ID, instance.Name, instance.BaseURL, instance.UsageAddr,
		instance.ManagementKeyCiphertext, instance.ManagementKeyNonce,
		instance.Status, unixOrNil(instance.LastSeenAt), nullableString(instance.LastError),
		instance.CreatedAt.Unix(), instance.UpdatedAt.Unix())
	if err != nil {
		return fmt.Errorf("upsert CPA instance: %w", err)
	}
	return nil
}

func (r *Repository) GetInstance(ctx context.Context, id string) (domain.CPAInstance, error) {
	if r == nil || r.db == nil || r.db.SQL == nil {
		return domain.CPAInstance{}, errors.New("repository is not initialized")
	}
	var instance domain.CPAInstance
	var lastSeen sql.NullInt64
	var lastError sql.NullString
	var createdAt, updatedAt int64
	err := r.db.SQL.QueryRowContext(ctx, `
		SELECT id, name, base_url, usage_addr, management_key_ciphertext,
		       management_key_nonce, status, last_seen_at, last_error, created_at, updated_at
		FROM cpa_instances WHERE id = ?
	`, id).Scan(
		&instance.ID, &instance.Name, &instance.BaseURL, &instance.UsageAddr,
		&instance.ManagementKeyCiphertext, &instance.ManagementKeyNonce,
		&instance.Status, &lastSeen, &lastError, &createdAt, &updatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.CPAInstance{}, fmt.Errorf("CPA instance %q: %w", id, sql.ErrNoRows)
		}
		return domain.CPAInstance{}, fmt.Errorf("get CPA instance: %w", err)
	}
	instance.LastSeenAt = timeFromNullInt64(lastSeen)
	instance.LastError = lastError.String
	instance.CreatedAt = time.Unix(createdAt, 0).UTC()
	instance.UpdatedAt = time.Unix(updatedAt, 0).UTC()
	return instance, nil
}

func (r *Repository) UpdateInstanceStatus(ctx context.Context, id, status, lastError string, seenAt *time.Time) error {
	if r == nil || r.db == nil || r.db.SQL == nil {
		return errors.New("repository is not initialized")
	}
	_, err := r.db.SQL.ExecContext(ctx, `
		UPDATE cpa_instances
		SET status = ?, last_error = ?, last_seen_at = ?, updated_at = ?
		WHERE id = ?
	`, status, nullableString(lastError), unixOrNil(seenAt), time.Now().Unix(), id)
	if err != nil {
		return fmt.Errorf("update CPA instance status: %w", err)
	}
	return nil
}

func (r *Repository) UpsertDiscoveredResources(ctx context.Context, instanceID string, resources []domain.DiscoveredResource, discoveredAt time.Time, markMissing bool) ([]domain.DiscoveredResource, error) {
	if r == nil || r.db == nil || r.db.SQL == nil {
		return nil, errors.New("repository is not initialized")
	}
	if discoveredAt.IsZero() {
		discoveredAt = time.Now().UTC()
	}

	tx, err := r.db.SQL.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("begin resource discovery transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	seenKeys := make([]string, 0, len(resources))
	stored := make([]domain.DiscoveredResource, 0, len(resources))
	for _, resource := range resources {
		resource.InstanceID = instanceID
		resource.LastSeenAt = discoveredAt
		resource.UpdatedAt = discoveredAt
		if resource.CreatedAt.IsZero() {
			resource.CreatedAt = discoveredAt
		}
		if strings.TrimSpace(resource.ResourceKey) == "" {
			return nil, errors.New("discovered resource has empty resource key")
		}
		seenKeys = append(seenKeys, resource.ResourceKey)
		var existingID string
		rowErr := tx.QueryRowContext(ctx, `
			SELECT id FROM discovered_resources WHERE instance_id = ? AND resource_key = ?
		`, instanceID, resource.ResourceKey).Scan(&existingID)
		switch {
		case errors.Is(rowErr, sql.ErrNoRows):
			resource.ID = uuid.NewString()
		case rowErr != nil:
			return nil, fmt.Errorf("find discovered resource %q: %w", resource.ResourceKey, rowErr)
		default:
			resource.ID = existingID
		}
		if resource.ID == "" {
			resource.ID = uuid.NewString()
		}
		resource.Details = sanitizeResourceDetails(resource.Details)
		details, marshalErr := json.Marshal(resource.Details)
		if marshalErr != nil {
			return nil, fmt.Errorf("marshal resource details: %w", marshalErr)
		}
		createdAt := resource.CreatedAt.Unix()
		if createdAt <= 0 {
			createdAt = discoveredAt.Unix()
		}
		_, execErr := tx.ExecContext(ctx, `
			INSERT INTO discovered_resources (
				id, instance_id, resource_key, cpa_resource_type, cpa_auth_index,
				cpa_resource_name, cpa_driver, protocol_driver, protocol_display,
				base_url, suggested_source, suggested_plan, status, details_json,
				last_seen_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(instance_id, resource_key) DO UPDATE SET
				cpa_resource_type = excluded.cpa_resource_type,
				cpa_auth_index = excluded.cpa_auth_index,
				cpa_resource_name = excluded.cpa_resource_name,
				cpa_driver = excluded.cpa_driver,
				protocol_driver = excluded.protocol_driver,
				protocol_display = excluded.protocol_display,
				base_url = excluded.base_url,
				suggested_source = excluded.suggested_source,
				suggested_plan = excluded.suggested_plan,
				details_json = excluded.details_json,
				last_seen_at = excluded.last_seen_at,
				updated_at = excluded.updated_at,
				status = CASE
					WHEN discovered_resources.status = 'missing' THEN excluded.status
					ELSE discovered_resources.status
				END
		`, resource.ID, instanceID, resource.ResourceKey, resource.CPAResourceType,
			nullableString(resource.CPAAuthIndex), nullableString(resource.CPAResourceName),
			resource.CPADriver, resource.ProtocolDriver, resource.ProtocolDisplay,
			nullableString(resource.BaseURL), nullableString(resource.SuggestedSource),
			nullableString(resource.SuggestedPlan), resource.Status, string(details),
			discoveredAt.Unix(), createdAt, discoveredAt.Unix())
		if execErr != nil {
			return nil, fmt.Errorf("upsert discovered resource %q: %w", resource.ResourceKey, execErr)
		}
		stored = append(stored, resource)
	}

	if markMissing {
		if len(seenKeys) == 0 {
			if _, err := tx.ExecContext(ctx, `
				UPDATE discovered_resources SET status = 'missing', updated_at = ?
				WHERE instance_id = ? AND status <> 'missing'
			`, discoveredAt.Unix(), instanceID); err != nil {
				return nil, fmt.Errorf("mark missing resources: %w", err)
			}
		} else {
			placeholders := strings.TrimRight(strings.Repeat("?,", len(seenKeys)), ",")
			args := make([]any, 0, len(seenKeys)+2)
			args = append(args, discoveredAt.Unix(), instanceID)
			for _, key := range seenKeys {
				args = append(args, key)
			}
			query := fmt.Sprintf(`
				UPDATE discovered_resources SET status = 'missing', updated_at = ?
				WHERE instance_id = ? AND resource_key NOT IN (%s) AND status <> 'missing'
			`, placeholders)
			if _, err := tx.ExecContext(ctx, query, args...); err != nil {
				return nil, fmt.Errorf("mark missing resources: %w", err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit resource discovery: %w", err)
	}
	return stored, nil
}

func (r *Repository) ListResources(ctx context.Context, status string) ([]domain.DiscoveredResource, error) {
	if r == nil || r.db == nil || r.db.SQL == nil {
		return nil, errors.New("repository is not initialized")
	}
	query := `
		SELECT d.id, d.instance_id, d.resource_key, d.cpa_resource_type,
		       d.cpa_auth_index, d.cpa_resource_name, d.cpa_driver,
		       d.protocol_driver, d.protocol_display, d.base_url,
		       d.suggested_source, d.suggested_plan, d.status, d.details_json,
		       d.last_seen_at, d.created_at, d.updated_at,
		       o.display_name, o.color, o.icon_ref, o.notes
		FROM discovered_resources d
		LEFT JOIN resource_overrides o ON o.resource_id = d.id
	`
	args := []any{}
	if strings.TrimSpace(status) != "" {
		if !domain.ResourceStatus(status).Valid() {
			return nil, fmt.Errorf("invalid resource status %q", status)
		}
		query += " WHERE d.status = ?"
		args = append(args, status)
	}
	query += " ORDER BY COALESCE(NULLIF(o.display_name, ''), d.suggested_source, d.cpa_resource_name, d.base_url, d.cpa_driver) COLLATE NOCASE"
	rows, err := r.db.SQL.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list discovered resources: %w", err)
	}
	defer rows.Close()
	resources := make([]domain.DiscoveredResource, 0)
	for rows.Next() {
		resource, err := scanResource(rows)
		if err != nil {
			return nil, err
		}
		resources = append(resources, resource)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate discovered resources: %w", err)
	}
	return resources, nil
}

func (r *Repository) GetResource(ctx context.Context, id string) (domain.DiscoveredResource, error) {
	if r == nil || r.db == nil || r.db.SQL == nil {
		return domain.DiscoveredResource{}, errors.New("repository is not initialized")
	}
	row := r.db.SQL.QueryRowContext(ctx, `
		SELECT d.id, d.instance_id, d.resource_key, d.cpa_resource_type,
		       d.cpa_auth_index, d.cpa_resource_name, d.cpa_driver,
		       d.protocol_driver, d.protocol_display, d.base_url,
		       d.suggested_source, d.suggested_plan, d.status, d.details_json,
		       d.last_seen_at, d.created_at, d.updated_at,
		       o.display_name, o.color, o.icon_ref, o.notes
		FROM discovered_resources d
		LEFT JOIN resource_overrides o ON o.resource_id = d.id
		WHERE d.id = ?
	`, id)
	resource, err := scanResource(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.DiscoveredResource{}, fmt.Errorf("resource %q: %w", id, sql.ErrNoRows)
		}
		return domain.DiscoveredResource{}, err
	}
	return resource, nil
}

func (r *Repository) UpdateResourceOverride(ctx context.Context, id string, override domain.ResourceOverride) (domain.DiscoveredResource, error) {
	if r == nil || r.db == nil || r.db.SQL == nil {
		return domain.DiscoveredResource{}, errors.New("repository is not initialized")
	}
	if override.StatusSet && (override.Status == nil || !override.Status.Valid()) {
		return domain.DiscoveredResource{}, fmt.Errorf("invalid resource status")
	}
	tx, err := r.db.SQL.BeginTx(ctx, nil)
	if err != nil {
		return domain.DiscoveredResource{}, fmt.Errorf("begin resource override transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var current domain.DiscoveredResource
	row := tx.QueryRowContext(ctx, `
		SELECT d.id, d.instance_id, d.resource_key, d.cpa_resource_type,
		       d.cpa_auth_index, d.cpa_resource_name, d.cpa_driver,
		       d.protocol_driver, d.protocol_display, d.base_url,
		       d.suggested_source, d.suggested_plan, d.status, d.details_json,
		       d.last_seen_at, d.created_at, d.updated_at,
		       o.display_name, o.color, o.icon_ref, o.notes
		FROM discovered_resources d
		LEFT JOIN resource_overrides o ON o.resource_id = d.id
		WHERE d.id = ?
	`, id)
	current, err = scanResource(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.DiscoveredResource{}, fmt.Errorf("resource %q: %w", id, sql.ErrNoRows)
		}
		return domain.DiscoveredResource{}, fmt.Errorf("load resource override target: %w", err)
	}

	if override.DisplayNameSet {
		current.CustomDisplayName = normalizedPointer(override.DisplayName)
	}
	if override.ColorSet {
		current.Color = normalizedPointer(override.Color)
	}
	if override.IconRefSet {
		current.IconRef = normalizedPointer(override.IconRef)
	}
	if override.NotesSet {
		current.Notes = normalizedPointer(override.Notes)
	}
	now := time.Now().Unix()
	if override.DisplayNameSet || override.ColorSet || override.IconRefSet || override.NotesSet {
		_, err = tx.ExecContext(ctx, `
			INSERT INTO resource_overrides(resource_id, display_name, color, icon_ref, notes, updated_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT(resource_id) DO UPDATE SET
				display_name = excluded.display_name,
				color = excluded.color,
				icon_ref = excluded.icon_ref,
				notes = excluded.notes,
				updated_at = excluded.updated_at
		`, id, nullableStringPtr(current.CustomDisplayName), nullableStringPtr(current.Color),
			nullableStringPtr(current.IconRef), nullableStringPtr(current.Notes), now)
		if err != nil {
			return domain.DiscoveredResource{}, fmt.Errorf("save resource override: %w", err)
		}
	}
	if override.StatusSet {
		_, err = tx.ExecContext(ctx, `UPDATE discovered_resources SET status = ?, updated_at = ? WHERE id = ?`, *override.Status, now, id)
		if err != nil {
			return domain.DiscoveredResource{}, fmt.Errorf("update resource status: %w", err)
		}
		current.Status = *override.Status
	}
	if err := tx.Commit(); err != nil {
		return domain.DiscoveredResource{}, fmt.Errorf("commit resource override: %w", err)
	}
	return r.GetResource(ctx, id)
}

func scanResource(scanner interface{ Scan(dest ...any) error }) (domain.DiscoveredResource, error) {
	var resource domain.DiscoveredResource
	var authIndex, resourceName, baseURL, suggestedSource, suggestedPlan sql.NullString
	var detailsJSON sql.NullString
	var displayName, color, iconRef, notes sql.NullString
	var status string
	var lastSeen, createdAt, updatedAt int64
	if err := scanner.Scan(
		&resource.ID, &resource.InstanceID, &resource.ResourceKey, &resource.CPAResourceType,
		&authIndex, &resourceName, &resource.CPADriver, &resource.ProtocolDriver,
		&resource.ProtocolDisplay, &baseURL, &suggestedSource, &suggestedPlan,
		&status, &detailsJSON, &lastSeen, &createdAt, &updatedAt,
		&displayName, &color, &iconRef, &notes,
	); err != nil {
		return domain.DiscoveredResource{}, err
	}
	resource.CPAAuthIndex = authIndex.String
	resource.CPAResourceName = resourceName.String
	resource.BaseURL = baseURL.String
	resource.SuggestedSource = suggestedSource.String
	resource.SuggestedPlan = suggestedPlan.String
	resource.Status = domain.ResourceStatus(status)
	resource.LastSeenAt = time.Unix(lastSeen, 0).UTC()
	resource.CreatedAt = time.Unix(createdAt, 0).UTC()
	resource.UpdatedAt = time.Unix(updatedAt, 0).UTC()
	if detailsJSON.Valid && strings.TrimSpace(detailsJSON.String) != "" {
		if err := json.Unmarshal([]byte(detailsJSON.String), &resource.Details); err != nil {
			return domain.DiscoveredResource{}, fmt.Errorf("decode resource details %q: %w", resource.ID, err)
		}
		resource.Details = sanitizeResourceDetails(resource.Details)
	}
	resource.CustomDisplayName = nullableStringPointer(displayName)
	resource.Color = nullableStringPointer(color)
	resource.IconRef = nullableStringPointer(iconRef)
	resource.Notes = nullableStringPointer(notes)
	resource.DisplayName = firstNonEmpty(displayName.String, resource.SuggestedSource, resource.CPAResourceName, resource.BaseURL, resource.CPADriver)
	return resource, nil
}

func sanitizeResourceDetails(details domain.ResourceDetails) domain.ResourceDetails {
	// ResourceDetails is a persistence model, not a pass-through envelope for
	// CPA management responses. Keep only fields the current resource UI uses
	// and a small, reviewed set of boolean observations.
	result := domain.ResourceDetails{
		Models:      append([]string(nil), details.Models...),
		AuthType:    safeResourceAuthType(details.AuthType),
		Priority:    details.Priority,
		Disabled:    details.Disabled,
		Unavailable: details.Unavailable,
	}
	if len(result.Models) == 0 {
		result.Models = nil
	}
	if result.AuthType == "" {
		result.AuthType = "unknown"
	}
	allowed := map[string]struct{}{
		"account_present":    {},
		"account_type":       {},
		"api_key_present":    {},
		"identity_collision": {},
		"proxy_configured":   {},
	}
	for key, value := range details.Extra {
		if _, ok := allowed[key]; !ok {
			continue
		}
		if security.IsSensitiveKey(key) || strings.TrimSpace(value) == "" {
			continue
		}
		if key == "account_type" {
			value = safeResourceAccountType(value)
		}
		if value != "true" && value != "false" && key != "account_type" {
			continue
		}
		result.Extra = ensureExtra(result.Extra)
		result.Extra[key] = value
	}
	if len(result.Extra) == 0 {
		result.Extra = nil
	}
	return result
}

func ensureExtra(extra map[string]string) map[string]string {
	if extra == nil {
		return make(map[string]string)
	}
	return extra
}

func safeResourceAuthType(value string) string {
	switch value = strings.ToLower(strings.TrimSpace(value)); value {
	case "oauth", "api_key", "apikey", "service_account":
		return value
	default:
		return "unknown"
	}
}

func safeResourceAccountType(value string) string {
	switch value = strings.ToLower(strings.TrimSpace(value)); value {
	case "oauth", "api_key", "apikey", "service_account", "service-account":
		return value
	default:
		return "other"
	}
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func nullableStringPtr(value *string) any {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	return strings.TrimSpace(*value)
}

func normalizedPointer(value *string) *string {
	if value == nil || strings.TrimSpace(*value) == "" {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	return &trimmed
}

func nullableStringPointer(value sql.NullString) *string {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return nil
	}
	copy := value.String
	return &copy
}

func unixOrNil(value *time.Time) any {
	if value == nil || value.IsZero() {
		return nil
	}
	return value.Unix()
}

func timeFromNullInt64(value sql.NullInt64) *time.Time {
	if !value.Valid {
		return nil
	}
	result := time.Unix(value.Int64, 0).UTC()
	return &result
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return "Unnamed CPA resource"
}
