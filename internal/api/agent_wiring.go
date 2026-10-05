package api

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/agent"
	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
	"github.com/oh-my-cpa/oh-my-cpa/internal/quota"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type agentState struct {
	once        sync.Once
	err         error
	runtime     *agent.Runtime
	executor    *capability.Executor
	oauthMu     sync.Mutex
	oauth       map[string]management.OAuthAuthURLResponse
	refreshMu   sync.Mutex
	lastRefresh map[string]time.Time
	cleanupMu   sync.Mutex
	lastCleanup time.Time
	catalogMu   sync.Mutex
	catalog     *clientKeyCatalog
}

// clientKeyCatalog is the fingerprint-to-key join, held for a moment.
//
// Resolving a fingerprint used to cost one CPA key list per call, and one Agent run resolves it
// once per model round: a five-round turn read the same list five times, on a client that the
// whole console shares. The results are key material, so the cache holds them in memory only,
// expires after a short window, and is never written to the database or to a log.
type clientKeyCatalog struct {
	baseURL string
	expires time.Time
	keys    map[string]string
}

const clientKeyCatalogTTL = 30 * time.Second

// boundCachedKeys caps the catalog by key count rather than by byte size: a deployment with
// thousands of client keys is better served by one extra CPA read than by holding all of them.
const boundCachedKeys = 256

func (h *Handler) cachedClientKeyForResolution(ctx context.Context, client *management.Client, fingerprint string) (string, error) {
	now := time.Now()
	h.agent.catalogMu.Lock()
	if catalog := h.agent.catalog; catalog != nil && catalog.baseURL == client.BaseURL() && now.Before(catalog.expires) {
		if key, ok := catalog.keys[fingerprint]; ok {
			h.agent.catalogMu.Unlock()
			return key, nil
		}
		h.agent.catalogMu.Unlock()
		// A miss against a warm catalog is still authoritative for its window: the key list was
		// read moments ago, and re-reading it per round is the cost this exists to remove.
		return "", errClientKeyMissing
	}
	h.agent.catalogMu.Unlock()

	keys, err := client.ClientAPIKeys(ctx)
	if err != nil {
		return "", err
	}
	index := make(map[string]string, len(keys))
	for _, key := range keys {
		key = strings.TrimSpace(key)
		identity, err := h.repo.UsageClientKeyFingerprint(key)
		if err != nil {
			return "", err
		}
		index[identity] = key
	}
	if len(index) <= boundCachedKeys {
		h.agent.catalogMu.Lock()
		h.agent.catalog = &clientKeyCatalog{baseURL: client.BaseURL(), expires: now.Add(clientKeyCatalogTTL), keys: index}
		h.agent.catalogMu.Unlock()
	}
	key, ok := index[fingerprint]
	if !ok {
		return "", errClientKeyMissing
	}
	return key, nil
}

