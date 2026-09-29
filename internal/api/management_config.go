package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
)

type configPutScalarRequest struct {
	Value any `json:"value"`
}

type configSourcePutRequest struct {
	YAML     string `json:"yaml"`
	Revision string `json:"revision,omitempty"`
}

// managementConfigGet serves the configuration editor: CPA's v8 view of the
// stored file with secrets masked, the revision every save is checked against,
// and whether the stored file is still in the pre-v8 layout (its first save
// converts it, after a backup).
func (h *Handler) managementConfigGet(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	scalars, err := client.ConfigScalars(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	viewYAML, err := client.ConfigYAML(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	storedLayout := storedConfigLayoutUnknown
	if isV8, _, err := client.IsStoredConfigV8(request.Context()); err == nil {
		storedLayout = storedConfigLayoutLegacy
		if isV8 {
			storedLayout = storedConfigLayoutV8
		}
	}

	rev := configyaml.ComputeRevision(viewYAML)
	safeYAML, err := configyaml.SanitizeSafeYAML(viewYAML)
	if err != nil {
		safeYAML = ""
	}

	writer.Header().Set("ETag", fmt.Sprintf("%q", rev))
	writeJSON(writer, http.StatusOK, map[string]any{
		"scalars":        scalars,
		"supported_keys": management.KnownScalarKeys(),
		"revision":       rev,
		"safe_yaml":      safeYAML,
		"stored_layout":  storedLayout,
	})
}

// The layout of the stored file, which only decides whether the next save
// converts it. Every read and write of the editor is in the v8 layout either way.
const (
	storedConfigLayoutV8      = "v8"
	storedConfigLayoutLegacy  = "legacy"
	storedConfigLayoutUnknown = "unknown"
)

type configPatchRequest struct {
	Revision string                    `json:"revision"`
	Changes  []management.ConfigChange `json:"changes"`
}

// MAX_CONFIG_CHANGES bounds one save. The editor sends one change per edited
// setting, so a larger set is not something it produces.
const MAX_CONFIG_CHANGES = 256

// managementConfigPatch saves only the settings the operator changed.
//
// The revision check and the write happen under the provider write gate, for
// the same reason as a whole-document save: a check alone cannot see a write
// landing between it and the request to CPA. Masked secrets inside a submitted
// value are put back from the stored document, the same way a whole-document
// save restores them.
func (h *Handler) managementConfigPatch(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")

	var req configPatchRequest
	if err := decodeManagementJSON(writer, request, 2*1024*1024, &req); err != nil {
		return
	}
	defer request.Body.Close()
	if len(req.Changes) == 0 {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "no configuration changes to save", "code": "config_no_changes"})
		return
	}
	if len(req.Changes) > MAX_CONFIG_CHANGES {
		writeError(writer, http.StatusBadRequest, "too many configuration changes in one save")
		return
	}
	expectedRev := requestedConfigRevision(request, req.Revision)
	if expectedRev == "" {
		writeMissingRevision(writer)
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	if err := h.providerWrites.acquire(request.Context()); err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	defer h.providerWrites.release()
	h.configMu.Lock()
	defer h.configMu.Unlock()

	currentYAML, ok := h.currentConfigAtRevision(writer, request, client, expectedRev)
	if !ok {
		return
	}
	paths := make([]string, 0, len(req.Changes))
	for index, change := range req.Changes {
		paths = append(paths, strings.Join(change.Path, "."))
		if change.Remove {
			continue
		}
		restored, err := configyaml.RestoreSentinelsAt(change.Value, change.Path, currentYAML)
		if err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "failed to process configuration sentinels: " + err.Error(), "code": "config_sentinel_unrestorable"})
			return
		}
		req.Changes[index].Value = restored
	}

	if auditErr := h.recordAudit(request, "config.save_changes", "config", "config_changes", "attempt", map[string]any{"revision": expectedRev, "paths": paths}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; config save aborted")
		return
	}
	if err := client.ApplyConfigChanges(request.Context(), req.Changes); err != nil {
		_ = h.recordAudit(request, "config.save_changes", "config", "config_changes", "failure", configWriteFailureDetail(err, map[string]any{"paths": paths}))
		if errors.Is(err, management.ErrConfigPartiallyApplied) {
			h.afterConfigWrite()
		}
		if errors.Is(err, management.ErrInvalidConfigChange) {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"error": err.Error(), "code": "config_invalid_change"})
			return
		}
		writeCPAFacadeError(writer, scrubConfigRejection(err, currentYAML))
		return
	}
	h.afterConfigWrite()
	// The write landed. CPA renders what it stored in its own layout, so the
	// editor's next baseline is read back rather than assumed; when that read
	// fails the answer carries no baseline and the editor reloads instead.
	response := map[string]any{"status": "ok"}
	auditDetail := map[string]any{"paths": paths}
	if savedYAML, err := client.ConfigYAML(request.Context()); err == nil {
		newRev := configyaml.ComputeRevision(savedYAML)
		safeYAML, _ := configyaml.SanitizeSafeYAML(savedYAML)
		response["revision"] = newRev
		response["safe_yaml"] = safeYAML
		auditDetail["revision"] = newRev
		writer.Header().Set("ETag", fmt.Sprintf("%q", newRev))
	}
	if auditErr := h.recordAudit(request, "config.save_changes", "config", "config_changes", "success", auditDetail); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; operation aborted")
		return
	}
	writeJSON(writer, http.StatusOK, response)
}

