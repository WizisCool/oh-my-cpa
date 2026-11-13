package repository

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// ArchivedCredential holds the non-secret presentation metadata recorded for a
// runtime credential index across disable, key-rotation, and deletion lifecycles.
type ArchivedCredential struct {
	AuthIndex      string `json:"auth_index"`
	Kind           string `json:"kind"`
	ProviderKey    string `json:"provider_key,omitempty"`
	OAuthProvider  string `json:"oauth_provider,omitempty"`
	ProviderFamily string `json:"provider_family,omitempty"`
	ProviderName   string `json:"provider_name,omitempty"`
	UpstreamName   string `json:"upstream_name,omitempty"`
	BaseURL        string `json:"base_url,omitempty"`
	IconID         string `json:"icon_id,omitempty"`
	FileName       string `json:"file_name,omitempty"`
	DisplayName    string `json:"display_name,omitempty"`
	MaskedAccount  string `json:"masked_account,omitempty"`
	KeyMask        string `json:"key_mask,omitempty"`
	KeyFingerprint string `json:"-"`
	IsAmbiguous    bool   `json:"is_ambiguous,omitempty"`
	UpdatedAtMS    int64  `json:"updated_at_ms,omitempty"`
}

// ArchivedProvider holds the non-secret presentation metadata recorded for an
// upstream provider key (such as openai-compatible-<name>) or an OAuth plugin portal.
type ArchivedProvider struct {
	ProviderKey   string `json:"provider_key"`
	Kind          string `json:"kind"`
	Name          string `json:"name,omitempty"`
	UpstreamName  string `json:"upstream_name,omitempty"`
	Family        string `json:"family,omitempty"`
	BaseURL       string `json:"base_url,omitempty"`
	IconID        string `json:"icon_id,omitempty"`
	Logo          string `json:"logo,omitempty"`
	IsMultiPortal bool   `json:"is_multi_portal,omitempty"`
	IsPluginOwned bool   `json:"is_plugin_owned,omitempty"`
	IsAmbiguous   bool   `json:"is_ambiguous,omitempty"`
	UpdatedAtMS   int64  `json:"updated_at_ms,omitempty"`
}

func sanitizeArchivedCredential(entry ArchivedCredential) (ArchivedCredential, bool) {
	entry.AuthIndex = boundedArchiveString(entry.AuthIndex, 256)
	if entry.AuthIndex == "" {
		return ArchivedCredential{}, false
	}
	switch strings.ToLower(strings.TrimSpace(entry.Kind)) {
	case "oauth":
		entry.Kind = "oauth"
	case "apikey", "api_key":
		entry.Kind = "apikey"
	default:
		return ArchivedCredential{}, false
	}
	entry.ProviderKey = strings.ToLower(boundedArchiveString(entry.ProviderKey, 256))
	entry.OAuthProvider = strings.ToLower(boundedArchiveString(entry.OAuthProvider, 256))
	entry.ProviderFamily = strings.ToLower(boundedArchiveString(entry.ProviderFamily, 128))
	entry.ProviderName = boundedArchiveString(entry.ProviderName, 256)
	entry.UpstreamName = boundedArchiveString(entry.UpstreamName, 256)
	entry.BaseURL = security.PublicURL(entry.BaseURL)
	entry.IconID = boundedArchiveString(entry.IconID, 256)
	entry.DisplayName = boundedArchiveString(entry.DisplayName, MaxCredentialDisplayNameLength)
	entry.MaskedAccount = boundedArchiveString(security.MaskAccount(entry.MaskedAccount), 256)
	entry.FileName = boundedArchiveString(security.MaskEmailAddresses(entry.FileName), 256)

	mask := security.NormalizeMask(entry.KeyMask)
	if mask != "" && !security.IsMask(mask) {
		mask = ""
	}
	entry.KeyMask = mask

	fp := strings.TrimSpace(entry.KeyFingerprint)
	if fp != "" && !strings.HasPrefix(fp, "hmac:") {
		fp = ""
	}
	entry.KeyFingerprint = fp
	return entry, true
}

