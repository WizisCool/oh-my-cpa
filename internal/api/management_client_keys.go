package api

import (
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/statecoord"
)

type ClientAPIKeyItemDTO struct {
	Index int `json:"index"`
	// Key is the key's display mask (`security.MaskSecret`), and the key itself only
	// when the caller asked for it with `include_keys=true`: the key page joins this
	// list against the configuration document it edits, and it needs the value to do
	// that, while every other reader renders the mask. The field always carries the
	// same shape for the same key either way, so a reader that masks what it is given
	// reads both forms identically.
	Key string `json:"key"`
	// Fingerprint is the legacy keys-page identity, computed under the
	// "client-key" purpose. It is retained so existing clients keep working.
	Fingerprint string `json:"fingerprint"`
	// UsageFingerprint is the identity this key has in the usage records
	// (`usage_events.api_group_key`), computed under the "usage-api-key"
	// purpose. Only this value can be joined to a request record, so it is what
	// an alias is stored against and what the "view requests" action filters by.
	// Empty when the cipher is unavailable; an empty value must never be used as
	// an alias identity.
	UsageFingerprint string `json:"usage_fingerprint,omitempty"`
	Length           int    `json:"length"`
	// Alias is the operator-assigned name, empty when the key is unnamed.
	Alias string `json:"alias,omitempty"`
	// AliasVersion is the version a rename must cite; zero means no alias exists.
	AliasVersion int64 `json:"alias_version"`
}

var (
	errClientKeyDuplicate   = errors.New("api key already exists")
	errClientKeyOutOfBounds = errors.New("key index out of bounds")
	errClientKeyStaleIndex  = errors.New("the key at this position changed; reload and try again")
)

func (h *Handler) projectClientAPIKeyItems(keys []string, aliases map[string]repository.ClientKeyAlias, includeKeys bool) []ClientAPIKeyItemDTO {
	items := make([]ClientAPIKeyItemDTO, 0, len(keys))
	for i, key := range keys {
		trimmed := strings.TrimSpace(key)
		fingerprint := security.FingerprintOrRedacted(h.cipher, "client-key", trimmed)
		// The mask is idempotent, so a reader that masks whatever it is given
		// renders this field identically in both forms.
		displayKey := trimmed
		if !includeKeys {
			displayKey = security.MaskSecret(trimmed)
		}
		item := ClientAPIKeyItemDTO{
			Index:       i,
			Key:         displayKey,
			Fingerprint: fingerprint,
			Length:      len(trimmed),
		}
		// The usage identity is derived with the purpose the ingestion path uses,
		// which is what makes a name attach to the requests this key served. It is
		// left empty when the fingerprint fails rather than filled with the shared
		// redacted marker, because an alias keyed on that value would leak one
		// key's name onto another's records.
		if usageFingerprint, fpErr := h.repo.UsageClientKeyFingerprint(trimmed); fpErr == nil {
			item.UsageFingerprint = usageFingerprint
			if entry, ok := aliases[usageFingerprint]; ok {
				item.Alias = entry.Alias
				item.AliasVersion = entry.Version
			}
		}
		items = append(items, item)
	}
	return items
}

