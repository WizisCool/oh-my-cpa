package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

const SIWC_BINDING_LIMIT = 128
const SIWC_BINDING_TTL = 5 * time.Minute

var SIWC_STATE_PATTERN = regexp.MustCompile(`^[A-Za-z0-9_-]{1,512}$`)

// Sessions retain identity, not credential snapshots or callback values. They
// are intentionally process-local, like CPA's binding sessions.
type siwcBinding struct {
	mu          sync.Mutex
	gateway     string
	name        string
	authIndex   string
	targetID    string
	expiresAt   time.Time
	retainUntil time.Time
	isCompleted bool
	isCancelled bool
}
type siwcBindingStore struct {
	mu       sync.Mutex
	startMu  sync.Mutex
	sessions map[string]*siwcBinding
}

func (h *Handler) startSIWCBinding(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	var payload struct {
		Name      string `json:"name"`
		AuthIndex string `json:"auth_index"`
		Rebind    bool   `json:"rebind"`
	}
	if err := decodeManagementJSON(writer, request, 8*1024, &payload); err != nil {
		return
	}
	name, err := validateAuthSelector(payload.Name)
	if err != nil || len(payload.AuthIndex) > managementAuthFileNameLimit {
		writeError(writer, http.StatusBadRequest, "invalid credential selector")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	files, err := client.AuthFiles(request.Context())
	if err != nil {
		writeSIWCError(writer, err)
		return
	}
	file, ok := resolveSIWCBindingTarget(files.Files, name, strings.TrimSpace(payload.AuthIndex))
	if !ok {
		writeError(writer, http.StatusConflict, "credential identity changed or is ambiguous")
		return
	}
	if !file.SIWCBindSupported || file.RuntimeOnly || !strings.EqualFold(file.Provider, "codex") {
		writeError(writer, http.StatusBadRequest, "SIWC binding is unavailable for this credential")
		return
	}
	if file.SIWCBound && !payload.Rebind {
		writeError(writer, http.StatusConflict, "existing SIWC partition requires explicit rebinding")
		return
	}
	managedName := firstNonEmpty(file.Name, file.ID)
	// Admission is bounded before the upstream mutation, including concurrent starts.
	h.siwcBindings.startMu.Lock()
	defer h.siwcBindings.startMu.Unlock()
	h.siwcBindings.mu.Lock()
	now := h.now()
	for state, session := range h.siwcBindings.sessions {
		if !now.Before(session.retainUntil) {
			delete(h.siwcBindings.sessions, state)
		}
	}
	if len(h.siwcBindings.sessions) >= SIWC_BINDING_LIMIT {
		h.siwcBindings.mu.Unlock()
		writeError(writer, http.StatusTooManyRequests, "too many binding sessions")
		return
	}
	h.siwcBindings.mu.Unlock()
	if err := h.recordAudit(request, "oauth.siwc.bind", "auth_file", managedName, "attempt", nil); err != nil {
		writeError(writer, http.StatusInternalServerError, "audit failure; binding aborted")
		return
	}
	result, err := client.BindSIWC(request.Context(), firstNonEmpty(file.ID, file.Name))
	if err != nil {
		_ = h.recordAudit(request, "oauth.siwc.bind", "auth_file", managedName, "failure", nil)
		writeSIWCError(writer, err)
		return
	}
	if result.Flow != "siwc_bind" || !SIWC_STATE_PATTERN.MatchString(result.State) || result.ExpiresIn != 300 || !isSIWCAuthorizationURL(result.URL) {
		h.discardSIWCBindingStart(request, client, managedName, result.State)
		_ = h.recordAudit(request, "oauth.siwc.bind", "auth_file", managedName, "failure", map[string]any{"reason": "invalid_start_response"})
		writeError(writer, http.StatusBadGateway, "invalid SIWC start response")
		return
	}
	h.siwcBindings.mu.Lock()
	if h.siwcBindings.sessions == nil {
		h.siwcBindings.sessions = make(map[string]*siwcBinding)
	}
	h.siwcBindings.sessions[result.State] = &siwcBinding{gateway: client.BaseURL(), name: managedName, authIndex: file.AuthIndex, targetID: firstNonEmpty(file.ID, file.Name), expiresAt: now.Add(SIWC_BINDING_TTL), retainUntil: now.Add(2 * SIWC_BINDING_TTL)}
	h.siwcBindings.mu.Unlock()
	_ = h.recordAudit(request, "oauth.siwc.bind", "auth_file", managedName, "success", nil)
	writeJSON(writer, http.StatusOK, map[string]any{"url": result.URL, "state": result.State, "flow": "siwc_bind", "expires_in": 300})
}

// Match the browser's exact identity, then ensure CPA's ID-first resolver cannot
// select a different entry with the same name. No caller-supplied path is forwarded.
func resolveSIWCBindingTarget(files []management.AuthFile, name, authIndex string) (management.AuthFile, bool) {
	var found management.AuthFile
	matches := 0
	for _, file := range files {
		if firstNonEmpty(file.Name, file.ID) == name && file.AuthIndex == authIndex {
			found = file
			matches++
		}
	}
	if matches != 1 {
		return management.AuthFile{}, false
	}
	selector := firstNonEmpty(found.ID, found.Name)
	matches = 0
	for _, file := range files {
		if file.ID == selector || file.Name == selector {
			matches++
		}
	}
	return found, matches == 1
}

func isSIWCAuthorizationURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Host == "auth.openai.com" && parsed.User == nil && parsed.Path == "/api/accounts/authorize"
}