func sanitizeArchivedProvider(entry ArchivedProvider) (ArchivedProvider, bool) {
	entry.ProviderKey = strings.ToLower(boundedArchiveString(entry.ProviderKey, 256))
	if entry.ProviderKey == "" {
		return ArchivedProvider{}, false
	}
	switch strings.ToLower(strings.TrimSpace(entry.Kind)) {
	case "ai_provider":
		entry.Kind = "ai_provider"
	case "oauth_plugin":
		entry.Kind = "oauth_plugin"
	default:
		return ArchivedProvider{}, false
	}
	entry.Name = boundedArchiveString(entry.Name, 256)
	entry.UpstreamName = boundedArchiveString(entry.UpstreamName, 256)
	entry.Family = strings.ToLower(boundedArchiveString(entry.Family, 128))
	entry.BaseURL = security.PublicURL(entry.BaseURL)
	entry.IconID = boundedArchiveString(entry.IconID, 256)
	logo := strings.TrimSpace(entry.Logo)
	if len(logo) > 768*1024 {
		logo = ""
	}
	entry.Logo = logo
	return entry, true
}

func boundedArchiveString(raw string, limit int) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	runes := []rune(trimmed)
	if len(runes) > limit {
		return string(runes[:limit])
	}
	return trimmed
}

