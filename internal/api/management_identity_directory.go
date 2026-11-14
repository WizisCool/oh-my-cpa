package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

const stateScopeIdentityDirectory = "management-identity-directory"

// providerRuntimeKey pairs one configured key with its CPA runtime auth_index
// inside the Go process only; it is never serialized to JSON responses.
type providerRuntimeKey struct {
	authIndex string
	apiKey    string
}

type identityArchiveTracker struct {
	mu              sync.Mutex
	providersDigest string
	authFilesDigest string
	pluginsDigest   string
}

func (t *identityArchiveTracker) reset() {
	if t == nil {
		return
	}
	t.mu.Lock()
	t.providersDigest = ""
	t.authFilesDigest = ""
	t.pluginsDigest = ""
	t.mu.Unlock()
}

func (t *identityArchiveTracker) matchesProviders(digest string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return digest != "" && t.providersDigest == digest
}

func (t *identityArchiveTracker) commitProviders(digest string) {
	if digest == "" {
		return
	}
	t.mu.Lock()
	t.providersDigest = digest
	t.mu.Unlock()
}

func (t *identityArchiveTracker) matchesAuthFiles(digest string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return digest != "" && t.authFilesDigest == digest
}

func (t *identityArchiveTracker) commitAuthFiles(digest string) {
	if digest == "" {
		return
	}
	t.mu.Lock()
	t.authFilesDigest = digest
	t.mu.Unlock()
}

func (t *identityArchiveTracker) matchesPlugins(digest string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return digest != "" && t.pluginsDigest == digest
}

func (t *identityArchiveTracker) commitPlugins(digest string) {
	if digest == "" {
		return
	}
	t.mu.Lock()
	t.pluginsDigest = digest
	t.mu.Unlock()
}

