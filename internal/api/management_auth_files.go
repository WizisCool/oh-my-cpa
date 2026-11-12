package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/statecoord"
)

const (
	managementAuthFileRequestLimit = 256 * 1024
	managementAuthFileUploadLimit  = 16 * 1024 * 1024
	managementAuthFileNameLimit    = 255
	managementAuthFileListLimit    = 2000
	managementAuthFileFieldLimit   = 4096
)

var errManagementAuthFileNotFound = errors.New("auth file not found")

// The auth-files facade deliberately projects CPA entries into a browser-safe
// shape. Account, path, token, metadata, and other credential-bearing fields
// are not part of this DTO; downloads are a separate, explicit admin action.
type managementAuthFileResponse struct {
	RecoverySupported    bool                              `json:"recovery_supported,omitempty"`
	RequiresSignIn       *bool                             `json:"requires_sign_in,omitempty"`
	RenewalState         string                            `json:"renewal_state,omitempty"`
	RecoveryStage        string                            `json:"recovery_stage,omitempty"`
	AccessTokenExpiresAt string                            `json:"access_token_expires_at,omitempty"`
	NextRefreshAfter     string                            `json:"next_refresh_after,omitempty"`
	Adopted              *bool                             `json:"adopted,omitempty"`
	InferenceVerified    *bool                             `json:"inference_verified,omitempty"`
	RenewalVerified      *bool                             `json:"renewal_verified,omitempty"`
	RefreshError         *managementCredentialRefreshError `json:"refresh_error,omitempty"`
	NextAction           string                            `json:"next_action,omitempty"`

	SIWCStatus        string                                `json:"siwc_status,omitempty"`
	SIWCBindSupported bool                                  `json:"siwc_bind_supported"`
	UseSIWC           bool                                  `json:"use_siwc"`
	SIWCBound         bool                                  `json:"siwc_bound"`
	SIWCExpiresAt     string                                `json:"siwc_expires_at,omitempty"`
	Name              string                                `json:"name"`
	AuthIndex         string                                `json:"auth_index,omitempty"`
	Type              string                                `json:"type,omitempty"`
	Provider          string                                `json:"provider,omitempty"`
	OAuthProvider     string                                `json:"oauth_provider,omitempty"`
	Status            string                                `json:"status,omitempty"`
	StatusMessage     string                                `json:"status_message,omitempty"`
	Disabled          bool                                  `json:"disabled"`
	Unavailable       bool                                  `json:"unavailable"`
	RuntimeOnly       bool                                  `json:"runtime_only"`
	Email             string                                `json:"email,omitempty"`
	ProjectID         string                                `json:"project_id,omitempty"`
	Success           int64                                 `json:"success"`
	Failed            int64                                 `json:"failed"`
	RecentRequests    []managementAuthFileRequestBucket     `json:"recent_requests,omitempty"`
	Quota             *managementQuotaObservation           `json:"quota,omitempty"`
	ModelQuotas       map[string]managementQuotaObservation `json:"model_quotas,omitempty"`
	Models            []managementAuthFileModel             `json:"models,omitempty"`
	Priority          int                                   `json:"priority,omitempty"`
	Weight            int64                                 `json:"weight,omitempty"`
	Note              string                                `json:"note,omitempty"`
	// DisplayName is the operator's own name for the credential, kept by Oh My
	// CPA rather than CPA; DisplayNameVersion is what a rename must quote back.
	DisplayName        string `json:"display_name,omitempty"`
	DisplayNameVersion int64  `json:"display_name_version,omitempty"`
}

type managementCredentialRefreshError struct {
	Code       string `json:"code,omitempty"`
	HTTPStatus int    `json:"http_status,omitempty"`
}

type managementAuthFileRequestBucket struct {
	Time    string `json:"time,omitempty"`
	Success int64  `json:"success"`
	Failed  int64  `json:"failed"`
}

type managementAuthFileModel struct {
	ID          string `json:"id"`
	DisplayName string `json:"display_name,omitempty"`
}

type managementQuotaObservation struct {
	ObservedAt string            `json:"observed_at,omitempty"`
	Signals    map[string]string `json:"signals,omitempty"`
}

type managementAuthFilesResponse struct {
	Files []managementAuthFileResponse `json:"files"`
	Total int                          `json:"total"`
}