func (h *Handler) listClientAPIKeys(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	// The raw caller keys leave the process only for the page whose contract
	// includes editing them, which is the same opt-in the provider list uses. A
	// response that merely reports the keys - the dashboard's picker, a future
	// panel - needs the mask and must not be able to read a credential out of a
	// response body.
	includeKeys := h.revealKeysAllowed(request)

	var (
		keys    []string
		version uint64
		err     error
	)
	if h.stateCoord != nil {
		env, coordErr := statecoord.ProjectTyped(request.Context(), h.stateCoord, func(state projectedConfigState, _ uint64) ([]string, error) {
			return slices.Clone(state.ClientKeys), nil
		})
		if coordErr == nil {
			keys = env.Data
			version = env.Version
		} else {
			err = coordErr
		}
	} else {
		keys, err = client.ClientAPIKeys(request.Context())
	}
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	aliases, aliasErr := h.repo.ListClientKeyAliases(request.Context(), defaultInstanceID())
	if aliasErr != nil {
		// The alias overlay is metadata. Failing the whole key list over it would
		// hide the keys themselves, so the list is served unnamed instead.
		aliases = map[string]repository.ClientKeyAlias{}
	}

	items := h.projectClientAPIKeyItems(keys, aliases, includeKeys)

	if includeKeys {
		// The reveal is the audit boundary: a masked response carries no credential,
		// so it is not a credential read and must not fill the log on every poll.
		if auditErr := h.recordAudit(request, "api_key.reveal", "client_api_key", "list", "success", map[string]any{
			"key_count": len(items),
		}); auditErr != nil {
			writeAuditFailure(writer, "audit log failure; client key reveal aborted")
			return
		}
	}

	setStateVersionHeader(writer, version)
	body := map[string]any{
		"keys":  items,
		"total": len(items),
	}
	if version > 0 {
		body["version"] = version
	}
	writeJSON(writer, http.StatusOK, body)
}

type createClientKeyRequest struct {
	Key                 string `json:"key"`
	ExpectedFingerprint string `json:"expected_fingerprint,omitempty"`
}