func archiveDigest(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func providerKeyFingerprint(cipher security.Fingerprinter, family, upstreamName, apiKey string) string {
	trimmedKey := strings.TrimSpace(apiKey)
	if cipher == nil || trimmedKey == "" {
		return ""
	}
	scope := strings.ToLower(strings.TrimSpace(family)) + "\x00" + strings.ToLower(strings.TrimSpace(upstreamName)) + "\x00" + trimmedKey
	fp, err := security.Fingerprint(cipher, "provider-key-identity", scope)
	if err != nil || !strings.HasPrefix(fp, "hmac:") {
		return ""
	}
	return fp
}

// IdentityProviderDTO is the secret-free provider entry returned by the unified identity directory.
type IdentityProviderDTO struct {
	ID            string   `json:"id"`
	Family        string   `json:"family"`
	Name          string   `json:"name"`
	UpstreamName  string   `json:"upstream_name,omitempty"`
	Protocol      string   `json:"protocol"`
	BaseURL       string   `json:"base_url,omitempty"`
	Prefix        string   `json:"prefix,omitempty"`
	Priority      *int     `json:"priority,omitempty"`
	AuthIndex     string   `json:"auth_index,omitempty"`
	AuthIndexes   []string `json:"auth_indexes,omitempty"`
	Disabled      bool     `json:"disabled"`
	KeyConfigured bool     `json:"key_configured"`
}

// IdentityCredentialDTO is the secret-free OAuth credential entry returned by the unified identity directory.
type IdentityCredentialDTO struct {
	Name          string `json:"name"`
	AuthIndex     string `json:"auth_index,omitempty"`
	Type          string `json:"type,omitempty"`
	Provider      string `json:"provider,omitempty"`
	OAuthProvider string `json:"oauth_provider,omitempty"`
	Email         string `json:"email,omitempty"`
	ProjectID     string `json:"project_id,omitempty"`
	DisplayName   string `json:"display_name,omitempty"`
	Disabled      bool   `json:"disabled"`
}

// IdentityCatalogStatusDTO reports whether each live upstream source responded,
// allowing export and attribution surfaces to distinguish "unclaimed by live catalog"
// from "live catalog could not be read".
type IdentityCatalogStatusDTO struct {
	ProvidersKnown   bool `json:"providers_known"`
	CredentialsKnown bool `json:"credentials_known"`
	PluginsKnown     bool `json:"plugins_known"`
}

// IdentityDirectoryResponse is the single consolidated source of truth for provider,
// credential, and plugin brand/label resolution across all console pages.
type IdentityDirectoryResponse struct {
	Providers           []IdentityProviderDTO           `json:"providers"`
	Credentials         []IdentityCredentialDTO         `json:"credentials"`
	Plugins             []PluginItemDTO                 `json:"plugins"`
	ProviderIcons       map[string]string               `json:"provider_icons"`
	ArchivedCredentials []repository.ArchivedCredential `json:"archived_credentials"`
	ArchivedProviders   []repository.ArchivedProvider   `json:"archived_providers"`
	CatalogStatus       IdentityCatalogStatusDTO        `json:"catalog_status"`
}

func (h *Handler) publishStateSync(scopes ...string) {
	if h == nil || h.stateCoord == nil || len(scopes) == 0 {
		return
	}
	h.stateCoord.Notify(scopes...)
}

// enrichAndArchiveProviders recovers auth_indexes omitted by CPA on disabled
// OpenAI-compatible providers via keyed-HMAC fingerprints, and persists the
// sanitized presentation archive only when the provider catalog read is complete.
func (h *Handler) enrichAndArchiveProviders(ctx context.Context, items []ProviderItemDTO, catalogComplete bool) {
	if !catalogComplete {
		if h != nil && h.repo != nil && len(items) > 0 {
			h.recoverDisabledProviderAuthIndexes(ctx, items)
		}
		return
	}
	_ = h.enrichAndArchiveProvidersStrict(ctx, items)
}

func (h *Handler) enrichAndArchiveProvidersStrict(ctx context.Context, items []ProviderItemDTO) error {
	if h == nil || h.repo == nil || len(items) == 0 {
		return nil
	}
	h.recoverDisabledProviderAuthIndexes(ctx, items)
	if h.cfg.IsDemoMode {
		return nil
	}
	return h.observeProviderIdentities(ctx, items)
}

func (h *Handler) recoverDisabledProviderAuthIndexes(ctx context.Context, items []ProviderItemDTO) {
	if h == nil || h.repo == nil || h.cipher == nil {
		return
	}
	var missingFPs []string
	type pendingKey struct {
		itemIdx int
		keyIdx  int
		fp      string
	}
	var pending []pendingKey
	fpCountsInLive := make(map[string]int)

	for i := range items {
		for k := range items[i].runtimeKeys {
			rk := items[i].runtimeKeys[k]
			fp := providerKeyFingerprint(h.cipher, items[i].Family, items[i].UpstreamName, rk.apiKey)
			if fp == "" {
				continue
			}
			fpCountsInLive[fp]++
			if items[i].Family == openAICompatibilityFamily && items[i].Disabled && strings.TrimSpace(rk.authIndex) == "" {
				missingFPs = append(missingFPs, fp)
				pending = append(pending, pendingKey{itemIdx: i, keyIdx: k, fp: fp})
			}
		}
	}
	if len(pending) == 0 {
		return
	}
	resolved, err := h.repo.ResolveArchivedAuthIndexesByFingerprints(ctx, defaultInstanceID(), missingFPs)
	if err != nil || len(resolved) == 0 {
		return
	}
	for _, p := range pending {
		if fpCountsInLive[p.fp] > 1 {
			continue
		}
		recoveredList := resolved[p.fp]
		if len(recoveredList) == 0 {
			continue
		}
		latestIdx := strings.TrimSpace(recoveredList[0])
		if latestIdx != "" {
			items[p.itemIdx].runtimeKeys[p.keyIdx].authIndex = latestIdx
		}
		for _, rawIdx := range recoveredList {
			recoveredIdx := strings.TrimSpace(rawIdx)
			if recoveredIdx == "" {
				continue
			}
			already := false
			for _, existing := range items[p.itemIdx].AuthIndexes {
				if existing == recoveredIdx {
					already = true
					break
				}
			}
			if !already {
				items[p.itemIdx].AuthIndexes = append(items[p.itemIdx].AuthIndexes, recoveredIdx)
				if items[p.itemIdx].recoveredAuthIndexes == nil {
					items[p.itemIdx].recoveredAuthIndexes = make(map[string]bool)
				}
				items[p.itemIdx].recoveredAuthIndexes[recoveredIdx] = true
			}
		}
	}
}

func (h *Handler) observeProviderIdentities(ctx context.Context, items []ProviderItemDTO) error {
	icons := h.loadProviderIcons(ctx)
	indexClaims := make(map[string]int)
	compatKeyClaims := make(map[string]int)

	for _, item := range items {
		seenInProvider := make(map[string]bool)
		for _, idx := range item.AuthIndexes {
			trimmed := strings.TrimSpace(idx)
			if trimmed != "" && !seenInProvider[trimmed] {
				seenInProvider[trimmed] = true
				indexClaims[trimmed]++
			}
		}
		if trimmed := strings.TrimSpace(item.AuthIndex); trimmed != "" && !seenInProvider[trimmed] {
			indexClaims[trimmed]++
		}
		if item.Family == openAICompatibilityFamily && strings.TrimSpace(item.UpstreamName) != "" {
			key := management.OpenAICompatibilityLabelPrefix + strings.ToLower(strings.TrimSpace(item.UpstreamName))
			compatKeyClaims[key]++
		}
	}

	credEntries := make([]repository.ArchivedCredential, 0, len(indexClaims))
	provEntries := make([]repository.ArchivedProvider, 0, len(compatKeyClaims))
	emittedCreds := make(map[string]bool)
	emittedProvs := make(map[string]bool)

	for _, item := range items {
		iconID := ""
		if icons != nil {
			iconID = firstNonEmpty(icons[item.ID], icons[item.Name])
		}
		providerKey := strings.ToLower(strings.TrimSpace(item.Family))
		if item.Family == openAICompatibilityFamily && strings.TrimSpace(item.UpstreamName) != "" {
			providerKey = management.OpenAICompatibilityLabelPrefix + strings.ToLower(strings.TrimSpace(item.UpstreamName))
			if !emittedProvs[providerKey] {
				emittedProvs[providerKey] = true
				isAmb := compatKeyClaims[providerKey] > 1
				name := item.Name
				if isAmb {
					name = ""
					iconID = ""
				}
				provEntries = append(provEntries, repository.ArchivedProvider{
					ProviderKey:  providerKey,
					Kind:         "ai_provider",
					Name:         name,
					UpstreamName: item.UpstreamName,
					Family:       item.Family,
					BaseURL:      security.PublicURL(item.BaseURL),
					IconID:       iconID,
					IsAmbiguous:  isAmb,
				})
			}
		}

		// Pair runtime keys with auth_indexes for exact mask and fingerprint capture.
		keyByIndex := make(map[string]string)
		keyIndexCollision := make(map[string]bool)
		for _, rk := range item.runtimeKeys {
			idx := strings.TrimSpace(rk.authIndex)
			key := strings.TrimSpace(rk.apiKey)
			if idx == "" || key == "" {
				continue
			}
			if prev, exists := keyByIndex[idx]; exists && prev != key {
				delete(keyByIndex, idx)
				keyIndexCollision[idx] = true
				continue
			}
			if !keyIndexCollision[idx] {
				keyByIndex[idx] = key
			}
		}

		allIndexes := append([]string{}, item.AuthIndexes...)
		if strings.TrimSpace(item.AuthIndex) != "" {
			allIndexes = append(allIndexes, item.AuthIndex)
		}
		for _, rawIdx := range allIndexes {
			idx := strings.TrimSpace(rawIdx)
			if idx == "" || emittedCreds[idx] {
				continue
			}
			emittedCreds[idx] = true
			isAmb := indexClaims[idx] > 1 || keyIndexCollision[idx]
			rawKey := keyByIndex[idx]
			entry := repository.ArchivedCredential{
				AuthIndex:      idx,
				Kind:           "apikey",
				ProviderKey:    providerKey,
				ProviderFamily: item.Family,
				IsRecovered:    item.recoveredAuthIndexes[idx],
				IsAmbiguous:    isAmb,
			}
			if !isAmb {
				entry.ProviderName = item.Name
				entry.UpstreamName = item.UpstreamName
				entry.BaseURL = security.PublicURL(item.BaseURL)
				entry.IconID = iconID
				entry.KeyMask = security.MaskSecret(rawKey)
				entry.KeyFingerprint = providerKeyFingerprint(h.cipher, item.Family, item.UpstreamName, rawKey)
			}
			credEntries = append(credEntries, entry)
		}
	}

	recoveredFlags := make([]bool, len(credEntries))
	for i, c := range credEntries {
		recoveredFlags[i] = c.IsRecovered
	}
	digest := archiveDigest(struct {
		Creds     []repository.ArchivedCredential
		Recovered []bool
		Provs     []repository.ArchivedProvider
	}{Creds: credEntries, Recovered: recoveredFlags, Provs: provEntries})
	if h.identityArchive.matchesProviders(digest) {
		return nil
	}
	archiveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), providerMetadataWriteTimeout)
	defer cancel()
	if err := h.repo.UpsertArchivedCredentials(archiveCtx, defaultInstanceID(), credEntries); err != nil {
		return err
	}
	if err := h.repo.UpsertArchivedProviders(archiveCtx, defaultInstanceID(), provEntries); err != nil {
		return err
	}
	h.identityArchive.commitProviders(digest)
	return nil
}