// Serialize callback, cancellation and readback for one attempt, without
// blocking other credentials behind that attempt's network requests.
func (h *Handler) withSIWCBinding(writer http.ResponseWriter, request *http.Request, action func(*siwcBinding, *management.Client)) {
	writer.Header().Set("Cache-Control", "no-store")
	state := request.URL.Query().Get("state")
	if state == "" || len(state) > 512 {
		writeError(writer, http.StatusBadRequest, "state is required")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	h.siwcBindings.mu.Lock()
	session := h.siwcBindings.sessions[state]
	h.siwcBindings.mu.Unlock()
	if session == nil || !h.now().Before(session.retainUntil) {
		writeError(writer, http.StatusNotFound, "binding session is unavailable")
		return
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.gateway != client.BaseURL() {
		writeError(writer, http.StatusConflict, "binding belongs to a different gateway")
		return
	}
	if session.isCancelled {
		writeError(writer, http.StatusConflict, "binding session was cancelled")
		return
	}
	if !session.isCompleted && !h.now().Before(session.expiresAt) {
		writeError(writer, http.StatusGone, "binding session expired")
		return
	}
	action(session, client)
}

func (h *Handler) getSIWCBindingStatus(writer http.ResponseWriter, request *http.Request) {
	h.withSIWCBinding(writer, request, func(session *siwcBinding, client *management.Client) {
		if !session.isCompleted {
			result, err := client.OAuthStatus(request.Context(), request.URL.Query().Get("state"))
			if err != nil {
				writeSIWCError(writer, err)
				return
			}
			switch normalizeOAuthStatus(result.Status) {
			case "error":
				writeJSON(writer, http.StatusOK, map[string]any{"status": "error"})
				return
			case "wait":
				writeJSON(writer, http.StatusOK, map[string]any{"status": "wait"})
				return
			}
			session.isCompleted = true
		}
		// A completed mutation is never retried because its subsequent read failed.
		files, err := client.AuthFiles(request.Context())
		if err != nil {
			writeJSON(writer, http.StatusOK, map[string]any{"status": "wait", "completed": true})
			return
		}
		file, ok := resolveSIWCBindingTarget(files.Files, session.name, session.authIndex)
		if !ok || firstNonEmpty(file.ID, file.Name) != session.targetID || !file.UseSIWC || !file.SIWCBound {
			writeJSON(writer, http.StatusOK, map[string]any{"status": "error", "completed": true})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "completed": true, "file": projectManagementAuthFile(file)})
	})
}

func (h *Handler) submitSIWCBindingCallback(writer http.ResponseWriter, request *http.Request) {
	var payload struct {
		RedirectURL string `json:"redirect_url"`
	}
	if err := decodeManagementJSON(writer, request, 16*1024, &payload); err != nil {
		return
	}
	h.withSIWCBinding(writer, request, func(session *siwcBinding, client *management.Client) {
		if session.isCompleted {
			writeError(writer, http.StatusConflict, "binding already completed")
			return
		}
		parsed, err := url.Parse(payload.RedirectURL)
		if err != nil || parsed.Scheme != "http" || parsed.Host != "127.0.0.1:1455" || parsed.Path != "/auth/callback" || parsed.User != nil || parsed.Fragment != "" {
			writeError(writer, http.StatusBadRequest, "invalid SIWC callback URL")
			return
		}
		query, err := url.ParseQuery(parsed.RawQuery)
		if err != nil || len(query["state"]) != 1 || query.Get("state") != request.URL.Query().Get("state") {
			writeError(writer, http.StatusBadRequest, "callback does not match this binding")
			return
		}
		if err := h.recordAudit(request, "oauth.siwc.callback", "auth_file", session.name, "attempt", nil); err != nil {
			writeError(writer, http.StatusInternalServerError, "audit failure; callback aborted")
			return
		}
		if err := client.SubmitSIWCCallback(request.Context(), payload.RedirectURL); err != nil {
			_ = h.recordAudit(request, "oauth.siwc.callback", "auth_file", session.name, "failure", nil)
			writeSIWCError(writer, err)
			return
		}
		_ = h.recordAudit(request, "oauth.siwc.callback", "auth_file", session.name, "success", nil)
		writeJSON(writer, http.StatusOK, map[string]any{"status": "ok"})
	})
}

func (h *Handler) cancelSIWCBinding(writer http.ResponseWriter, request *http.Request) {
	h.withSIWCBinding(writer, request, func(session *siwcBinding, client *management.Client) {
		if err := h.recordAudit(request, "oauth.siwc.cancel", "auth_file", session.name, "attempt", nil); err != nil {
			writeError(writer, http.StatusInternalServerError, "audit failure; cancellation aborted")
			return
		}
		result, err := client.CancelOAuthSession(request.Context(), request.URL.Query().Get("state"))
		if err != nil {
			_ = h.recordAudit(request, "oauth.siwc.cancel", "auth_file", session.name, "failure", nil)
			writeSIWCError(writer, err)
			return
		}
		session.isCancelled = result.Cancelled
		_ = h.recordAudit(request, "oauth.siwc.cancel", "auth_file", session.name, "success", map[string]any{"cancelled": result.Cancelled})
		writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "cancelled": result.Cancelled})
	})
}