// MarshalJSON preserves raw proxy authentication only for server-side write
// verification. Browser drafts receive a stable route display, so unchanged
// proxy fields remain absent from patches of other credential settings.
func (fields managementAuthFileSafeFields) MarshalJSON() ([]byte, error) {
	type wireFields managementAuthFileSafeFields
	safe := wireFields(fields)
	if safe.ProxyURL != "" {
		parsed, err := url.Parse(safe.ProxyURL)
		if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
			if !strings.EqualFold(safe.ProxyURL, "direct") && !strings.EqualFold(safe.ProxyURL, "none") {
				safe.ProxyURL = security.RedactedValue
			}
		} else {
			if parsed.User != nil {
				parsed.User = url.User(security.RedactedValue)
			}
			parsed.RawQuery, parsed.Fragment, parsed.RawFragment = "", "", ""
			safe.ProxyURL = parsed.String()
		}
	}
	return json.Marshal(safe)
}

// managementAuthFileSafeFields is the allowlisted subset of an auth file that
// the edit drawer may read. The raw file is downloaded only inside the Go
// process; credentials, tokens and free-form metadata never enter the response.
type managementAuthFileSafeFields struct {
	UseSIWC        *bool    `json:"use_siwc,omitempty"`
	Name           string   `json:"name"`
	Priority       *int     `json:"priority,omitempty"`
	Weight         *int64   `json:"weight,omitempty"`
	Prefix         string   `json:"prefix,omitempty"`
	ProxyURL       string   `json:"proxy_url,omitempty"`
	Expired        string   `json:"expired,omitempty"`
	DisableCooling bool     `json:"disable_cooling"`
	Websockets     bool     `json:"websockets"`
	UsingAPI       bool     `json:"using_api"`
	Note           string   `json:"note,omitempty"`
	ExcludedModels []string `json:"excluded_models,omitempty"`
	// RequestRetry is nil when the credential inherits the retry count.
	RequestRetry *int `json:"request_retry,omitempty"`
	// ErrorRules are the credential's own request-scoped error rules, which
	// replace its channel's while the list is not empty.
	ErrorRules []ProviderErrorRuleDTO `json:"request_scoped_errors,omitempty"`
	// ModelAliases are the credential's own aliases, resolved before its
	// provider's OAuth aliases.
	ModelAliases []managementOAuthModelAlias `json:"model_aliases,omitempty"`
	// OpenAPI is nil while a Vertex service account leaves the partner-model
	// route to CPA's model-name detection; false is an explicit opt-out.
	OpenAPI *bool `json:"openapi,omitempty"`
	// OpenAPILocation overrides the credential's location for that route only.
	OpenAPILocation string   `json:"openapi_location,omitempty"`
	OpenAPIModels   []string `json:"openapi_models,omitempty"`
	// OpenAPILegacyModels are names CPA also registers from the credential's
	// `models` key. The console never writes that key, so they are reported
	// rather than edited: removing a name from OpenAPIModels does not remove it.
	OpenAPILegacyModels []string `json:"openapi_legacy_models,omitempty"`
}

func (h *Handler) listManagementAuthFiles(writer http.ResponseWriter, request *http.Request) {
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	var (
		rawFiles     []management.AuthFile
		stateVersion uint64
	)
	if files, err := client.AuthFiles(request.Context()); err == nil {
		rawFiles = files.Files
		if h.stateCoord != nil {
			if envelope, coordErr := h.stateCoord.Read(request.Context()); coordErr == nil {
				stateVersion = envelope.Version
				if len(envelope.Data.PendingAuthStatus) > 0 {
					for idx := range rawFiles {
						for _, pending := range envelope.Data.PendingAuthStatus {
							if rawFiles[idx].Name != pending.Name && rawFiles[idx].ID != pending.Name {
								continue
							}
							if pending.AuthIndex != "" && rawFiles[idx].AuthIndex != pending.AuthIndex {
								continue
							}
							rawFiles[idx].Disabled = pending.Disabled
							if pending.Disabled {
								rawFiles[idx].Status = "disabled"
							} else if rawFiles[idx].Status == "disabled" {
								rawFiles[idx].Status = "ready"
							}
						}
					}
				}
			}
		}
	} else if h.stateCoord != nil {
		if envelope, coordErr := h.stateCoord.Read(request.Context()); coordErr == nil && !envelope.Data.AuthFilesUnavailable {
			rawFiles = envelope.Data.AuthFiles
			stateVersion = envelope.Version
		} else {
			writeCPAFacadeError(writer, err)
			return
		}
	} else {
		writeCPAFacadeError(writer, err)
		return
	}

	nameFilter := strings.TrimSpace(request.URL.Query().Get("name"))
	authIndexFilter := strings.TrimSpace(request.URL.Query().Get("auth_index"))
	projected := make([]managementAuthFileResponse, 0, len(rawFiles))
	for _, file := range rawFiles {
		if nameFilter != "" && file.Name != nameFilter && file.ID != nameFilter {
			continue
		}
		if authIndexFilter != "" && file.AuthIndex != authIndexFilter {
			continue
		}
		projected = append(projected, projectManagementAuthFile(file))
		if len(projected) >= managementAuthFileListLimit {
			break
		}
	}
	if h.repo != nil {
		names, namesErr := h.repo.ListCredentialDisplayNames(request.Context(), defaultInstanceID())
		if namesErr != nil {
			writeError(writer, http.StatusInternalServerError, "failed to read credential names")
			return
		}
		for index := range projected {
			if stored, isNamed := names[projected[index].Name]; isNamed {
				projected[index].DisplayName = stored.DisplayName
				projected[index].DisplayNameVersion = stored.Version
			}
		}
	}
	sort.Slice(projected, func(i, j int) bool {
		return strings.ToLower(projected[i].Name) < strings.ToLower(projected[j].Name)
	})
	setStateVersionHeader(writer, stateVersion)
	writeJSON(writer, http.StatusOK, managementAuthFilesResponse{Files: projected, Total: len(projected)})
}