func (h *Handler) observeAuthFileIdentities(ctx context.Context, files []managementAuthFileResponse) error {
	if h == nil || h.repo == nil || h.cfg.IsDemoMode || len(files) == 0 {
		return nil
	}
	indexClaims := make(map[string]int, len(files))
	for _, file := range files {
		if idx := strings.TrimSpace(file.AuthIndex); idx != "" {
			indexClaims[idx]++
		}
	}
	entries := make([]repository.ArchivedCredential, 0, len(indexClaims))
	emitted := make(map[string]bool, len(indexClaims))
	for _, file := range files {
		idx := strings.TrimSpace(file.AuthIndex)
		if idx == "" || emitted[idx] {
			continue
		}
		emitted[idx] = true
		isAmb := indexClaims[idx] > 1
		fileType := strings.TrimSpace(file.Type)
		if strings.EqualFold(fileType, "oauth") {
			fileType = ""
		}
		providerKey := strings.ToLower(strings.TrimSpace(firstNonEmpty(file.Provider, fileType)))
		entry := repository.ArchivedCredential{
			AuthIndex:      idx,
			Kind:           "oauth",
			ProviderKey:    providerKey,
			ProviderFamily: providerKey,
			IsAmbiguous:    isAmb,
		}
		if !isAmb {
			entry.OAuthProvider = strings.ToLower(strings.TrimSpace(file.OAuthProvider))
			account := firstNonEmpty(file.Email, file.ProjectID)
			entry.MaskedAccount = security.MaskAccount(account)
			maskedFile := strings.TrimSpace(file.Name)
			if strings.TrimSpace(file.Email) != "" {
				maskedFile = security.MaskAccountIn(maskedFile, file.Email)
			}
			if strings.TrimSpace(file.ProjectID) != "" {
				maskedFile = security.MaskAccountIn(maskedFile, file.ProjectID)
			}
			entry.FileName = security.MaskEmailAddresses(maskedFile)
			entry.DisplayName = strings.TrimSpace(file.DisplayName)
		}
		entries = append(entries, entry)
	}
	digest := archiveDigest(entries)
	if h.identityArchive.matchesAuthFiles(digest) {
		return nil
	}
	archiveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), providerMetadataWriteTimeout)
	defer cancel()
	if err := h.repo.UpsertArchivedCredentials(archiveCtx, defaultInstanceID(), entries); err != nil {
		return err
	}
	h.identityArchive.commitAuthFiles(digest)
	return nil
}