// UpsertArchivedCredentials records sanitized credential presentation metadata.
func (r *Repository) UpsertArchivedCredentials(ctx context.Context, instanceID string, entries []ArchivedCredential) error {
	if r == nil || r.SQL() == nil || strings.TrimSpace(instanceID) == "" || len(entries) == 0 {
		return nil
	}
	sanitized := make([]ArchivedCredential, 0, len(entries))
	for _, entry := range entries {
		if clean, ok := sanitizeArchivedCredential(entry); ok {
			sanitized = append(sanitized, clean)
		}
	}
	if len(sanitized) == 0 {
		return nil
	}
	nowMS := time.Now().UnixMilli()
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin archived credentials upsert: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	conflictGuard := `(archived_credentials.is_ambiguous = 1
		OR excluded.is_ambiguous = 1
		OR archived_credentials.kind <> excluded.kind
		OR (archived_credentials.provider_family <> '' AND excluded.provider_family <> '' AND archived_credentials.provider_family <> excluded.provider_family)
		OR (archived_credentials.provider_key <> '' AND excluded.provider_key <> '' AND archived_credentials.provider_key <> excluded.provider_key))`

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO archived_credentials (
			instance_id, auth_index, kind, provider_key, oauth_provider, provider_family,
			provider_name, upstream_name, base_url, icon_id, file_name, display_name,
			masked_account, key_mask, key_fingerprint, is_ambiguous, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (instance_id, auth_index) DO UPDATE SET
			is_ambiguous = CASE WHEN `+conflictGuard+` THEN 1 ELSE 0 END,
			kind = CASE WHEN `+conflictGuard+` THEN archived_credentials.kind ELSE excluded.kind END,
			provider_key = CASE
				WHEN `+conflictGuard+` THEN ''
				WHEN excluded.provider_key <> '' THEN excluded.provider_key
				ELSE archived_credentials.provider_key
			END,
			oauth_provider = CASE
				WHEN `+conflictGuard+` THEN ''
				WHEN excluded.kind = 'oauth' THEN excluded.oauth_provider
				ELSE ''
			END,
			provider_family = CASE
				WHEN `+conflictGuard+` THEN ''
				WHEN excluded.provider_family <> '' THEN excluded.provider_family
				ELSE archived_credentials.provider_family
			END,
			provider_name = CASE
				WHEN `+conflictGuard+` THEN ''
				WHEN excluded.kind = 'apikey' THEN excluded.provider_name
				ELSE ''
			END,
			upstream_name = CASE
				WHEN `+conflictGuard+` THEN ''
				WHEN excluded.kind = 'apikey' AND excluded.upstream_name <> '' THEN excluded.upstream_name
				WHEN excluded.kind = 'apikey' THEN archived_credentials.upstream_name
				ELSE ''
			END,
			base_url = CASE
				WHEN `+conflictGuard+` THEN ''
				WHEN excluded.kind = 'apikey' AND excluded.base_url <> '' THEN excluded.base_url
				WHEN excluded.kind = 'apikey' THEN archived_credentials.base_url
				ELSE ''
			END,
			icon_id = CASE
				WHEN `+conflictGuard+` THEN ''
				WHEN excluded.kind = 'apikey' THEN excluded.icon_id
				ELSE ''
			END,
			file_name = CASE
				WHEN `+conflictGuard+` THEN ''
				WHEN excluded.kind = 'oauth' AND excluded.file_name <> '' THEN excluded.file_name
				WHEN excluded.kind = 'oauth' THEN archived_credentials.file_name
				ELSE ''
			END,
			display_name = CASE
				WHEN `+conflictGuard+` THEN ''
				WHEN excluded.kind = 'oauth' THEN excluded.display_name
				ELSE ''
			END,
			masked_account = CASE
				WHEN `+conflictGuard+` THEN ''
				WHEN excluded.kind = 'oauth' AND excluded.masked_account <> '' THEN excluded.masked_account
				WHEN excluded.kind = 'oauth' THEN archived_credentials.masked_account
				ELSE ''
			END,
			key_mask = CASE
				WHEN `+conflictGuard+` THEN ''
				WHEN excluded.kind = 'apikey' AND excluded.key_mask <> '' THEN excluded.key_mask
				WHEN excluded.kind = 'apikey' THEN archived_credentials.key_mask
				ELSE ''
			END,
			key_fingerprint = CASE
				WHEN `+conflictGuard+` THEN ''
				WHEN excluded.kind = 'apikey' AND excluded.key_fingerprint <> '' THEN excluded.key_fingerprint
				WHEN excluded.kind = 'apikey' THEN archived_credentials.key_fingerprint
				ELSE ''
			END,
			updated_at_ms = excluded.updated_at_ms
	`)
	if err != nil {
		return fmt.Errorf("prepare archived credentials upsert: %w", err)
	}
	defer stmt.Close()

	for _, entry := range sanitized {
		ambiguous := 0
		if entry.IsAmbiguous {
			ambiguous = 1
		}
		ts := entry.UpdatedAtMS
		if ts <= 0 {
			ts = nowMS
		}
		if _, err := stmt.ExecContext(ctx,
			instanceID, entry.AuthIndex, entry.Kind, entry.ProviderKey, entry.OAuthProvider,
			entry.ProviderFamily, entry.ProviderName, entry.UpstreamName, entry.BaseURL,
			entry.IconID, entry.FileName, entry.DisplayName, entry.MaskedAccount,
			entry.KeyMask, entry.KeyFingerprint, ambiguous, ts,
		); err != nil {
			return fmt.Errorf("upsert archived credential %q: %w", entry.AuthIndex, err)
		}
	}
	return tx.Commit()
}

// UpsertArchivedProviders records sanitized provider and plugin-portal presentation metadata.
func (r *Repository) UpsertArchivedProviders(ctx context.Context, instanceID string, entries []ArchivedProvider) error {
	if r == nil || r.SQL() == nil || strings.TrimSpace(instanceID) == "" || len(entries) == 0 {
		return nil
	}
	sanitized := make([]ArchivedProvider, 0, len(entries))
	for _, entry := range entries {
		if clean, ok := sanitizeArchivedProvider(entry); ok {
			sanitized = append(sanitized, clean)
		}
	}
	if len(sanitized) == 0 {
		return nil
	}
	nowMS := time.Now().UnixMilli()
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin archived providers upsert: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	provConflictGuard := `(archived_providers.is_ambiguous = 1
		OR excluded.is_ambiguous = 1
		OR archived_providers.kind <> excluded.kind)`

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO archived_providers (
			instance_id, provider_key, kind, name, upstream_name, family,
			base_url, icon_id, logo, is_multi_portal, is_plugin_owned, is_ambiguous, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (instance_id, provider_key) DO UPDATE SET
			is_ambiguous = CASE WHEN `+provConflictGuard+` THEN 1 ELSE 0 END,
			kind = CASE WHEN `+provConflictGuard+` THEN archived_providers.kind ELSE excluded.kind END,
			name = CASE
				WHEN `+provConflictGuard+` THEN ''
				WHEN excluded.name <> '' THEN excluded.name
				ELSE archived_providers.name
			END,
			upstream_name = CASE
				WHEN `+provConflictGuard+` THEN ''
				WHEN excluded.upstream_name <> '' THEN excluded.upstream_name
				ELSE archived_providers.upstream_name
			END,
			family = CASE
				WHEN `+provConflictGuard+` THEN ''
				WHEN excluded.family <> '' THEN excluded.family
				ELSE archived_providers.family
			END,
			base_url = CASE
				WHEN `+provConflictGuard+` THEN ''
				WHEN excluded.base_url <> '' THEN excluded.base_url
				ELSE archived_providers.base_url
			END,
			icon_id = CASE WHEN `+provConflictGuard+` THEN '' ELSE excluded.icon_id END,
			logo = CASE
				WHEN `+provConflictGuard+` THEN ''
				WHEN excluded.logo <> '' THEN excluded.logo
				ELSE archived_providers.logo
			END,
			is_multi_portal = CASE WHEN `+provConflictGuard+` THEN 0 ELSE excluded.is_multi_portal END,
			is_plugin_owned = CASE WHEN `+provConflictGuard+` THEN 0 ELSE excluded.is_plugin_owned END,
			updated_at_ms = excluded.updated_at_ms
	`)
	if err != nil {
		return fmt.Errorf("prepare archived providers upsert: %w", err)
	}
	defer stmt.Close()

	for _, entry := range sanitized {
		multiPortal := 0
		if entry.IsMultiPortal {
			multiPortal = 1
		}
		pluginOwned := 0
		if entry.IsPluginOwned {
			pluginOwned = 1
		}
		ambiguous := 0
		if entry.IsAmbiguous {
			ambiguous = 1
		}
		ts := entry.UpdatedAtMS
		if ts <= 0 {
			ts = nowMS
		}
		if _, err := stmt.ExecContext(ctx,
			instanceID, entry.ProviderKey, entry.Kind, entry.Name, entry.UpstreamName,
			entry.Family, entry.BaseURL, entry.IconID, entry.Logo,
			multiPortal, pluginOwned, ambiguous, ts,
		); err != nil {
			return fmt.Errorf("upsert archived provider %q: %w", entry.ProviderKey, err)
		}
	}
	return tx.Commit()
}