func (h *Handler) patchManagementAuthFileStatus(writer http.ResponseWriter, request *http.Request) {
	var payload struct {
		Name      string `json:"name"`
		AuthIndex string `json:"auth_index"`
		Disabled  *bool  `json:"disabled"`
	}
	if err := decodeManagementJSON(writer, request, managementAuthFileRequestLimit, &payload); err != nil {
		return
	}
	name, selectorErr := validateAuthSelector(payload.Name)
	if selectorErr != nil {
		writeError(writer, http.StatusBadRequest, selectorErr.Error())
		return
	}
	if payload.Disabled == nil {
		writeError(writer, http.StatusBadRequest, "disabled is required")
		return
	}
	if len(payload.AuthIndex) > managementAuthFileNameLimit {
		writeError(writer, http.StatusBadRequest, "auth_index is too long")
		return
	}
	if _, ok := h.managementClientOrError(writer, request); !ok {
		return
	}
	if err := h.recordAudit(request, "auth_file.status_update", "auth_file", name, "attempt", nil); err != nil {
		writeInternalError(writer, err)
		return
	}
	trimmedAuthIndex := strings.TrimSpace(payload.AuthIndex)
	if h.stateCoord != nil {
		var useFallback bool
		var canonicalSelector string
		if env, readErr := statecoord.ProjectTyped(request.Context(), h.stateCoord, func(state projectedConfigState, _ uint64) (string, error) {
			if state.AuthFilesUnavailable {
				return "", errStateSliceUnavailable
			}
			matches := 0
			var matched management.AuthFile
			for idx := range state.AuthFiles {
				file := state.AuthFiles[idx]
				if file.Name != name && file.ID != name {
					continue
				}
				if trimmedAuthIndex != "" && file.AuthIndex != trimmedAuthIndex {
					continue
				}
				matched = file
				matches++
			}
			if matches != 1 {
				return "", errStateSliceUnavailable
			}
			canonicalName := firstNonEmpty(matched.Name, matched.ID)
			return encodeAuthFileSelector(canonicalName, strings.TrimSpace(matched.AuthIndex)), nil
		}); readErr == nil {
			canonicalSelector = env.Data
		} else {
			useFallback = true
		}

		if !useFallback {
			domain := statecoord.DomainKey(stateDomainAuthFileStatusPrefix + canonicalSelector)
			version, mutErr := h.mutateCoordinatorWithAudit(
				request,
				domain,
				"auth_file.status_update",
				"auth_file",
				name,
				map[string]any{"disabled": *payload.Disabled},
				func(state *projectedConfigState) error {
					if state.AuthFilesUnavailable {
						useFallback = true
						return errStateSliceUnavailable
					}
					matches := 0
					var matchedIdx int
					for idx := range state.AuthFiles {
						file := &state.AuthFiles[idx]
						if file.Name != name && file.ID != name {
							continue
						}
						if trimmedAuthIndex != "" && file.AuthIndex != trimmedAuthIndex {
							continue
						}
						matchedIdx = idx
						matches++
					}
					if matches != 1 {
						useFallback = true
						return errStateSliceUnavailable
					}
					matched := &state.AuthFiles[matchedIdx]
					canonicalName := firstNonEmpty(matched.Name, matched.ID)
					canonicalAuthIndex := strings.TrimSpace(matched.AuthIndex)
					if encodeAuthFileSelector(canonicalName, canonicalAuthIndex) != canonicalSelector {
						useFallback = true
						return errStateSliceUnavailable
					}
					matched.Disabled = *payload.Disabled
					if state.PendingAuthStatus == nil {
						state.PendingAuthStatus = make(map[string]pendingAuthFileStatus)
					}
					state.AuthStatusSeq++
					state.PendingAuthStatus[canonicalSelector] = pendingAuthFileStatus{
						Name:      canonicalName,
						AuthIndex: canonicalAuthIndex,
						Disabled:  *payload.Disabled,
						Seq:       state.AuthStatusSeq,
					}
					return nil
				},
			)
			if !useFallback {
				if mutErr != nil {
					_ = h.recordAudit(request, "auth_file.status_update", "auth_file", name, "failure", map[string]any{"error": mutErr.Error()})
					writeProviderWriteError(writer, mutErr)
					return
				}
				setStateVersionHeader(writer, version)
				writeJSON(writer, http.StatusOK, map[string]any{
					"status":   "ok",
					"disabled": *payload.Disabled,
					"version":  version,
				})
				return
			}
		}
	}
	if err := h.operationsService().SetCredentialStatus(request.Context(), operations.CredentialTarget{Name: name, AuthIndex: trimmedAuthIndex}, *payload.Disabled, ""); err != nil {
		_ = h.recordAudit(request, "auth_file.status_update", "auth_file", name, "failure", map[string]any{"error": publicCPAErrorMessage(err)})
		writeCPAFacadeError(writer, err)
		return
	}
	_ = h.recordAudit(request, "auth_file.status_update", "auth_file", name, "success", map[string]any{"disabled": *payload.Disabled})

	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "disabled": *payload.Disabled})
}