var builtinAndReservedPluginKeys = map[string]bool{
	"kimi": true, "kimi-ai": true, "codex": true, "anthropic": true, "claude": true,
	"antigravity": true, "xai": true, "grok": true, "devin": true, "meta": true,
	"gemini": true, "google": true, "vertex": true, "interactions": true,
}

func (h *Handler) observePluginIdentities(ctx context.Context, plugins []PluginItemDTO) error {
	if h == nil || h.repo == nil || h.cfg.IsDemoMode || len(plugins) == 0 {
		return nil
	}
	ordered := append([]PluginItemDTO(nil), plugins...)
	sort.SliceStable(ordered, func(i, j int) bool {
		leftOn := ordered[i].EffectiveEnabled || ordered[i].Enabled
		rightOn := ordered[j].EffectiveEnabled || ordered[j].Enabled
		if leftOn == rightOn {
			return false
		}
		return leftOn
	})

	byKey := make(map[string]repository.ArchivedProvider)
	for _, plugin := range ordered {
		declaredSet := make(map[string]bool)
		var declared []string
		for _, raw := range append(append([]string{}, plugin.OAuthProviders...), plugin.OAuthProvider) {
			id := strings.ToLower(strings.TrimSpace(raw))
			if id != "" && oauthProviderPattern.MatchString(id) && !declaredSet[id] {
				declaredSet[id] = true
				declared = append(declared, id)
			}
		}
		portalIDs := declared
		if len(portalIDs) == 0 && plugin.SupportsOAuth {
			pluginID := strings.ToLower(strings.TrimSpace(plugin.ID))
			if oauthProviderPattern.MatchString(pluginID) {
				portalIDs = []string{pluginID}
			}
		}
		if !plugin.SupportsOAuth && len(declared) == 0 {
			continue
		}

		nonBuiltinPortals := 0
		for _, id := range portalIDs {
			if !builtinAndReservedPluginKeys[id] {
				nonBuiltinPortals++
			}
		}
		isMultiPortal := plugin.SupportsOAuth && nonBuiltinPortals > 1

		pluginName := strings.TrimSpace(plugin.ID)
		pluginLogo := strings.TrimSpace(plugin.Logo)
		if plugin.Metadata != nil {
			if strings.TrimSpace(plugin.Metadata.Name) != "" {
				pluginName = strings.TrimSpace(plugin.Metadata.Name)
			}
			if pluginLogo == "" && strings.TrimSpace(plugin.Metadata.Logo) != "" {
				pluginLogo = strings.TrimSpace(plugin.Metadata.Logo)
			}
		}

		entryTextByID := make(map[string]PluginOAuthProviderEntryDTO, len(plugin.OAuthProviderEntries))
		for _, entry := range plugin.OAuthProviderEntries {
			id := strings.ToLower(strings.TrimSpace(entry.Identifier))
			if id != "" {
				entryTextByID[id] = entry
			}
		}

		for _, id := range portalIDs {
			entry := entryTextByID[id]
			title := pluginName
			if strings.TrimSpace(entry.Name) != "" && strings.TrimSpace(entry.Name) != pluginName {
				title = strings.TrimSpace(entry.Name)
			} else if len(portalIDs) > 1 {
				title = pluginName + " (" + id + ")"
			}
			if builtinAndReservedPluginKeys[id] {
				title = ""
			}
			logo := firstNonEmpty(entry.Logo, pluginLogo)
			if existing, exists := byKey[id]; !exists {
				byKey[id] = repository.ArchivedProvider{
					ProviderKey:   id,
					Kind:          "oauth_plugin",
					Name:          title,
					Logo:          logo,
					IsMultiPortal: isMultiPortal && !builtinAndReservedPluginKeys[id],
					IsPluginOwned: true,
				}
			} else {
				if existing.Logo == "" && logo != "" {
					existing.Logo = logo
				}
				if existing.Name == "" && title != "" {
					existing.Name = title
				}
				if isMultiPortal && !builtinAndReservedPluginKeys[id] {
					existing.IsMultiPortal = true
				}
				byKey[id] = existing
			}
		}

		extraKeys := []string{
			strings.ToLower(strings.TrimSpace(plugin.ID)),
			strings.ToLower(strings.TrimSpace(plugin.QuotaProvider)),
		}
		for _, key := range extraKeys {
			if key == "" {
				continue
			}
			title := pluginName
			if builtinAndReservedPluginKeys[key] {
				title = ""
			}
			if existing, exists := byKey[key]; !exists {
				byKey[key] = repository.ArchivedProvider{
					ProviderKey:   key,
					Kind:          "oauth_plugin",
					Name:          title,
					Logo:          pluginLogo,
					IsPluginOwned: true,
				}
			} else {
				if existing.Logo == "" && pluginLogo != "" {
					existing.Logo = pluginLogo
				}
				if existing.Name == "" && title != "" {
					existing.Name = title
				}
				byKey[key] = existing
			}
		}
	}

	if len(byKey) == 0 {
		return nil
	}
	entries := make([]repository.ArchivedProvider, 0, len(byKey))
	for _, item := range byKey {
		entries = append(entries, item)
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].ProviderKey < entries[j].ProviderKey
	})
	digest := archiveDigest(entries)
	if h.identityArchive.matchesPlugins(digest) {
		return nil
	}
	archiveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), providerMetadataWriteTimeout)
	defer cancel()
	if err := h.repo.UpsertArchivedProviders(archiveCtx, defaultInstanceID(), entries); err != nil {
		return err
	}
	h.identityArchive.commitPlugins(digest)
	return nil
}

