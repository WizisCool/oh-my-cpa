package api

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	"github.com/oh-my-cpa/oh-my-cpa/internal/outbound"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type outboundProxyDTO struct {
	Mode           string `json:"mode"`
	Address        string `json:"address"`
	HasCredentials bool   `json:"has_credentials"`
	NoProxy        string `json:"no_proxy"`
	Revision       int64  `json:"revision"`
	CPARevision    string `json:"cpa_revision"`
	CPAInSync      bool   `json:"cpa_in_sync"`
}

func projectOutboundProxy(settings repository.OutboundProxySettings, revision int64, cpaRevision string, cpaInSync bool) outboundProxyDTO {
	result := outboundProxyDTO{Mode: settings.Mode, NoProxy: settings.NoProxy, Revision: revision, CPARevision: cpaRevision, CPAInSync: cpaInSync}
	if parsed, err := url.Parse(settings.URL); err == nil && parsed.Host != "" {
		result.HasCredentials = parsed.User != nil
		parsed.User = nil
		result.Address = parsed.String()
	}
	return result
}

func cpaProxyMatches(settings repository.OutboundProxySettings, view map[string]any) bool {
	// The deployment default leaves CPA's own configuration alone, so OMC has no
	// value of its own to compare and none of CPA's to dispute.
	if settings.Mode == outbound.ModeEnvironment {
		return true
	}
	actual, found := management.ValueAt(view, []string{"requests", "proxy-url"})
	actualProxy, isString := actual.(string)
	if found && actual != nil && !isString {
		return false
	}
	expectedProxy := ""
	switch settings.Mode {
	case outbound.ModeDirect:
		expectedProxy = "direct"
	case outbound.ModeProxy:
		expectedProxy = settings.URL
	}
	return strings.TrimSpace(actualProxy) == expectedProxy
}

// cpaProxyRemoved reports whether CPA no longer carries requests.proxy-url.
func cpaProxyRemoved(view map[string]any) bool {
	actual, found := management.ValueAt(view, []string{"requests", "proxy-url"})
	if !found || actual == nil {
		return true
	}
	value, isString := actual.(string)
	return isString && strings.TrimSpace(value) == ""
}

func (h *Handler) getOutboundProxy(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	store := repository.OutboundProxyStore{Repo: h.repo, Cipher: h.cipher}
	settings, revision, err := store.Load(request.Context())
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "outbound proxy settings are unavailable")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	yaml, err := client.ConfigYAML(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	inSync := true
	if revision > 0 {
		view, _, err := client.ConfigView(request.Context())
		if err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		inSync = cpaProxyMatches(settings, view)
	}
	writeJSON(writer, http.StatusOK, projectOutboundProxy(settings, revision, configyaml.ComputeRevision(yaml), inSync))
}

type outboundProxyInput struct {
	Mode        string  `json:"mode"`
	URL         *string `json:"url"`
	NoProxy     string  `json:"no_proxy"`
	Revision    int64   `json:"revision"`
	CPARevision string  `json:"cpa_revision"`
}

