package api

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
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
	includeKeys := strings.EqualFold(request.URL.Query().Get("include_keys"), "true")

	keys, err := client.ClientAPIKeys(request.Context())
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

	writeJSON(writer, http.StatusOK, map[string]any{
		"keys":  items,
		"total": len(items),
	})
}

type createClientKeyRequest struct {
	Key string `json:"key"`
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

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	currentKeys, err := client.ClientAPIKeys(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	updated := append(currentKeys, newKey)
	if auditErr := h.recordAudit(request, "api_key.create", "client_api_key", fmt.Sprintf("index:%d", len(currentKeys)), "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; key creation aborted")
		return
	}

	if err := client.UpdateClientAPIKeys(request.Context(), updated); err != nil {
		_ = h.recordAudit(request, "api_key.create", "client_api_key", fmt.Sprintf("index:%d", len(currentKeys)), "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}

	_ = h.recordAudit(request, "api_key.create", "client_api_key", fmt.Sprintf("index:%d", len(currentKeys)), "success", nil)

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"index":  len(currentKeys),
		// The requester just sent this value, so the response identifies the row it
		// added rather than echoing a secret back through a body.
		"key": security.MaskSecret(newKey),
	})
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

	currentKeys, err := client.ClientAPIKeys(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}

	if index >= len(currentKeys) {
		writeError(writer, http.StatusNotFound, "key index out of bounds")
		return
	}

	updated := make([]string, 0, len(currentKeys)-1)
	for i, key := range currentKeys {
		if i != index {
			updated = append(updated, key)
		}
	}

	if auditErr := h.recordAudit(request, "api_key.delete", "client_api_key", fmt.Sprintf("index:%d", index), "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; key deletion aborted")
		return
	}

	if err := client.UpdateClientAPIKeys(request.Context(), updated); err != nil {
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