type archivePersistError struct {
	err error
}

func (e *archivePersistError) Error() string { return "persist identity archive: " + e.err.Error() }
func (e *archivePersistError) Unwrap() error { return e.err }

func (h *Handler) snapshotAuthFilesBeforeDelete(ctx context.Context, client *management.Client) error {
	if h == nil || h.repo == nil || h.cfg.IsDemoMode || client == nil {
		return nil
	}
	files, err := client.AuthFiles(ctx)
	if err != nil {
		return err
	}
	names, namesErr := h.repo.ListCredentialDisplayNames(ctx, defaultInstanceID())
	if namesErr != nil {
		return &archivePersistError{err: namesErr}
	}
	projected := make([]managementAuthFileResponse, 0, len(files.Files))
	for _, raw := range files.Files {
		item := projectManagementAuthFile(raw)
		if stored, ok := names[item.Name]; ok {
			item.DisplayName = stored.DisplayName
		}
		projected = append(projected, item)
	}
	h.identityArchive.reset()
	if persistErr := h.observeAuthFileIdentities(ctx, projected); persistErr != nil {
		return &archivePersistError{err: persistErr}
	}
	return nil
}

func (h *Handler) snapshotProvidersBeforeDelete(ctx context.Context, client *management.Client) error {
	if h == nil || h.repo == nil || h.cfg.IsDemoMode || client == nil {
		return nil
	}
	items, known := h.readProviderItemsUpstreamWithStatus(ctx, client)
	if !known {
		return newProviderWriteErrorWithCode(
			http.StatusInternalServerError,
			"failed to archive provider metadata before deletion",
			providerArchiveFailedCode,
		)
	}
	if len(items) == 0 {
		return nil
	}
	h.identityArchive.reset()
	if err := h.enrichAndArchiveProvidersStrict(ctx, items); err != nil {
		return newProviderWriteErrorWithCode(
			http.StatusInternalServerError,
			"failed to archive provider metadata before deletion",
			providerArchiveFailedCode,
		)
	}
	return nil
}