// refreshManagementAuthFile renews one credential's tokens on demand. The
// response states the outcome only: CPA's own answer carries the new tokens.
func (h *Handler) refreshManagementAuthFile(writer http.ResponseWriter, request *http.Request) {
	var payload struct {
		Name      string `json:"name"`
		AuthIndex string `json:"auth_index"`
	}
	if err := decodeManagementJSON(writer, request, managementAuthFileRequestLimit, &payload); err != nil {
		return
	}
	name, selectorErr := validateAuthSelector(payload.Name)
	if selectorErr != nil {
		writeError(writer, http.StatusBadRequest, selectorErr.Error())
		return
	}
	authIndex := strings.TrimSpace(payload.AuthIndex)
	if len([]rune(authIndex)) > managementAuthFileNameLimit {
		writeError(writer, http.StatusBadRequest, "auth_index is too long")
		return
	}
	if _, ok := h.managementClientOrError(writer, request); !ok {
		return
	}
	if err := h.recordAudit(request, "auth_file.refresh", "auth_file", name, "attempt", nil); err != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; refresh aborted")
		return
	}
	if err := h.operationsService().RefreshCredential(request.Context(), operations.CredentialTarget{Name: name, AuthIndex: authIndex}, ""); err != nil {
		// CPA's reason quotes the provider's token endpoint, so the audit entry
		// keeps the status alone.
		detail := map[string]any{"error": "refresh failed"}
		var httpErr *management.HTTPError
		if errors.As(err, &httpErr) {
			detail["cpa_status"] = httpErr.StatusCode
		}
		_ = h.recordAudit(request, "auth_file.refresh", "auth_file", name, "failure", detail)
		if err.Error() == "resource_conflict" {
			writeError(writer, http.StatusNotFound, "auth file not found")
			return
		}
		writeCPAFacadeError(writer, err)
		return
	}
	// The upstream mutation has landed; an outcome-audit failure must not invite
	// a retry that renews or replaces the credential again.
	_ = h.recordAudit(request, "auth_file.refresh", "auth_file", name, "success", nil)
	h.invalidateCoordinator("management-auth-files", "management-quota")
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok"})
}