// Upstream callback errors can quote codes and token-endpoint bodies. Preserve
// useful status classes, but never their free-form text in responses or audits.
func writeSIWCError(writer http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	var upstream *management.HTTPError
	if errors.As(err, &upstream) {
		switch upstream.StatusCode {
		case 400, 404, 409, 429, 503:
			status = upstream.StatusCode
		}
	}
	writeError(writer, status, "SIWC operation failed")
}

func (h *Handler) isSIWCBindingState(state string) bool {
	h.siwcBindings.mu.Lock()
	defer h.siwcBindings.mu.Unlock()
	return h.siwcBindings.sessions[state] != nil
}

// A rejected start still created a CPA session. Cleanup is a separate sensitive
// mutation with its own audit gate; a cancelled HTTP request must not strand it.
func (h *Handler) discardSIWCBindingStart(request *http.Request, client *management.Client, name, state string) {
	if !SIWC_STATE_PATTERN.MatchString(state) {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(request.Context()), 5*time.Second)
	defer cancel()
	cleanupRequest := request.Clone(ctx)
	if err := h.recordAudit(cleanupRequest, "oauth.siwc.cancel", "auth_file", name, "attempt", nil); err != nil {
		return
	}
	result, err := client.CancelOAuthSession(ctx, state)
	if err != nil {
		_ = h.recordAudit(cleanupRequest, "oauth.siwc.cancel", "auth_file", name, "failure", nil)
		return
	}
	_ = h.recordAudit(cleanupRequest, "oauth.siwc.cancel", "auth_file", name, "success", map[string]any{"cancelled": result.Cancelled})
}