func (h *Handler) snapshotPluginsBeforeDelete(ctx context.Context, client *management.Client) error {
	if h == nil || h.repo == nil || h.cfg.IsDemoMode || client == nil {
		return nil
	}
	list, err := client.PluginList(ctx)
	if err != nil {
		return err
	}
	h.pluginIdentities.fill(ctx, client, list.Plugins)
	projected := projectPluginItems(list.Plugins, h.cfg.IsDemoMode)
	h.identityArchive.reset()
	if persistErr := h.observePluginIdentities(ctx, projected); persistErr != nil {
		return &archivePersistError{err: persistErr}
	}
	return nil
}

// getIdentityDirectory serves GET /api/v1/management/identity-directory.
//
// Unlike raw management endpoints that fail when CPA is unreachable, this
// endpoint degrades gracefully to the SQLite presentation archive so historical
// usage, routing, and insights surfaces stay readable even during gateway restarts.
//
// @Summary Get unified identity directory
// @Description Return live and archived provider, credential, and plugin identities with display metadata and catalog status.
// @Tags Providers
// @Produce json
// @Security CookieAuth
// @Success 200 {object} IdentityDirectoryResponse
// @Failure 401 {object} ErrorResponseDTO
// @Router /v1/management/identity-directory [get]
func (h *Handler) getIdentityDirectory(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	ctx := request.Context()

	resp := IdentityDirectoryResponse{
		Providers:           []IdentityProviderDTO{},
		Credentials:         []IdentityCredentialDTO{},
		Plugins:             []PluginItemDTO{},
		ProviderIcons:       map[string]string{},
		ArchivedCredentials: []repository.ArchivedCredential{},
		ArchivedProviders:   []repository.ArchivedProvider{},
	}

	if h.repo != nil {
		if icons := h.loadProviderIcons(ctx); icons != nil {
			resp.ProviderIcons = icons
		}
	}

	var client *management.Client
	if h.repo != nil {
		if instance, err := h.repo.GetInstance(ctx, defaultInstanceID()); err == nil {
			client, _ = h.clientForInstance(ctx, instance)
		}
	}

	var wg sync.WaitGroup
	var (
		providers        []IdentityProviderDTO
		providersKnown   bool
		credentials      []IdentityCredentialDTO
		credentialsKnown bool
		plugins          []PluginItemDTO
		pluginsKnown     bool
	)

	if client != nil {
		wg.Go(func() {
			items, known := h.readProviderItemsWithStatus(ctx, client)
			providersKnown = known
			providers = make([]IdentityProviderDTO, 0, len(items))
			for _, item := range items {
				providers = append(providers, IdentityProviderDTO{
					ID:            item.ID,
					Family:        item.Family,
					Name:          item.Name,
					UpstreamName:  item.UpstreamName,
					Protocol:      item.Protocol,
					BaseURL:       security.PublicURL(item.BaseURL),
					Prefix:        item.Prefix,
					Priority:      item.Priority,
					AuthIndex:     item.AuthIndex,
					AuthIndexes:   item.AuthIndexes,
					Disabled:      item.Disabled,
					KeyConfigured: item.KeyConfigured,
				})
			}
		})

		wg.Go(func() {
			rawFiles, liveOK := h.readRawAuthFilesForDirectory(ctx, client)
			credentialsKnown = liveOK
			if !liveOK && len(rawFiles) == 0 {
				return
			}
			var names map[string]repository.CredentialDisplayName
			if h.repo != nil {
				names, _ = h.repo.ListCredentialDisplayNames(ctx, defaultInstanceID())
			}
			projected := make([]managementAuthFileResponse, 0, len(rawFiles))
			for _, file := range rawFiles {
				item := projectManagementAuthFile(file)
				if names != nil {
					if stored, isNamed := names[item.Name]; isNamed {
						item.DisplayName = stored.DisplayName
					}
				}
				projected = append(projected, item)
			}
			if liveOK {
				_ = h.observeAuthFileIdentities(ctx, projected)
			}
			sort.Slice(projected, func(i, j int) bool {
				return strings.ToLower(projected[i].Name) < strings.ToLower(projected[j].Name)
			})
			credentials = make([]IdentityCredentialDTO, 0, len(projected))
			for _, item := range projected {
				credentials = append(credentials, IdentityCredentialDTO{
					Name:          item.Name,
					AuthIndex:     item.AuthIndex,
					Type:          item.Type,
					Provider:      item.Provider,
					OAuthProvider: item.OAuthProvider,
					Email:         item.Email,
					ProjectID:     item.ProjectID,
					DisplayName:   item.DisplayName,
					Disabled:      item.Disabled,
				})
			}
		})

		wg.Go(func() {
			list, err := client.PluginList(ctx)
			if err != nil {
				return
			}
			pluginsKnown = true
			h.pluginIdentities.fill(ctx, client, list.Plugins)
			projected := projectPluginItems(list.Plugins, h.cfg.IsDemoMode)
			_ = h.observePluginIdentities(ctx, projected)
			plugins = projected
		})
	}
	wg.Wait()

	if providers != nil {
		resp.Providers = providers
	}
	if credentials != nil {
		resp.Credentials = credentials
	}
	if plugins != nil {
		resp.Plugins = plugins
	}
	resp.CatalogStatus = IdentityCatalogStatusDTO{
		ProvidersKnown:   providersKnown,
		CredentialsKnown: credentialsKnown,
		PluginsKnown:     pluginsKnown,
	}

	if h.repo != nil {
		if archCreds, archProvs, err := h.repo.ListIdentityArchive(ctx, defaultInstanceID()); err == nil {
			resp.ArchivedCredentials = archCreds
			resp.ArchivedProviders = archProvs
		}
	}

	writeJSON(writer, http.StatusOK, resp)
}

func (h *Handler) readRawAuthFilesForDirectory(ctx context.Context, client *management.Client) ([]management.AuthFile, bool) {
	if files, err := client.AuthFiles(ctx); err == nil {
		rawFiles := files.Files
		if h.stateCoord != nil {
			if envelope, coordErr := h.stateCoord.Read(ctx); coordErr == nil && len(envelope.Data.PendingAuthStatus) > 0 {
				for idx := range rawFiles {
					for _, pending := range envelope.Data.PendingAuthStatus {
						if rawFiles[idx].Name != pending.Name && rawFiles[idx].ID != pending.Name {
							continue
						}
						if pending.AuthIndex != "" && rawFiles[idx].AuthIndex != pending.AuthIndex {
							continue
						}
						rawFiles[idx].Disabled = pending.Disabled
					}
				}
			}
		}
		return rawFiles, true
	}
	if h.stateCoord != nil {
		if envelope, coordErr := h.stateCoord.Read(ctx); coordErr == nil && !envelope.Data.AuthFilesUnavailable {
			return envelope.Data.AuthFiles, false
		}
	}
	return nil, false
}