// ResolveArchivedAuthIndexesByFingerprints maps keyed-HMAC provider key fingerprints
// back to all verified runtime auth_index generations belonging to that exact provider
// identity (ordered newest first) so disabled OpenAI-compatible providers retain both
// current and prior-generation traffic/key attribution across repeated disable/re-enable
// cycles while still refusing competing claims from distinct provider identities.
func (r *Repository) ResolveArchivedAuthIndexesByFingerprints(
	ctx context.Context,
	instanceID string,
	fingerprints []string,
) (map[string][]string, error) {
	result := make(map[string][]string)
	if r == nil || r.SQL() == nil || strings.TrimSpace(instanceID) == "" || len(fingerprints) == 0 {
		return result, nil
	}
	unique := make([]string, 0, len(fingerprints))
	seen := make(map[string]struct{}, len(fingerprints))
	for _, fp := range fingerprints {
		trimmed := strings.TrimSpace(fp)
		if trimmed == "" || !strings.HasPrefix(trimmed, "hmac:") {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		unique = append(unique, trimmed)
	}
	if len(unique) == 0 {
		return result, nil
	}
	type fpIdentity struct {
		family      string
		providerKey string
	}
	identities := make(map[string]fpIdentity)
	ambiguous := make(map[string]bool)
	for start := 0; start < len(unique); start += maxSQLiteParameters {
		chunk := unique[start:min(start+maxSQLiteParameters, len(unique))]
		args := make([]any, 0, 1+len(chunk))
		args = append(args, instanceID)
		for _, fp := range chunk {
			args = append(args, fp)
		}
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		rows, err := r.SQL().QueryContext(ctx, `
			SELECT key_fingerprint, auth_index, provider_family, provider_key, is_ambiguous
			FROM archived_credentials
			WHERE instance_id = ? AND kind = 'apikey' AND key_fingerprint IN (`+placeholders+`)
			ORDER BY updated_at_ms DESC, auth_index DESC`, args...)
		if err != nil {
			return nil, fmt.Errorf("query archived key fingerprints: %w", err)
		}
		for rows.Next() {
			var fp, authIndex, family, providerKey string
			var isAmb int
			if errScan := rows.Scan(&fp, &authIndex, &family, &providerKey, &isAmb); errScan != nil {
				rows.Close()
				return nil, fmt.Errorf("scan archived key fingerprint: %w", errScan)
			}
			if isAmb == 1 || ambiguous[fp] {
				delete(result, fp)
				ambiguous[fp] = true
				continue
			}
			ident := fpIdentity{family: family, providerKey: providerKey}
			if prev, exists := identities[fp]; exists && prev != ident {
				delete(result, fp)
				ambiguous[fp] = true
				continue
			}
			identities[fp] = ident
			if !slices.Contains(result[fp], authIndex) {
				result[fp] = append(result[fp], authIndex)
			}
		}
		errRows := rows.Err()
		rows.Close()
		if errRows != nil {
			return nil, fmt.Errorf("iterate archived key fingerprints: %w", errRows)
		}
	}
	return result, nil
}

// SetArchivedCredentialDisplayName updates the stored operator display name on an
// archived OAuth credential identified by its auth_index.
func (r *Repository) SetArchivedCredentialDisplayName(ctx context.Context, instanceID, authIndex, displayName string) error {
	if r == nil || r.SQL() == nil || strings.TrimSpace(instanceID) == "" || strings.TrimSpace(authIndex) == "" {
		return nil
	}
	cleanName := boundedArchiveString(displayName, MaxCredentialDisplayNameLength)
	_, err := r.SQL().ExecContext(ctx, `
		UPDATE archived_credentials
		SET display_name = ?, updated_at_ms = ?
		WHERE instance_id = ? AND auth_index = ? AND kind = 'oauth'`,
		cleanName, time.Now().UnixMilli(), instanceID, strings.TrimSpace(authIndex),
	)
	return err
}

// ListIdentityArchive returns all archived credentials and providers for instanceID,
// augmented with read-time historical fallbacks synthesized from pre-existing tables
// (discovered_resources, credential_display_names, resource_overrides, warmup tasks,
// and quota_snapshots) for credentials removed before the archive table existed.
func (r *Repository) ListIdentityArchive(ctx context.Context, instanceID string) ([]ArchivedCredential, []ArchivedProvider, error) {
	if r == nil || r.SQL() == nil || strings.TrimSpace(instanceID) == "" {
		return []ArchivedCredential{}, []ArchivedProvider{}, nil
	}

	credByIndex := make(map[string]ArchivedCredential)
	credRows, err := r.SQL().QueryContext(ctx, `
		SELECT auth_index, kind, provider_key, oauth_provider, provider_family,
		       provider_name, upstream_name, base_url, icon_id, file_name,
		       display_name, masked_account, key_mask, is_ambiguous, updated_at_ms
		FROM archived_credentials
		WHERE instance_id = ?`, instanceID)
	if err != nil {
		return nil, nil, fmt.Errorf("list archived credentials: %w", err)
	}
	for credRows.Next() {
		var item ArchivedCredential
		var isAmb int
		if errScan := credRows.Scan(
			&item.AuthIndex, &item.Kind, &item.ProviderKey, &item.OAuthProvider, &item.ProviderFamily,
			&item.ProviderName, &item.UpstreamName, &item.BaseURL, &item.IconID, &item.FileName,
			&item.DisplayName, &item.MaskedAccount, &item.KeyMask, &isAmb, &item.UpdatedAtMS,
		); errScan != nil {
			credRows.Close()
			return nil, nil, fmt.Errorf("scan archived credential: %w", errScan)
		}
		item.IsAmbiguous = isAmb == 1
		credByIndex[item.AuthIndex] = item
	}
	if errRows := credRows.Err(); errRows != nil {
		credRows.Close()
		return nil, nil, fmt.Errorf("iterate archived credentials: %w", errRows)
	}
	credRows.Close()

	// Synthesize pre-archive fallbacks from discovered_resources, warmup tasks, and quota_snapshots
	// without mutating the database on read paths.
	r.mergeDiscoveredResourceFallbacks(ctx, instanceID, credByIndex)
	r.mergeWarmupTaskFallbacks(ctx, instanceID, credByIndex)
	r.mergeQuotaSnapshotFallbacks(ctx, credByIndex)

	credentials := make([]ArchivedCredential, 0, len(credByIndex))
	for _, item := range credByIndex {
		credentials = append(credentials, item)
	}
	sort.Slice(credentials, func(i, j int) bool {
		return credentials[i].AuthIndex < credentials[j].AuthIndex
	})

	provRows, err := r.SQL().QueryContext(ctx, `
		SELECT provider_key, kind, name, upstream_name, family, base_url,
		       icon_id, logo, is_multi_portal, is_plugin_owned, is_ambiguous, updated_at_ms
		FROM archived_providers
		WHERE instance_id = ?
		ORDER BY provider_key ASC`, instanceID)
	if err != nil {
		return nil, nil, fmt.Errorf("list archived providers: %w", err)
	}
	defer provRows.Close()

	providers := make([]ArchivedProvider, 0)
	for provRows.Next() {
		var item ArchivedProvider
		var multiPortal, pluginOwned, isAmb int
		if errScan := provRows.Scan(
			&item.ProviderKey, &item.Kind, &item.Name, &item.UpstreamName, &item.Family, &item.BaseURL,
			&item.IconID, &item.Logo, &multiPortal, &pluginOwned, &isAmb, &item.UpdatedAtMS,
		); errScan != nil {
			return nil, nil, fmt.Errorf("scan archived provider: %w", errScan)
		}
		item.IsMultiPortal = multiPortal == 1
		item.IsPluginOwned = pluginOwned == 1
		item.IsAmbiguous = isAmb == 1
		providers = append(providers, item)
	}
	if errRows := provRows.Err(); errRows != nil {
		return nil, nil, fmt.Errorf("iterate archived providers: %w", errRows)
	}

	return credentials, providers, nil
}

func (r *Repository) mergeDiscoveredResourceFallbacks(
	ctx context.Context,
	instanceID string,
	credByIndex map[string]ArchivedCredential,
) {
	rows, err := r.SQL().QueryContext(ctx, `
		SELECT d.cpa_auth_index,
		       COUNT(1) AS cnt,
		       MIN(d.cpa_resource_type),
		       COALESCE(MIN(d.cpa_resource_name), ''),
		       COALESCE(MIN(d.cpa_driver), ''),
		       COALESCE(MIN(d.base_url), ''),
		       COALESCE(MIN(d.details_json), '{}'),
		       COALESCE(MIN(o.display_name), ''),
		       COALESCE(MIN(o.icon_ref), ''),
		       COALESCE(MIN(n.display_name), '')
		FROM discovered_resources d
		LEFT JOIN resource_overrides o ON o.resource_id = d.id
		LEFT JOIN credential_display_names n
		  ON n.instance_id = d.instance_id AND n.file_name = d.cpa_resource_name
		WHERE d.instance_id = ? AND COALESCE(TRIM(d.cpa_auth_index), '') <> ''
		GROUP BY d.cpa_auth_index`, instanceID)
	if err != nil {
		return
	}
	defer rows.Close()

	for rows.Next() {
		var authIndex, resType, resName, driver, baseURL, detailsJSON, overrideName, iconRef, credDisplayName string
		var count int
		if rows.Scan(&authIndex, &count, &resType, &resName, &driver, &baseURL, &detailsJSON, &overrideName, &iconRef, &credDisplayName) != nil {
			continue
		}
		authIndex = strings.TrimSpace(authIndex)
		if authIndex == "" {
			continue
		}
		if _, exists := credByIndex[authIndex]; exists {
			continue
		}
		if count > 1 {
			credByIndex[authIndex] = ArchivedCredential{AuthIndex: authIndex, Kind: "oauth", IsAmbiguous: true}
			continue
		}
		var details domain.ResourceDetails
		_ = json.Unmarshal([]byte(detailsJSON), &details)

		if resType == "auth-file" || strings.EqualFold(details.AuthType, "oauth") {
			maskedEmail := security.MaskAccount(details.Email)
			maskedFile := resName
			if details.Email != "" {
				maskedFile = security.MaskAccountIn(maskedFile, details.Email)
			}
			maskedFile = security.MaskEmailAddresses(maskedFile)
			displayName := firstNonEmptyArchive(credDisplayName, overrideName)
			credByIndex[authIndex] = ArchivedCredential{
				AuthIndex:      authIndex,
				Kind:           "oauth",
				ProviderKey:    strings.ToLower(strings.TrimSpace(driver)),
				ProviderFamily: strings.ToLower(strings.TrimSpace(driver)),
				FileName:       boundedArchiveString(maskedFile, 256),
				DisplayName:    boundedArchiveString(displayName, MaxCredentialDisplayNameLength),
				MaskedAccount:  boundedArchiveString(maskedEmail, 256),
			}
			continue
		}

		providerKey := strings.ToLower(strings.TrimSpace(driver))
		upstreamName := strings.TrimSpace(resName)
		if resType == "openai-compatibility" && upstreamName != "" {
			providerKey = "openai-compatible-" + strings.ToLower(upstreamName)
		}
		providerName := firstNonEmptyArchive(overrideName, upstreamName)
		credByIndex[authIndex] = ArchivedCredential{
			AuthIndex:      authIndex,
			Kind:           "apikey",
			ProviderKey:    providerKey,
			ProviderFamily: strings.ToLower(strings.TrimSpace(driver)),
			ProviderName:   boundedArchiveString(providerName, 256),
			UpstreamName:   boundedArchiveString(upstreamName, 256),
			BaseURL:        security.PublicURL(baseURL),
			IconID:         boundedArchiveString(iconRef, 256),
		}
	}
}

func (r *Repository) mergeWarmupTaskFallbacks(
	ctx context.Context,
	instanceID string,
	credByIndex map[string]ArchivedCredential,
) {
	tasks, err := r.ListWarmupTasks(ctx, instanceID)
	if err != nil {
		return
	}
	for _, task := range tasks {
		authIndex := strings.TrimSpace(task.AuthIndex)
		if authIndex == "" {
			continue
		}
		existing, exists := credByIndex[authIndex]
		if exists && (existing.IsAmbiguous || existing.MaskedAccount != "" || existing.DisplayName != "") {
			continue
		}
		maskedAccount := security.MaskAccount(task.Account)
		provider := strings.ToLower(strings.TrimSpace(task.Provider))
		if !exists {
			credByIndex[authIndex] = ArchivedCredential{
				AuthIndex:      authIndex,
				Kind:           "oauth",
				ProviderKey:    provider,
				ProviderFamily: provider,
				MaskedAccount:  boundedArchiveString(maskedAccount, 256),
			}
		} else if existing.Kind == "oauth" {
			if existing.ProviderKey == "" {
				existing.ProviderKey = provider
				existing.ProviderFamily = provider
			}
			if existing.MaskedAccount == "" && maskedAccount != "" {
				existing.MaskedAccount = boundedArchiveString(maskedAccount, 256)
			}
			credByIndex[authIndex] = existing
		}
	}
}

func (r *Repository) mergeQuotaSnapshotFallbacks(
	ctx context.Context,
	credByIndex map[string]ArchivedCredential,
) {
	rows, err := r.SQL().QueryContext(ctx, `
		SELECT q.auth_index, q.provider
		FROM quota_snapshots q
		JOIN (
			SELECT auth_index, MAX(observed_at_ms) AS max_obs
			FROM quota_snapshots
			WHERE auth_index <> ''
			GROUP BY auth_index
		) latest ON latest.auth_index = q.auth_index AND latest.max_obs = q.observed_at_ms`)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var authIndex, provider string
		if rows.Scan(&authIndex, &provider) != nil {
			continue
		}
		authIndex = strings.TrimSpace(authIndex)
		provider = strings.ToLower(strings.TrimSpace(provider))
		if authIndex == "" || provider == "" {
			continue
		}
		if existing, exists := credByIndex[authIndex]; exists && !existing.IsAmbiguous && existing.ProviderKey == "" {
			existing.ProviderKey = provider
			existing.ProviderFamily = provider
			credByIndex[authIndex] = existing
		}
	}
}

func firstNonEmptyArchive(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