// requestedConfigRevision reads the revision a save was prepared against.
func requestedConfigRevision(request *http.Request, bodyRevision string) string {
	expected := strings.Trim(strings.TrimSpace(request.Header.Get("If-Match")), `"`)
	if expected == "" {
		expected = strings.Trim(strings.TrimSpace(bodyRevision), `"`)
	}
	return expected
}

func writeMissingRevision(writer http.ResponseWriter) {
	writeJSON(writer, http.StatusBadRequest, map[string]any{
		"error": "config revision or If-Match header is required for conflict protection",
		"code":  "missing_revision",
	})
}

// currentConfigAtRevision reads the v8 view a save is based on and refuses the
// save when it is no longer the revision the operator edited.
func (h *Handler) currentConfigAtRevision(writer http.ResponseWriter, request *http.Request, client *management.Client, expectedRev string) (string, bool) {
	currentYAML, err := client.ConfigYAML(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return "", false
	}
	currentRev := configyaml.ComputeRevision(currentYAML)
	if !strings.EqualFold(expectedRev, currentRev) {
		writeJSON(writer, http.StatusConflict, map[string]any{
			"error":            "configuration has been modified by another session",
			"code":             "config_conflict",
			"current_revision": currentRev,
		})
		return "", false
	}
	return currentYAML, true
}

// afterConfigWrite drops what a configuration write may have made stale.
func (h *Handler) afterConfigWrite() {
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	// The saved document may have re-keyed a provider, so the masks resolved from
	// the credential lists it contains are no longer known to be current.
	h.providerKeyMasks.invalidate()
}

func (h *Handler) managementConfigPutScalar(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	key := chi.URLParam(request, "key")
	if key == "" {
		writeError(writer, http.StatusBadRequest, "config key is required")
		return
	}

	_, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	var req configPutScalarRequest
	if err := decodeManagementJSON(writer, request, 64*1024, &req); err != nil {
		return
	}
	defer request.Body.Close()

	validatedVal, err := validateScalarValue(key, req.Value)
	if err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}

	if auditErr := h.recordAudit(request, "config.save_scalar", "config", key, "attempt", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; config save aborted")
		return
	}
	if err := h.operationsService().SetScalar(request.Context(), key, validatedVal, ""); err != nil {
		_ = h.recordAudit(request, "config.save_scalar", "config", key, "failure", map[string]any{"error": err.Error()})
		if err.Error() == "write_busy" {
			writeProviderWriteError(writer, errProviderWriteBusy)
		} else {
			writeCPAFacadeError(writer, err)
		}
		return
	}
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	if auditErr := h.recordAudit(request, "config.save_scalar", "config", key, "success", map[string]any{"key": key}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; operation aborted")
		return
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"status": "ok",
		"key":    key,
		"value":  validatedVal,
	})
}

func validateScalarValue(key string, value any) (any, error) {
	return operations.ValidateScalarValue(key, value)
}