func (h *Handler) getManagementAuthFileSafeFields(writer http.ResponseWriter, request *http.Request) {
	name, selectorErr := validateAuthSelector(request.URL.Query().Get("name"))
	if selectorErr != nil {
		writeError(writer, http.StatusBadRequest, selectorErr.Error())
		return
	}
	authIndex := strings.TrimSpace(request.URL.Query().Get("auth_index"))
	if len([]rune(authIndex)) > managementAuthFileNameLimit {
		writeError(writer, http.StatusBadRequest, "auth_index is too long")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	fields, err := h.readManagementAuthFileSafeFields(request.Context(), client, name, authIndex)
	if err != nil {
		_ = h.recordAudit(request, "auth_file.fields_read", "auth_file", name, "failure", map[string]any{"error": err.Error()})
		if errors.Is(err, errManagementAuthFileNotFound) {
			writeError(writer, http.StatusNotFound, "auth file not found")
			return
		}
		writeCPAFacadeError(writer, err)
		return
	}
	if auditErr := h.recordAudit(request, "auth_file.fields_read", "auth_file", name, "success", nil); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; safe fields were not returned")
		return
	}
	writeJSON(writer, http.StatusOK, fields)
}

func (h *Handler) readManagementAuthFileSafeFields(ctx context.Context, client *management.Client, name, authIndex string) (managementAuthFileSafeFields, error) {
	if _, err := findManagementAuthFileFromClient(ctx, client, name, authIndex); err != nil {
		return managementAuthFileSafeFields{}, err
	}
	data, _, err := client.DownloadAuthFile(ctx, name)
	if err != nil {
		return managementAuthFileSafeFields{}, err
	}
	return projectManagementAuthFileSafeFields(name, data)
}

func findManagementAuthFileFromClient(ctx context.Context, client *management.Client, name, authIndex string) (management.AuthFile, error) {
	files, err := client.AuthFiles(ctx)
	if err != nil {
		return management.AuthFile{}, err
	}
	file, ok := findManagementAuthFile(files.Files, name, authIndex)
	if !ok {
		return management.AuthFile{}, errManagementAuthFileNotFound
	}
	return file, nil
}

func findManagementAuthFile(files []management.AuthFile, name, authIndex string) (management.AuthFile, bool) {
	name = strings.TrimSpace(name)
	authIndex = strings.TrimSpace(authIndex)
	for _, file := range files {
		if file.Name != name && file.ID != name {
			continue
		}
		if authIndex != "" && file.AuthIndex != authIndex {
			continue
		}
		return file, true
	}
	return management.AuthFile{}, false
}

func (h *Handler) downloadManagementAuthFile(writer http.ResponseWriter, request *http.Request) {
	name, validationErr := validateJSONUploadName(request.URL.Query().Get("name"))
	if validationErr != nil {
		writeError(writer, http.StatusBadRequest, validationErr.Error())
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	data, _, err := client.DownloadAuthFile(request.Context(), name)
	if err != nil {
		_ = h.recordAudit(request, "auth_file.download", "auth_file", name, "failure", map[string]any{"error": err.Error()})
		writeCPAFacadeError(writer, err)
		return
	}
	if auditErr := h.recordAudit(request, "auth_file.download", "auth_file", name, "success", map[string]any{"size_bytes": len(data)}); auditErr != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; download aborted")
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(data)
}

func (h *Handler) listManagementAuthFileModels(writer http.ResponseWriter, request *http.Request) {
	name, selectorErr := validateAuthSelector(request.URL.Query().Get("name"))
	if selectorErr != nil {
		writeError(writer, http.StatusBadRequest, selectorErr.Error())
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	models, err := client.AuthFileModels(request.Context(), name)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	projected := make([]managementAuthFileModel, 0, len(models))
	for _, model := range models {
		id := boundedText(model.ID, managementAuthFileFieldLimit)
		if id == "" {
			continue
		}
		projected = append(projected, managementAuthFileModel{ID: id, DisplayName: boundedText(model.DisplayName, managementAuthFileFieldLimit)})
		if len(projected) >= managementAuthFileListLimit {
			break
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"models": projected})
}

func validateAuthSelector(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || len([]rune(name)) > managementAuthFileNameLimit || name == "." || name == ".." {
		return "", errors.New("invalid auth file name")
	}
	if filepath.VolumeName(name) != "" || strings.ContainsAny(name, "/\\:") {
		return "", errors.New("invalid auth file name")
	}
	for _, char := range name {
		if unicode.IsControl(char) {
			return "", errors.New("invalid auth file name")
		}
	}
	return name, nil
}