func (h *Handler) capabilityClient(ctx context.Context) (*management.Client, error) {
	instance, err := h.repo.GetInstance(ctx, defaultInstanceID())
	if err != nil {
		return nil, err
	}
	return h.clientForInstance(ctx, instance)
}
func (h *Handler) inferenceClient(ctx context.Context, fingerprint string) (*gateway.Client, error) {
	if fingerprint == "" || len(fingerprint) > 256 {
		return nil, errors.New("invalid_parameters")
	}
	client, err := h.capabilityClient(ctx)
	if err != nil {
		return nil, err
	}
	key, err := h.cachedClientKeyForResolution(ctx, client, fingerprint)
	if err != nil {
		if errors.Is(err, errClientKeyMissing) {
			return nil, errors.New("resource_missing")
		}
		return nil, err
	}
	return gateway.NewClient(client.BaseURL(), key, h.cfg.TLSSkipVerify)
}
func (h *Handler) operationsService() *operations.Service {
	service := &operations.Service{TLSSkipVerify: h.cfg.TLSSkipVerify, Pricing: h.pricing, Repo: h.repo, Cipher: h.cipher, Client: h.capabilityClient, Acquire: h.providerWrites.acquire, Release: h.providerWrites.release, Notify: func() {
		if h.pricing != nil {
			h.pricing.NotifyModelsChanged()
		}
	}}
	service.ListProviders = func(ctx context.Context) ([]operations.Provider, error) {
		client, err := h.capabilityClient(ctx)
		if err != nil {
			return nil, err
		}
		items := h.readProviderItems(ctx, client)
		result := []operations.Provider{}
		for _, item := range items {
			separator := strings.LastIndex(item.ID, "-")
			index := 0
			if separator >= 0 {
				index, _ = strconv.Atoi(item.ID[separator+1:])
			}
			models := item.Models
			if models == nil {
				models = []string{}
			}
			provider := operations.Provider{ID: item.ID, Family: item.Family, Index: index, Name: item.Name, UpstreamName: item.UpstreamName, AuthIndex: item.AuthIndex, IsDisabled: item.Disabled, Models: models}
			raw, _ := json.Marshal(item)
			provider.Revision, _ = h.cipher.Fingerprint("provider-operation", string(raw))
			result = append(result, provider)
		}
		return result, nil
	}
	service.SetProviderStatus = func(ctx context.Context, input operations.ProviderStatus, revision string) error {
		provider, err := service.FindProvider(ctx, input.ID)
		if err != nil {
			return err
		}
		client, err := h.capabilityClient(ctx)
		if err != nil {
			return err
		}
		req := patchProviderStatusRequest{Family: provider.Family, Index: provider.Index, Disabled: input.IsDisabled, ExpectedAuthIndex: provider.AuthIndex, ExpectedName: provider.UpstreamName, beforeWrite: func(ctx context.Context) error {
			current, err := service.FindProvider(ctx, input.ID)
			if err != nil {
				return err
			}
			if current.Revision != revision {
				return errors.New("resource_conflict")
			}
			return nil
		}}
		err = h.writeProviderStatus(ctx, client, req)
		if err == nil {
			service.Notify()
		}
		return err
	}
	service.Quotas = func(ctx context.Context) ([]operations.Quota, error) {
		client, err := h.capabilityClient(ctx)
		if err != nil {
			return nil, err
		}
		overview, err := h.buildQuotaOverview(ctx, client)
		if err != nil {
			return nil, err
		}
		result := []operations.Quota{}
		for _, item := range overview.Quotas {
			result = append(result, operations.SafeQuota(&item.NormalizedQuota))
		}
		return result, nil
	}
	service.RefreshQuota = func(ctx context.Context, authIndex string) (operations.Quota, error) {
		client, err := h.capabilityClient(ctx)
		if err != nil {
			return operations.Quota{}, err
		}
		files, err := client.AuthFiles(ctx)
		if err != nil {
			return operations.Quota{}, err
		}
		for _, file := range files.Files {
			if file.AuthIndex == authIndex {
				h.agent.refreshMu.Lock()
				if time.Since(h.agent.lastRefresh[authIndex]) < 30*time.Second {
					h.agent.refreshMu.Unlock()
					return operations.Quota{}, errors.New("write_busy")
				}
				if h.agent.lastRefresh == nil {
					h.agent.lastRefresh = map[string]time.Time{}
				}
				h.agent.lastRefresh[authIndex] = time.Now()
				h.agent.refreshMu.Unlock()

				value, err := quota.NewService(client).RefreshCredentialQuota(ctx, file, h.loadPriorNormalizedQuota(ctx, authIndex))
				if err != nil {
					return operations.Quota{}, err
				}
				if value.Status != "error" && value.Status != "stale" {
					if err = h.persistNormalizedQuotaSnapshot(ctx, value); err != nil {
						return operations.Quota{}, err
					}
				}
				h.attachWindowCapacity(ctx, value, h.now().UnixMilli())
				return operations.SafeQuota(value), nil
			}
		}
		return operations.Quota{}, errors.New("resource_missing")
	}
	service.ActOnQuota = func(ctx context.Context, target operations.CredentialTarget, action, revision string) error {
		if err := h.providerWrites.acquire(ctx); err != nil {
			return errors.New("write_busy")
		}
		defer h.providerWrites.release()
		if err := service.CheckCredential(ctx, target, revision); err != nil {
			return err
		}
		client, err := h.capabilityClient(ctx)
		if err != nil {
			return err
		}
		audited := func(string, string, string, string, map[string]any) error { return nil }
		if action == "redeem" {
			_, err = h.redeemQuotaCredit(ctx, client, target.AuthIndex, audited)
		} else {
			_, err = h.clearQuotaCooldown(ctx, client, target.AuthIndex, "quota.clear_cooldown", audited)
		}
		return mapAgentProviderError(err)
	}
	service.OAuthModelAliases = func(ctx context.Context) (map[string][]operations.OAuthModelAlias, string, error) {
		client, err := h.capabilityClient(ctx)
		if err != nil {
			return nil, "", err
		}
		raw, err := client.OAuthModelAliases(ctx)
		if err != nil {
			return nil, "", err
		}
		projected, err := projectManagementOAuthModelAliases(raw)
		if err != nil {
			return nil, "", err
		}
		result := make(map[string][]operations.OAuthModelAlias, len(projected))
		for provider, entries := range projected {
			converted := make([]operations.OAuthModelAlias, 0, len(entries))
			for _, entry := range entries {
				converted = append(converted, operations.OAuthModelAlias{Name: entry.Name, Alias: entry.Alias, Fork: entry.Fork, DisplayName: entry.DisplayName, ForceMapping: entry.ForceMapping})
			}
			result[provider] = converted
		}
		encoded, err := json.Marshal(projected)
		if err != nil {
			return nil, "", err
		}
		revision, err := h.cipher.Fingerprint("oauth-model-alias-operation", string(encoded))
		if err != nil {
			return nil, "", err
		}
		return result, revision, nil
	}
	service.NormalizeOAuthModelAliases = func(provider string, aliases []operations.OAuthModelAlias) (string, []operations.OAuthModelAlias, error) {
		normalizedProvider, err := normalizeManagementOAuthModelAliasProvider(provider)
		if err != nil {
			return "", nil, errors.New("invalid_parameters")
		}
		converted := make([]managementOAuthModelAlias, 0, len(aliases))
		for _, entry := range aliases {
			converted = append(converted, managementOAuthModelAlias{Name: entry.Name, Alias: entry.Alias, Fork: entry.Fork, DisplayName: entry.DisplayName, ForceMapping: entry.ForceMapping})
		}
		normalized, err := normalizeManagementOAuthModelAliases(converted)
		if err != nil {
			return "", nil, errors.New("invalid_parameters")
		}
		result := make([]operations.OAuthModelAlias, 0, len(normalized))
		for _, entry := range normalized {
			result = append(result, operations.OAuthModelAlias{Name: entry.Name, Alias: entry.Alias, Fork: entry.Fork, DisplayName: entry.DisplayName, ForceMapping: entry.ForceMapping})
		}
		return normalizedProvider, result, nil
	}
	service.SetOAuthModelAliases = func(ctx context.Context, provider string, aliases []operations.OAuthModelAlias, revision string) error {
		client, err := h.capabilityClient(ctx)
		if err != nil {
			return err
		}
		converted := make([]managementOAuthModelAlias, 0, len(aliases))
		for _, entry := range aliases {
			converted = append(converted, managementOAuthModelAlias{Name: entry.Name, Alias: entry.Alias, Fork: entry.Fork, DisplayName: entry.DisplayName, ForceMapping: entry.ForceMapping})
		}
		_, err = h.applyManagementOAuthModelAliases(ctx, client, provider, converted, func(ctx context.Context) error {
			_, current, err := service.OAuthModelAliases(ctx)
			if err != nil {
				return err
			}
			if current != revision {
				return errors.New("resource_conflict")
			}
			return nil
		})
		return mapAgentProviderError(err)
	}
	service.NormalizeCredentialFields = func(fields map[string]any) (map[string]any, error) {
		raw := make(map[string]json.RawMessage, len(fields))
		for key, value := range fields {
			encoded, err := json.Marshal(value)
			if err != nil {
				return nil, errors.New("invalid_parameters")
			}
			raw[key] = encoded
		}
		normalized, err := normalizeManagementAuthFileFields(raw)
		if err != nil {
			return nil, errors.New("invalid_parameters")
		}
		return normalized, nil
	}
	service.UpdateCredentialFields = func(ctx context.Context, target operations.CredentialTarget, fields map[string]any, revision string) error {
		client, err := h.capabilityClient(ctx)
		if err != nil {
			return err
		}
		if err := h.providerWrites.acquire(ctx); err != nil {
			return errors.New("write_busy")
		}
		defer h.providerWrites.release()
		if err := service.CheckCredential(ctx, target, revision); err != nil {
			return err
		}
		_, err = h.applyManagementAuthFileFields(ctx, client, target.Name, target.AuthIndex, fields)
		return mapAgentProviderError(err)
	}
	h.bindProviderOperations(service)
	return service
}
func (h *Handler) ensureAgent() error {
	h.agent.once.Do(func() {
		registry := capability.NewRegistry()
		h.agent.err = h.operationsService().Register(registry)
		if h.agent.err == nil {
			h.agent.err = agent.RegisterAskQuestion(registry)
		}
		if h.agent.err != nil {
			return
		}
		store := repository.AgentStore{Repo: h.repo, Cipher: h.cipher}
		executor := &capability.Executor{Registry: registry, Store: store, Authorize: func(_ context.Context, id, _ string) bool { return h.auth != nil && id == h.auth.CapabilityIdentity() }, VerifyHuman: h.verifyAgentOAuth}
		h.agent.executor = executor
		h.agent.runtime = &agent.Runtime{Executor: executor, Store: store, Location: h.repo.Timezone().Location, Slots: h.playgroundSlots, Client: func(ctx context.Context, fingerprint string) (agent.ModelClient, error) {
			return h.inferenceClient(ctx, fingerprint)
		}}
		h.agent.oauth = map[string]management.OAuthAuthURLResponse{}
	})
	if h.agent.err == nil && h.agent.cleanupMu.TryLock() {
		defer h.agent.cleanupMu.Unlock()
		if time.Since(h.agent.lastCleanup) > time.Minute {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			if h.agent.executor.Store.Purge(ctx) == nil {
				h.agent.lastCleanup = time.Now()
			}
			// The key catalog is the one place this console holds client keys in memory. It is
			// dropped on a cadence of its own rather than trusted to expire in place, so a
			// suspended or idle process does not keep credentials it is not using.
			h.agent.catalogMu.Lock()
			if catalog := h.agent.catalog; catalog != nil && time.Now().After(catalog.expires) {
				h.agent.catalog = nil
			}
			h.agent.catalogMu.Unlock()
			h.agent.oauthMu.Lock()
			for id := range h.agent.oauth {
				operation, err := h.agent.executor.Get(ctx, agent.PRINCIPAL, id)
				if err != nil || operation.Status != "pending" {
					delete(h.agent.oauth, id)
				}
			}
			h.agent.oauthMu.Unlock()
		}
	}
	return h.agent.err
}