func (h *Handler) putOutboundProxy(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var input outboundProxyInput
	if err := decodeManagementJSON(writer, request, 8192, &input); err != nil {
		return
	}
	store := repository.OutboundProxyStore{Repo: h.repo, Cipher: h.cipher}
	// Everything that decides the CPA write is read under the same gate that orders
	// it, so a concurrent save cannot strand OMC's settings behind a CPA change.
	if err := h.providerWrites.acquire(request.Context()); err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	defer h.providerWrites.release()
	h.configMu.Lock()
	defer h.configMu.Unlock()
	current, revision, err := store.Load(request.Context())
	if err != nil {
		writeError(writer, http.StatusServiceUnavailable, "outbound proxy settings are unavailable")
		return
	}
	if input.Revision != revision {
		writeError(writer, http.StatusConflict, "outbound proxy settings changed; reload and retry")
		return
	}
	settings := repository.OutboundProxySettings{Mode: input.Mode, NoProxy: strings.TrimSpace(input.NoProxy)}
	if input.URL != nil {
		settings.URL = strings.TrimSpace(*input.URL)
	} else if input.Mode == outbound.ModeProxy {
		settings.URL = current.URL
	}
	if err := outbound.Validate(settings); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid outbound proxy settings")
		return
	}
	if input.CPARevision == "" {
		writeMissingRevision(writer)
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	currentYAML, ok := h.currentConfigAtRevision(writer, request, client, input.CPARevision)
	if !ok {
		return
	}
	cpaRevision := configyaml.ComputeRevision(currentYAML)
	if err := h.recordAudit(request, "outbound_proxy.save", "config", "outbound_proxy", "attempt", map[string]any{"mode": settings.Mode}); err != nil {
		writeError(writer, http.StatusInternalServerError, "audit log failure; proxy save aborted")
		return
	}
	// Selecting the deployment default withdraws only a value OMC wrote earlier. A
	// proxy the operator configured in CPA belongs to CPA and stays untouched.
	ownsCPAProxy := revision > 0 && current.Mode != outbound.ModeEnvironment
	shouldWriteCPA := settings.Mode != outbound.ModeEnvironment || ownsCPAProxy
	if shouldWriteCPA {
		change := management.ConfigChange{Path: []string{"requests", "proxy-url"}}
		switch settings.Mode {
		case outbound.ModeEnvironment:
			change.Remove = true
		case outbound.ModeDirect:
			change.Value = "direct"
		case outbound.ModeProxy:
			change.Value = settings.URL
		}
		if err := client.ApplyConfigChanges(request.Context(), []management.ConfigChange{change}); err != nil {
			_ = h.recordAudit(request, "outbound_proxy.save", "config", "outbound_proxy", "failure", map[string]any{"mode": settings.Mode})
			writeJSON(writer, http.StatusBadGateway, map[string]string{"error": "CPA proxy update could not be confirmed; reload settings", "code": "outbound_proxy_cpa_failed"})
			return
		}
		h.afterConfigWrite()
		view, _, err := client.ConfigView(request.Context())
		if err != nil {
			_ = h.recordAudit(request, "outbound_proxy.save", "config", "outbound_proxy", "failure", map[string]any{"mode": settings.Mode, "cpa_applied": true})
			writeJSON(writer, http.StatusBadGateway, map[string]string{"error": "CPA proxy readback failed; reload settings", "code": "outbound_proxy_cpa_unconfirmed"})
			return
		}
		if settings.Mode == outbound.ModeEnvironment {
			// The default route has no value of OMC's to compare, so the readback
			// only proves the withdrawal OMC asked for took effect.
			if !cpaProxyRemoved(view) {
				_ = h.recordAudit(request, "outbound_proxy.save", "config", "outbound_proxy", "failure", map[string]any{"mode": settings.Mode, "cpa_applied": true})
				writeJSON(writer, http.StatusConflict, map[string]string{"error": "CPA kept the previous proxy; reload settings", "code": "outbound_proxy_cpa_mismatch"})
				return
			}
		} else if !cpaProxyMatches(settings, view) {
			_ = h.recordAudit(request, "outbound_proxy.save", "config", "outbound_proxy", "failure", map[string]any{"mode": settings.Mode, "cpa_applied": true})
			writeJSON(writer, http.StatusConflict, map[string]string{"error": "CPA did not retain the selected route; reload settings", "code": "outbound_proxy_cpa_mismatch"})
			return
		}
	}
	newRevision, err := store.Save(request.Context(), revision, settings)
	if err != nil {
		_ = h.recordAudit(request, "outbound_proxy.save", "config", "outbound_proxy", "failure", map[string]any{"mode": settings.Mode, "cpa_applied": shouldWriteCPA})
		code := "outbound_proxy_partial"
		if errors.Is(err, repository.ErrOutboundProxyConflict) {
			code = "outbound_proxy_partial_conflict"
		}
		message := "OMC settings were not saved; reload and retry"
		if shouldWriteCPA {
			message = "CPA was updated but OMC settings were not saved; reload and retry"
		}
		writeJSON(writer, http.StatusConflict, map[string]string{"error": message, "code": code})
		return
	}
	_ = h.recordAudit(request, "outbound_proxy.save", "config", "outbound_proxy", "success", map[string]any{"mode": settings.Mode})
	if shouldWriteCPA {
		if yaml, err := client.ConfigYAML(request.Context()); err == nil {
			cpaRevision = configyaml.ComputeRevision(yaml)
		} else {
			cpaRevision = ""
		}
	}
	writeJSON(writer, http.StatusOK, projectOutboundProxy(settings, newRevision, cpaRevision, true))
}