// managementConfigSourceGet returns CPA's v8 view of config.yaml, secrets
// included.
//
// There is no step-up authentication here, and that is deliberate. This used to
// require a short-lived grant obtained by re-entering the CPA management key,
// which meant an operator who had already authenticated to reach this console had
// to prove the same secret again to read the file they had just been editing
// through the visual editor. The management key is the console's only credential,
// so the session that satisfies this handler already carries exactly the authority
// the grant was re-checking; the second prompt added a step without adding a
// boundary, and the PUT below it never required a grant at all.
//
// Reading the raw source is still the most sensitive configuration action, so what
// remains is the part that carries real weight: the route sits behind the same
// authenticated session as every other /management call, the response is marked
// no-store, and the reveal is audited fail-closed - if the audit record cannot be
// written the read is refused rather than served unaudited.
func (h *Handler) managementConfigSourceGet(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	yamlStr, err := client.ConfigYAML(request.Context())
	if err != nil {
		_ = h.recordAudit(request, "config.reveal_source", "config", "config_source_yaml", "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}
	rev := configyaml.ComputeRevision(yamlStr)
	if auditErr := h.recordAudit(request, "config.reveal_source", "config", "config_source_yaml", "success", map[string]any{"revision": rev, "size_bytes": len(yamlStr)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; config reveal aborted")
		return
	}

	writer.Header().Set("ETag", fmt.Sprintf("%q", rev))
	writeJSON(writer, http.StatusOK, map[string]any{
		"yaml":       yamlStr,
		"size_bytes": len(yamlStr),
		"revision":   rev,
	})
}

// managementConfigSourcePut replaces the whole document from source mode. CPA
// validates it as a v8 document and refuses legacy field names itself, so a
// document it accepts is fully effective. The answer carries CPA's rendering of
// what it stored, which is the text the next save is compared against.
func (h *Handler) managementConfigSourcePut(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")

	var req configSourcePutRequest
	if err := decodeManagementJSON(writer, request, 2*1024*1024, &req); err != nil {
		return
	}
	defer request.Body.Close()

	if strings.TrimSpace(req.YAML) == "" {
		writeError(writer, http.StatusBadRequest, "configuration YAML cannot be empty")
		return
	}

	if synErr := configyaml.ValidateSyntax([]byte(req.YAML)); synErr != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{
			"error":  "invalid YAML syntax: " + synErr.Error(),
			"code":   "yaml_syntax_error",
			"line":   synErr.Line,
			"column": synErr.Column,
		})
		return
	}

	expectedRev := requestedConfigRevision(request, req.Revision)
	if expectedRev == "" {
		writeMissingRevision(writer)
		return
	}

	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	// The provider write gate covers this whole read-check-write as well. The
	// revision check below detects a change that already landed, but it cannot
	// detect one landing between the read and the PUT; a provider handler writing
	// the same configuration document in that gap would be silently overwritten
	// even though the revision check passed. Acquired before configMu so that
	// mutex, which serialises config saves against each other, is not held while
	// waiting for a provider write to finish.
	if err := h.providerWrites.acquire(request.Context()); err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	defer h.providerWrites.release()

	h.configMu.Lock()
	defer h.configMu.Unlock()

	currentYAML, ok := h.currentConfigAtRevision(writer, request, client, expectedRev)
	if !ok {
		return
	}

	finalYAML, err := configyaml.RestoreSentinels(req.YAML, currentYAML)
	if err != nil {
		writeError(writer, http.StatusBadRequest, "failed to process configuration sentinels: "+err.Error())
		return
	}

	if auditErr := h.recordAudit(request, "config.save_source", "config", "config_source_yaml", "attempt", map[string]any{"revision": expectedRev, "size_bytes": len(finalYAML)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; config save aborted")
		return
	}
	if err := client.UpdateConfigYAML(request.Context(), finalYAML); err != nil {
		_ = h.recordAudit(request, "config.save_source", "config", "config_source_yaml", "failure", map[string]any{"error": publicCPAErrorMessage(err)})
		writeCPAFacadeError(writer, scrubConfigRejection(err, currentYAML))
		return
	}

	h.afterConfigWrite()
	response := map[string]any{"status": "ok"}
	auditDetail := map[string]any{"size_bytes": len(finalYAML)}
	if savedYAML, err := client.ConfigYAML(request.Context()); err == nil {
		newRev := configyaml.ComputeRevision(savedYAML)
		response["revision"] = newRev
		response["yaml"] = savedYAML
		response["size_bytes"] = len(savedYAML)
		auditDetail["revision"] = newRev
		writer.Header().Set("ETag", fmt.Sprintf("%q", newRev))
	}
	if auditErr := h.recordAudit(request, "config.save_source", "config", "config_source_yaml", "success", auditDetail); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; operation aborted")
		return
	}
	writeJSON(writer, http.StatusOK, response)
}