func (h *Handler) createClientAPIKey(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var req createClientKeyRequest
	if err := decodeManagementJSON(writer, request, 8*1024, &req); err != nil {
		return
	}
	newKey := strings.TrimSpace(req.Key)
	if newKey == "" {
		writeError(writer, http.StatusBadRequest, "api key cannot be empty")
		return
	}
	if len(newKey) > 8192 {
		writeError(writer, http.StatusBadRequest, "api key exceeds maximum length")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	fingerprint := security.FingerprintOrRedacted(h.cipher, "client-key", newKey)
	usageFingerprint, _ := h.repo.UsageClientKeyFingerprint(newKey)

	if h.stateCoord != nil {
		env, loadErr := statecoord.ProjectTyped(request.Context(), h.stateCoord, func(state projectedConfigState, _ uint64) (int, error) {
			return len(state.ClientKeys), nil
		})
		if loadErr != nil {
			writeCPAFacadeError(writer, loadErr)
			return
		}
		targetLabel := fmt.Sprintf("index:%d", env.Data)
		if auditErr := h.recordAudit(request, "api_key.create", "client_api_key", targetLabel, "attempt", nil); auditErr != nil {
			writeError(writer, http.StatusInternalServerError, "audit failure; key creation aborted")
			return
		}

		createdIndex := 0
		version, mutErr := h.mutateCoordinatorWithAudit(request, stateDomainClientKeys, "api_key.create", "client_api_key", targetLabel, nil, func(state *projectedConfigState) error {
			for _, existing := range state.ClientKeys {
				if strings.TrimSpace(existing) == newKey {
					return errClientKeyDuplicate
				}
			}
			createdIndex = len(state.ClientKeys)
			state.ClientKeys = append(state.ClientKeys, newKey)
			return nil
		})
		if mutErr != nil {
			_ = h.recordAudit(request, "api_key.create", "client_api_key", targetLabel, "failure", map[string]any{"error": mutErr.Error()})
			if errors.Is(mutErr, errClientKeyDuplicate) {
				writeJSON(writer, http.StatusConflict, map[string]string{"error": mutErr.Error(), "code": "resource_conflict"})
				return
			}
			writeProviderWriteError(writer, mutErr)
			return
		}
		h.invalidateClientKeyCatalog()
		setStateVersionHeader(writer, version)
		resp := map[string]any{
			"status":      "ok",
			"index":       createdIndex,
			"key":         security.MaskSecret(newKey),
			"fingerprint": fingerprint,
			"version":     version,
		}
		if usageFingerprint != "" {
			resp["usage_fingerprint"] = usageFingerprint
		}
		writeJSON(writer, http.StatusOK, resp)
		return
	}

	currentKeys, err := client.ClientAPIKeys(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	if auditErr := h.recordAudit(request, "api_key.create", "client_api_key", fmt.Sprintf("index:%d", len(currentKeys)), "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; key creation aborted")
		return
	}

	createdIndex, err := h.operationsService().CreateKey(request.Context(), newKey, "")
	if err != nil {
		_ = h.recordAudit(request, "api_key.create", "client_api_key", fmt.Sprintf("index:%d", len(currentKeys)), "failure", map[string]any{"error": err.Error()})
		if err.Error() == "resource_conflict" {
			writeJSON(writer, http.StatusConflict, map[string]string{"error": "api key already exists", "code": "resource_conflict"})
			return
		}
		writeCPAFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, "api_key.create", "client_api_key", fmt.Sprintf("index:%d", len(currentKeys)), "success", nil)

	resp := map[string]any{
		"status":      "ok",
		"index":       createdIndex,
		"key":         security.MaskSecret(newKey),
		"fingerprint": fingerprint,
	}
	if usageFingerprint != "" {
		resp["usage_fingerprint"] = usageFingerprint
	}
	writeJSON(writer, http.StatusOK, resp)
}

func (h *Handler) updateClientAPIKey(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	rawIndex := chi.URLParam(request, "index")
	index, err := strconv.Atoi(rawIndex)
	if err != nil || index < 0 {
		writeError(writer, http.StatusBadRequest, "invalid key index")
		return
	}

	var req createClientKeyRequest
	if err := decodeManagementJSON(writer, request, 8*1024, &req); err != nil {
		return
	}
	updatedKey := strings.TrimSpace(req.Key)
	if updatedKey == "" {
		writeError(writer, http.StatusBadRequest, "api key cannot be empty")
		return
	}
	if len(updatedKey) > 8192 {
		writeError(writer, http.StatusBadRequest, "api key exceeds maximum length")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	fingerprint := security.FingerprintOrRedacted(h.cipher, "client-key", updatedKey)
	usageFingerprint, _ := h.repo.UsageClientKeyFingerprint(updatedKey)
	expectedFingerprint := strings.TrimSpace(req.ExpectedFingerprint)
	targetLabel := fmt.Sprintf("index:%d", index)

	if h.stateCoord != nil {
		observed, loadErr := statecoord.ProjectTyped(request.Context(), h.stateCoord, func(state projectedConfigState, _ uint64) (string, error) {
			if index >= len(state.ClientKeys) {
				return "", errClientKeyOutOfBounds
			}
			actual := strings.TrimSpace(state.ClientKeys[index])
			if expectedFingerprint != "" && security.FingerprintOrRedacted(h.cipher, "client-key", actual) != expectedFingerprint {
				return "", errClientKeyStaleIndex
			}
			return state.ClientKeys[index], nil
		})
		if loadErr != nil {
			if errors.Is(loadErr, errClientKeyOutOfBounds) {
				writeError(writer, http.StatusNotFound, "key index out of bounds")
				return
			}
			if errors.Is(loadErr, errClientKeyStaleIndex) {
				writeJSON(writer, http.StatusConflict, map[string]string{"error": loadErr.Error(), "code": "resource_conflict"})
				return
			}
			writeCPAFacadeError(writer, loadErr)
			return
		}
		expectedKey := observed.Data

		if auditErr := h.recordAudit(request, "api_key.update", "client_api_key", targetLabel, "attempt", nil); auditErr != nil {
			writeError(writer, http.StatusInternalServerError, "audit failure; key update aborted")
			return
		}

		version, mutErr := h.mutateCoordinatorWithAudit(request, stateDomainClientKeys, "api_key.update", "client_api_key", targetLabel, nil, func(state *projectedConfigState) error {
			if index >= len(state.ClientKeys) {
				return errClientKeyOutOfBounds
			}
			if state.ClientKeys[index] != expectedKey {
				return errClientKeyStaleIndex
			}
			if expectedFingerprint != "" && security.FingerprintOrRedacted(h.cipher, "client-key", strings.TrimSpace(state.ClientKeys[index])) != expectedFingerprint {
				return errClientKeyStaleIndex
			}
			for pos, existing := range state.ClientKeys {
				if pos != index && strings.TrimSpace(existing) == updatedKey {
					return errClientKeyDuplicate
				}
			}
			state.ClientKeys[index] = updatedKey
			return nil
		})
		if mutErr != nil {
			_ = h.recordAudit(request, "api_key.update", "client_api_key", targetLabel, "failure", map[string]any{"error": mutErr.Error()})
			if errors.Is(mutErr, errClientKeyOutOfBounds) {
				writeError(writer, http.StatusNotFound, "key index out of bounds")
				return
			}
			if errors.Is(mutErr, errClientKeyDuplicate) || errors.Is(mutErr, errClientKeyStaleIndex) {
				writeJSON(writer, http.StatusConflict, map[string]string{"error": mutErr.Error(), "code": "resource_conflict"})
				return
			}
			writeProviderWriteError(writer, mutErr)
			return
		}
		h.invalidateClientKeyCatalog()
		setStateVersionHeader(writer, version)
		resp := map[string]any{
			"status":      "ok",
			"index":       index,
			"key":         security.MaskSecret(updatedKey),
			"fingerprint": fingerprint,
			"version":     version,
		}
		if usageFingerprint != "" {
			resp["usage_fingerprint"] = usageFingerprint
		}
		writeJSON(writer, http.StatusOK, resp)
		return
	}

	if err := h.providerWrites.acquire(request.Context()); err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	defer h.providerWrites.release()

	currentKeys, err := client.ClientAPIKeys(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	if index >= len(currentKeys) {
		writeError(writer, http.StatusNotFound, "key index out of bounds")
		return
	}
	if expectedFingerprint != "" && security.FingerprintOrRedacted(h.cipher, "client-key", strings.TrimSpace(currentKeys[index])) != expectedFingerprint {
		writeJSON(writer, http.StatusConflict, map[string]string{"error": errClientKeyStaleIndex.Error(), "code": "resource_conflict"})
		return
	}
	for pos, existing := range currentKeys {
		if pos != index && strings.TrimSpace(existing) == updatedKey {
			writeJSON(writer, http.StatusConflict, map[string]string{"error": "api key already exists", "code": "resource_conflict"})
			return
		}
	}
	if auditErr := h.recordAudit(request, "api_key.update", "client_api_key", targetLabel, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; key update aborted")
		return
	}
	nextKeys := slices.Clone(currentKeys)
	nextKeys[index] = updatedKey
	if err := client.UpdateClientAPIKeys(request.Context(), nextKeys); err != nil {
		_ = h.recordAudit(request, "api_key.update", "client_api_key", targetLabel, "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}
	h.invalidateClientKeyCatalog()
	_ = h.recordAudit(request, "api_key.update", "client_api_key", targetLabel, "success", nil)
	resp := map[string]any{
		"status":      "ok",
		"index":       index,
		"key":         security.MaskSecret(updatedKey),
		"fingerprint": fingerprint,
	}
	if usageFingerprint != "" {
		resp["usage_fingerprint"] = usageFingerprint
	}
	writeJSON(writer, http.StatusOK, resp)
}

func (h *Handler) deleteClientAPIKey(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	rawIndex := chi.URLParam(request, "index")
	index, err := strconv.Atoi(rawIndex)
	if err != nil || index < 0 {
		writeError(writer, http.StatusBadRequest, "invalid key index")
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	expectedFingerprint := strings.TrimSpace(request.URL.Query().Get("expected_fingerprint"))

	if h.stateCoord != nil {
		observed, loadErr := statecoord.ProjectTyped(request.Context(), h.stateCoord, func(state projectedConfigState, _ uint64) (string, error) {
			if index >= len(state.ClientKeys) {
				return "", errClientKeyOutOfBounds
			}
			actual := strings.TrimSpace(state.ClientKeys[index])
			if expectedFingerprint != "" && security.FingerprintOrRedacted(h.cipher, "client-key", actual) != expectedFingerprint {
				return "", errClientKeyStaleIndex
			}
			return state.ClientKeys[index], nil
		})
		if loadErr != nil {
			if errors.Is(loadErr, errClientKeyOutOfBounds) {
				writeError(writer, http.StatusNotFound, "key index out of bounds")
				return
			}
			if errors.Is(loadErr, errClientKeyStaleIndex) {
				writeJSON(writer, http.StatusConflict, map[string]string{"error": loadErr.Error(), "code": "resource_conflict"})
				return
			}
			writeCPAFacadeError(writer, loadErr)
			return
		}
		expectedKey := observed.Data

		targetLabel := fmt.Sprintf("index:%d", index)
		if auditErr := h.recordAudit(request, "api_key.delete", "client_api_key", targetLabel, "attempt", nil); auditErr != nil {
			writeError(writer, http.StatusInternalServerError, "audit failure; key deletion aborted")
			return
		}

		version, mutErr := h.mutateCoordinatorWithAudit(request, stateDomainClientKeys, "api_key.delete", "client_api_key", targetLabel, nil, func(state *projectedConfigState) error {
			if index >= len(state.ClientKeys) {
				return errClientKeyOutOfBounds
			}
			if state.ClientKeys[index] != expectedKey {
				return errClientKeyStaleIndex
			}
			if expectedFingerprint != "" && security.FingerprintOrRedacted(h.cipher, "client-key", strings.TrimSpace(state.ClientKeys[index])) != expectedFingerprint {
				return errClientKeyStaleIndex
			}
			state.ClientKeys = append(state.ClientKeys[:index:index], state.ClientKeys[index+1:]...)
			return nil
		})
		if mutErr != nil {
			_ = h.recordAudit(request, "api_key.delete", "client_api_key", targetLabel, "failure", map[string]any{"error": mutErr.Error()})
			if errors.Is(mutErr, errClientKeyOutOfBounds) {
				writeError(writer, http.StatusNotFound, "key index out of bounds")
				return
			}
			if errors.Is(mutErr, errClientKeyStaleIndex) {
				writeJSON(writer, http.StatusConflict, map[string]string{"error": mutErr.Error(), "code": "resource_conflict"})
				return
			}
			writeProviderWriteError(writer, mutErr)
			return
		}
		h.invalidateClientKeyCatalog()
		setStateVersionHeader(writer, version)
		writeJSON(writer, http.StatusOK, map[string]any{
			"status":  "ok",
			"deleted": index,
			"version": version,
		})
		return
	}

	currentKeys, err := client.ClientAPIKeys(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	if index >= len(currentKeys) {
		writeError(writer, http.StatusNotFound, "key index out of bounds")
		return
	}
	if expectedFingerprint != "" && security.FingerprintOrRedacted(h.cipher, "client-key", strings.TrimSpace(currentKeys[index])) != expectedFingerprint {
		writeJSON(writer, http.StatusConflict, map[string]string{"error": errClientKeyStaleIndex.Error(), "code": "resource_conflict"})
		return
	}

	fingerprint, err := h.repo.UsageClientKeyFingerprint(strings.TrimSpace(currentKeys[index]))
	if err != nil {
		writeInternalError(writer, err)
		return
	}

	if auditErr := h.recordAudit(request, "api_key.delete", "client_api_key", fmt.Sprintf("index:%d", index), "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; key deletion aborted")
		return
	}

	if err := h.operationsService().DeleteKey(request.Context(), index, fingerprint, ""); err != nil {
		_ = h.recordAudit(request, "api_key.delete", "client_api_key", fmt.Sprintf("index:%d", index), "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, "api_key.delete", "client_api_key", fmt.Sprintf("index:%d", index), "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status":  "ok",
		"deleted": index,
	})
}
