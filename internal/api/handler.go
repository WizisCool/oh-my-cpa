package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/oh-my-cpa/oh-my-cpa/internal/auth"
	"github.com/oh-my-cpa/oh-my-cpa/internal/config"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/discovery"
	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/domain"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
	"github.com/oh-my-cpa/oh-my-cpa/internal/web"
)

type Handler struct {
	cfg        config.Config
	repo       *repository.Repository
	cipher     *appcrypto.Cipher
	discoverer *discovery.Discoverer
	logger     *slog.Logger
	auth       *auth.Manager
	// usage reports the background capture pipeline; nil when ingestion is off.
	usage usagePipeline
	// pricing serves model prices and the models.dev sync; nil until SetPricing.
	pricing PricingManager

	configMu  sync.Mutex
	startTime time.Time
	limiter   *loginLimiter
}

func NewHandler(cfg config.Config, repo *repository.Repository, cipher *appcrypto.Cipher, logger *slog.Logger, authManager *auth.Manager) *Handler {
	return &Handler{
		cfg:          cfg,
		repo:         repo,
		cipher:       cipher,
		discoverer:   discovery.NewDiscoverer(cipher),
		logger:       logger,
		auth:         authManager,
		startTime:    time.Now(),
		limiter:      newLoginLimiter(),
	}
}

func (h *Handler) Router() http.Handler {
	router := chi.NewRouter()
	router.Use(securityHeaders)
	base := h.cfg.BasePath
	if base == "" {
		base = "/"
	}
	router.Route(base, func(r chi.Router) {
		r.Route("/api", func(apiRouter chi.Router) {
			apiRouter.Get("/healthz", h.healthz)
			apiRouter.Route("/auth", func(authRouter chi.Router) {
				authRouter.Post("/login", h.login)
				authRouter.Get("/session", h.session)
				authRouter.Post("/logout", h.logout)
				authRouter.NotFound(h.notFound)
				authRouter.MethodNotAllowed(h.methodNotAllowed)
			})
			apiRouter.Route("/v1", func(v1 chi.Router) {
				v1.Use(h.requireAuthentication)
				v1.Post("/instances/default/discover", h.discoverDefault)
				v1.Get("/resources", h.listResources)
				v1.Patch("/resources/{id}/override", h.updateResourceOverride)
				v1.Get("/management/overview", h.managementOverview)
				v1.Get("/management/dashboard", h.dashboard)
				v1.Get("/management/dashboard/tail", h.dashboardTail)
				v1.Get("/management/logs", h.managementLogs)
				v1.Delete("/management/logs", h.clearManagementLogs)
				v1.Get("/management/logs/status", h.managementLogsStatus)
				v1.Get("/management/request-error-logs", h.requestErrorLogs)
				v1.Get("/management/request-error-logs/{name}", h.downloadRequestErrorLog)
				v1.Get("/preferences", h.listPreferences)
				v1.Put("/preferences/{key}", h.putPreference)
				v1.Get("/usage/ingest-status", h.dashboardIngestStatus)
				v1.Post("/usage/ingest/refresh", h.refreshUsageIngest)
				// Pricing: one read endpoint for the page plus four operator actions.
				v1.Get("/pricing", h.listPricing)
				v1.Put("/pricing/models", h.updatePricingModels)
				v1.Delete("/pricing/models/{model}", h.deletePricingModel)
				v1.Post("/pricing/sync", h.startPricingSync)
				v1.Put("/pricing/sync-schedule", h.updatePricingSyncSchedule)
				v1.Get("/usage/events", h.listUsageEvents)
				v1.Get("/usage/events/{id}", h.getUsageEvent)
				v1.Get("/usage/events/{id}/request-log", h.downloadUsageEventRequestLog)
				v1.Get("/usage/facets", h.listUsageFacets)
				v1.Get("/management/auth-files", h.listManagementAuthFiles)
				v1.Get("/management/auth-files/models", h.listManagementAuthFileModels)
				v1.Post("/management/auth-files", h.uploadManagementAuthFiles)
				v1.Patch("/management/auth-files/status", h.patchManagementAuthFileStatus)
				v1.Patch("/management/auth-files/fields", h.patchManagementAuthFileFields)
				v1.Delete("/management/auth-files", h.deleteManagementAuthFiles)
				v1.Get("/management/auth-files/download", h.downloadManagementAuthFile)
				v1.Get("/management/capabilities/{key}", h.managementCapabilityProbe)
				v1.Get("/management/config", h.managementConfigGet)
				v1.Put("/management/config/source", h.managementConfigSourcePut)
				v1.Get("/management/config/source", h.managementConfigSourceGet)
				v1.Put("/management/config/{key}", h.managementConfigPutScalar)
				v1.Get("/management/api-keys", h.listClientAPIKeys)
				v1.Post("/management/api-keys", h.createClientAPIKey)
				v1.Delete("/management/api-keys/{index}", h.deleteClientAPIKey)
				// Key aliases are Oh My CPA's own metadata keyed by the usage
				// fingerprint, so they are separate from the CPA config writes above.
				v1.Get("/management/client-key-aliases", h.listClientKeyAliases)
				v1.Put("/management/client-key-aliases", h.putClientKeyAlias)
				v1.Delete("/management/client-key-aliases/{fingerprint}", h.deleteClientKeyAlias)
				v1.Get("/management/client-key-usage", h.clientKeyUsage)
				v1.Get("/management/providers", h.listManagementProviders)
				v1.Post("/management/providers", h.createManagementProvider)
				v1.Post("/management/providers/pull-models", h.pullProviderModels)
				v1.Put("/management/providers/{id}", h.updateManagementProvider)
				v1.Delete("/management/providers/{id}", h.deleteManagementProvider)
				v1.Patch("/management/providers/status", h.patchManagementProviderStatus)
				v1.Get("/management/oauth/providers", h.listOAuthProviders)
				v1.Post("/management/oauth/start", h.startOAuthFlow)
				v1.Get("/management/oauth/status", h.getOAuthStatus)
				v1.Post("/management/oauth/callback", h.handleOAuthCallback)
				v1.Delete("/management/oauth/session", h.cancelOAuthSession)
				v1.Get("/management/quota", h.getQuotaOverview)
				v1.Post("/management/quota/reset", h.resetCredentialQuota)
				v1.Post("/management/quota/clear-cooldown", h.clearCredentialCooldown)
				v1.Post("/management/quota/refresh", h.refreshCredentialQuota)
				v1.Post("/management/quota/redeem-credit", h.redeemCodexResetCredit)
				v1.Get("/management/quota/{authIndex}", h.getCredentialQuotaDetail)
				v1.Get("/management/system", h.getSystemInfo)
				v1.Get("/management/system/diagnostics", h.getSystemDiagnostics)
				v1.Get("/management/plugins", h.listPlugins)
				v1.Patch("/management/plugins/{id}/status", h.setPluginStatus)
				v1.Delete("/management/plugins/{id}", h.deletePlugin)
				v1.Put("/management/plugins/{id}/config", h.setPluginConfig)
				v1.Get("/management/plugin-store", h.listPluginStore)
				v1.Post("/management/plugin-store/{id}/install", h.installPlugin)
				v1.Get("/management/audit/events", h.listAuditEvents)
				v1.Get("/management/audit/export", h.exportAuditEvents)
				v1.NotFound(h.notFound)
				v1.MethodNotAllowed(h.methodNotAllowed)
			})
			apiRouter.NotFound(h.notFound)
			apiRouter.MethodNotAllowed(h.methodNotAllowed)
		})
		r.Route("/media", func(mediaRouter chi.Router) {
			mediaRouter.NotFound(h.notFound)
			mediaRouter.MethodNotAllowed(h.methodNotAllowed)
		})
		r.Get("/assets/*", h.asset)
		r.Head("/assets/*", h.asset)
		r.Get("/favicon.svg", h.asset)
		r.Head("/favicon.svg", h.asset)
		r.Get("/*", h.spa)
		r.Head("/*", h.spa)
		r.MethodNotAllowed(h.methodNotAllowed)
	})
	// chi's nested wildcard route also matches the bare mount path. Handle the
	// canonical slash before it reaches the mounted router.
	mounted := http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if base != "/" && request.URL.Path == base {
			http.Redirect(writer, request, base+"/", http.StatusPermanentRedirect)
			return
		}
		router.ServeHTTP(writer, request)
	})
	return securityHeaders(mounted)
}

type loginRequest struct {
	Password string `json:"password"`
}

func (h *Handler) login(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if !sameOrigin(request) {
		writeError(writer, http.StatusForbidden, "same-origin request required")
		return
	}

	ip := resolveClientIP(request)
	if h.limiter != nil && h.limiter.isLocked(ip) {
		writeError(writer, http.StatusTooManyRequests, "too many failed login attempts; please try again later")
		return
	}

	if h.auth == nil {
		writeError(writer, http.StatusServiceUnavailable, "CPA management key is not configured yet; set OMCPA_CPA_MANAGEMENT_KEY first")
		return
	}
	var payload loginRequest
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 8*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil || strings.TrimSpace(payload.Password) == "" {
		writeError(writer, http.StatusBadRequest, "management key is required")
		return
	}
	if !h.auth.KeyMatches(payload.Password) {
		if h.limiter != nil {
			h.limiter.recordFailure(ip)
		}
		_ = h.recordAudit(request, "auth.login", "auth", "operator", "failure", map[string]any{"ip": security.MaskIP(ip)})
		writeError(writer, http.StatusUnauthorized, "invalid CPA management key")
		return
	}
	if h.limiter != nil {
		h.limiter.reset(ip)
	}
	_ = h.recordAudit(request, "auth.login", "auth", "operator", "success", map[string]any{"ip": security.MaskIP(ip)})
	if err := h.auth.Issue(writer); err != nil {
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"authenticated": true})
}

func (h *Handler) session(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.auth == nil || !h.auth.Valid(request) {
		writeJSON(writer, http.StatusOK, map[string]any{"authenticated": false})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"authenticated": true})
}

func (h *Handler) logout(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if !sameOrigin(request) {
		writeError(writer, http.StatusForbidden, "same-origin request required")
		return
	}
	if h.auth != nil {
		h.auth.Clear(writer)
	}
	writeJSON(writer, http.StatusOK, map[string]any{"authenticated": false})
}

func (h *Handler) requireAuthentication(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if h.auth == nil || !h.auth.Valid(request) {
			writeError(writer, http.StatusUnauthorized, "authentication required")
			return
		}
		if request.Method != http.MethodGet && request.Method != http.MethodHead && !sameOrigin(request) {
			writeError(writer, http.StatusForbidden, "same-origin request required")
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func sameOrigin(request *http.Request) bool {
	if request == nil {
		return false
	}
	origin := strings.TrimSpace(request.Header.Get("Origin"))
	if origin == "" {
		// Browsers normally send Origin for POST/PATCH. A missing Origin is
		// retained for non-browser clients; SameSite=Strict still prevents a
		// cross-site browser from attaching this session cookie.
		if referer := strings.TrimSpace(request.Header.Get("Referer")); referer != "" {
			origin = referer
		} else {
			return true
		}
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil {
		return false
	}
	expectedScheme := "http"
	if request.TLS != nil {
		expectedScheme = "https"
	} else if forwarded := strings.TrimSpace(strings.Split(request.Header.Get("X-Forwarded-Proto"), ",")[0]); forwarded != "" {
		expectedScheme = forwarded
	}
	// Reverse proxies in the supplied deployment files preserve the original
	// Host header. Do not trust X-Forwarded-Host from an untrusted direct client
	// as the comparison target, or it could make an attacker-controlled Origin
	// appear same-origin.
	return strings.EqualFold(parsed.Scheme, expectedScheme) && strings.EqualFold(parsed.Host, request.Host)
}

func (h *Handler) healthz(writer http.ResponseWriter, request *http.Request) {
	status := "ok"
	httpStatus := http.StatusOK

	databaseStatus := "ok"
	if h.repo == nil || h.repo.SQL() == nil {
		databaseStatus = "error"
		status = "error"
		httpStatus = http.StatusServiceUnavailable
	} else if err := h.repo.SQL().PingContext(request.Context()); err != nil {
		databaseStatus = "error"
		status = "error"
		httpStatus = http.StatusServiceUnavailable
	}

	cpaConnected := false
	if instance, err := h.repo.GetInstance(request.Context(), defaultInstanceID()); err == nil {
		client, clientErr := h.clientForInstance(request.Context(), instance)
		if clientErr == nil && client.Health(request.Context()) == nil {
			cpaConnected = true
		}
	}

	if status == "ok" && !cpaConnected {
		status = "degraded"
	}

	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, httpStatus, map[string]any{
		"status":          status,
		"version":         h.cfg.Version,
		"database_status": databaseStatus,
		"cpa_connected":   cpaConnected,
	})
}

func (h *Handler) discoverDefault(writer http.ResponseWriter, request *http.Request) {
	started := time.Now()
	instance, err := h.repo.GetInstance(request.Context(), defaultInstanceID())
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || strings.Contains(err.Error(), sql.ErrNoRows.Error()) {
			writeError(writer, http.StatusServiceUnavailable, "default CPA instance is not configured")
			return
		}
		writeInternalError(writer, err)
		return
	}
	client, err := h.clientForInstance(request.Context(), instance)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	resources, discoveryErrors, discoverErr := h.discoverer.Discover(request.Context(), client, instance.ID)
	if discoverErr != nil {
		_ = h.repo.UpdateInstanceStatus(request.Context(), instance.ID, "error", discoverErr.Error(), nil)
		writeErrorWithDetails(writer, http.StatusBadGateway, "CPA discovery failed", discoveryErrors)
		return
	}
	// A partial discovery must never mark resources from an unavailable CPA
	// endpoint as missing. Only a complete sweep is authoritative.
	markMissing := len(discoveryErrors) == 0
	stored, err := h.repo.UpsertDiscoveredResources(request.Context(), instance.ID, resources, time.Now().UTC(), markMissing)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	now := time.Now().UTC()
	_ = h.repo.UpdateInstanceStatus(request.Context(), instance.ID, "ok", strings.Join(discoveryErrors, "; "), &now)
	unclaimedResources, listErr := h.repo.ListResources(request.Context(), string(domain.ResourceStatusUnclaimed))
	if listErr != nil {
		writeInternalError(writer, listErr)
		return
	}
	unclaimed := len(unclaimedResources)
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"status":           "ok",
		"instance_id":      instance.ID,
		"discovered_count": len(stored),
		"unclaimed_count":  unclaimed,
		"duration_ms":      time.Since(started).Milliseconds(),
		"errors":           discoveryErrors,
	})
}

func (h *Handler) listResources(writer http.ResponseWriter, request *http.Request) {
	status := strings.TrimSpace(request.URL.Query().Get("status"))
	resources, err := h.repo.ListResources(request.Context(), status)
	if err != nil {
		if strings.Contains(err.Error(), "invalid resource status") {
			writeError(writer, http.StatusBadRequest, err.Error())
			return
		}
		writeInternalError(writer, err)
		return
	}
	response := make([]resourceResponse, 0, len(resources))
	for _, resource := range resources {
		response = append(response, toResourceResponse(resource))
	}
	writeJSON(writer, http.StatusOK, map[string]any{"resources": response, "total": len(response)})
}

func (h *Handler) updateResourceOverride(writer http.ResponseWriter, request *http.Request) {
	id := chi.URLParam(request, "id")
	if _, err := uuid.Parse(id); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid resource id")
		return
	}
	var payload overrideRequest
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 16*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := payload.validate(); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	override := domain.ResourceOverride{
		DisplayName:    optionalTrimmedPtr(payload.DisplayName),
		Color:          optionalTrimmedPtr(payload.Color),
		IconRef:        optionalTrimmedPtr(payload.Icon),
		Notes:          optionalTrimmedPtr(payload.Notes),
		DisplayNameSet: payload.has("display_name"),
		ColorSet:       payload.has("color"),
		IconRefSet:     payload.has("icon"),
		NotesSet:       payload.has("notes"),
	}
	if payload.has("status") && payload.Status != nil {
		status := domain.ResourceStatus(strings.TrimSpace(*payload.Status))
		override.Status = &status
		override.StatusSet = true
	}
	resource, err := h.repo.UpdateResourceOverride(request.Context(), id, override)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || strings.Contains(err.Error(), sql.ErrNoRows.Error()) {
			writeError(writer, http.StatusNotFound, "resource not found")
			return
		}
		writeInternalError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "resource": toResourceResponse(resource)})
}

func (h *Handler) clientForInstance(ctx context.Context, instance domain.CPAInstance) (*management.Client, error) {
	key, err := h.cipher.Decrypt(instance.ManagementKeyCiphertext, instance.ManagementKeyNonce)
	if err != nil {
		return nil, fmt.Errorf("decrypt CPA management key: %w", err)
	}
	defer clearBytes(key)
	return management.NewClient(instance.BaseURL, string(key), h.cfg.RequestTimeout, h.cfg.TLSSkipVerify)
}

type overrideRequest struct {
	DisplayName *string `json:"display_name"`
	Icon        *string `json:"icon"`
	Color       *string `json:"color"`
	Notes       *string `json:"notes"`
	Status      *string `json:"status"`
	fields      map[string]bool
}

// UnmarshalJSON keeps omitted fields distinct from explicit null/empty values.
// That distinction is required for PATCH: omission preserves a value, while
// null or an empty string clears nullable metadata.
func (p *overrideRequest) UnmarshalJSON(data []byte) error {
	var decoded struct {
		DisplayName *string `json:"display_name"`
		Icon        *string `json:"icon"`
		Color       *string `json:"color"`
		Notes       *string `json:"notes"`
		Status      *string `json:"status"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("multiple JSON values are not allowed")
		}
		return err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil || raw == nil {
		return errors.New("JSON object is required")
	}
	p.DisplayName = decoded.DisplayName
	p.Icon = decoded.Icon
	p.Color = decoded.Color
	p.Notes = decoded.Notes
	p.Status = decoded.Status
	p.fields = make(map[string]bool, len(raw))
	for key := range raw {
		p.fields[key] = true
	}
	return nil
}

func (p overrideRequest) has(field string) bool {
	return p.fields[field]
}

func (p overrideRequest) validate() error {
	if p.has("display_name") && p.DisplayName != nil && len([]rune(*p.DisplayName)) > 128 {
		return errors.New("display_name is too long")
	}
	if p.has("notes") && p.Notes != nil && len([]rune(*p.Notes)) > 1000 {
		return errors.New("notes is too long")
	}
	if p.has("color") && p.Color != nil && strings.TrimSpace(*p.Color) != "" && !isHexColor(strings.TrimSpace(*p.Color)) {
		return errors.New("color must be a six-digit hexadecimal color")
	}
	if p.has("status") {
		if p.Status == nil || strings.TrimSpace(*p.Status) == "" || !domain.ResourceStatus(strings.TrimSpace(*p.Status)).Valid() {
			return errors.New("invalid resource status")
		}
	}
	if p.has("icon") && p.Icon != nil && len([]rune(*p.Icon)) > 64 {
		return errors.New("icon reference is too long")
	}
	return nil
}

type resourceResponse struct {
	ID                string                  `json:"id"`
	CPAInstanceID     string                  `json:"cpa_instance_id"`
	CPAResourceType   string                  `json:"cpa_resource_type"`
	CPAAuthIndex      string                  `json:"cpa_auth_index,omitempty"`
	CPAResourceName   string                  `json:"cpa_resource_name,omitempty"`
	CPADriver         string                  `json:"cpa_driver"`
	ProtocolDriver    string                  `json:"protocol_driver"`
	ProtocolDisplay   string                  `json:"protocol_display,omitempty"`
	BaseURL           string                  `json:"base_url,omitempty"`
	SuggestedSource   string                  `json:"suggested_source,omitempty"`
	SuggestedPlan     string                  `json:"suggested_plan,omitempty"`
	DisplayName       string                  `json:"display_name"`
	CustomDisplayName *string                 `json:"custom_display_name,omitempty"`
	Icon              *string                 `json:"icon,omitempty"`
	Color             *string                 `json:"color,omitempty"`
	Notes             *string                 `json:"notes,omitempty"`
	Status            domain.ResourceStatus   `json:"status"`
	LastSeenAt        time.Time               `json:"last_seen_at"`
	CreatedAt         time.Time               `json:"created_at"`
	UpdatedAt         time.Time               `json:"updated_at"`
	Details           resourceDetailsResponse `json:"details,omitempty"`
}

// resourceDetailsResponse is an explicit browser contract. Persistence details
// can evolve independently, while ordinary resource responses expose only the
// fields the resource editor needs plus reviewed non-secret status flags.
type resourceDetailsResponse struct {
	Models      []string          `json:"models,omitempty"`
	AuthType    string            `json:"auth_type,omitempty"`
	Priority    int               `json:"priority,omitempty"`
	Disabled    bool              `json:"disabled,omitempty"`
	Unavailable bool              `json:"unavailable,omitempty"`
	Extra       map[string]string `json:"extra,omitempty"`
}

func toResourceDetailsResponse(details domain.ResourceDetails) resourceDetailsResponse {
	result := resourceDetailsResponse{
		Models:      append([]string(nil), details.Models...),
		AuthType:    details.AuthType,
		Priority:    details.Priority,
		Disabled:    details.Disabled,
		Unavailable: details.Unavailable,
	}
	allowed := map[string]struct{}{
		"account_present":    {},
		"account_type":       {},
		"api_key_present":    {},
		"identity_collision": {},
		"proxy_configured":   {},
	}
	for key, value := range details.Extra {
		if _, ok := allowed[key]; ok && value != "" {
			if result.Extra == nil {
				result.Extra = make(map[string]string)
			}
			result.Extra[key] = value
		}
	}
	return result
}

func toResourceResponse(resource domain.DiscoveredResource) resourceResponse {
	return resourceResponse{
		ID:                resource.ID,
		CPAInstanceID:     resource.InstanceID,
		CPAResourceType:   resource.CPAResourceType,
		CPAAuthIndex:      resource.CPAAuthIndex,
		CPAResourceName:   resource.CPAResourceName,
		CPADriver:         resource.CPADriver,
		ProtocolDriver:    resource.ProtocolDriver,
		ProtocolDisplay:   resource.ProtocolDisplay,
		BaseURL:           resource.BaseURL,
		SuggestedSource:   resource.SuggestedSource,
		SuggestedPlan:     resource.SuggestedPlan,
		DisplayName:       resource.DisplayName,
		CustomDisplayName: resource.CustomDisplayName,
		Icon:              resource.IconRef,
		Color:             resource.Color,
		Notes:             resource.Notes,
		Status:            resource.Status,
		LastSeenAt:        resource.LastSeenAt,
		CreatedAt:         resource.CreatedAt,
		UpdatedAt:         resource.UpdatedAt,
		Details:           toResourceDetailsResponse(resource.Details),
	}
}

func (h *Handler) asset(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		h.methodNotAllowed(writer, request)
		return
	}
	name := strings.TrimPrefix(request.URL.Path, h.cfg.BasePath)
	name = strings.TrimPrefix(name, "/")
	if name == "" || strings.HasPrefix(name, "api/") || strings.Contains(name, "..") {
		h.notFound(writer, request)
		return
	}
	data, err := fs.ReadFile(web.Dist, "dist/"+name)
	if err != nil {
		h.notFound(writer, request)
		return
	}
	writer.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	writer.Header().Set("Content-Type", contentType(name))
	if request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write(data)
}

func contentType(name string) string {
	switch {
	case strings.HasSuffix(name, ".js"):
		return "text/javascript; charset=utf-8"
	case strings.HasSuffix(name, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(name, ".svg"):
		return "image/svg+xml"
	case strings.HasSuffix(name, ".json"):
		return "application/json"
	default:
		return "application/octet-stream"
	}
}

func (h *Handler) spa(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		h.methodNotAllowed(writer, request)
		return
	}
	data, err := fs.ReadFile(web.Dist, "dist/index.html")
	if err != nil {
		writeInternalError(writer, fmt.Errorf("read embedded index: %w", err))
		return
	}
	index, err := injectRuntimeConfig(string(data), h.cfg.BasePath)
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	writer.Header().Set("Cache-Control", "no-store")
	if request.Method == http.MethodHead {
		return
	}
	_, _ = writer.Write([]byte(index))
}

func injectRuntimeConfig(indexHTML, basePath string) (string, error) {
	if basePath == "/" {
		basePath = ""
	}
	apiBase := joinURLPath(basePath, "/api/v1")
	mediaBase := joinURLPath(basePath, "/media")
	// The template package escapes values before putting them into the HTML
	// script. Paths are validated by NormalizeBasePath before reaching here.
	payload := fmt.Sprintf(`window.__OMCPA_CONFIG__ = %s;`, mustJSON(map[string]string{
		"basePath":     basePath,
		"apiBaseUrl":   apiBase,
		"mediaBaseUrl": mediaBase,
		"appName":      "Oh My CPA",
	}))
	script := "<script>" + payload + "</script>"
	replacedConfig := false
	if strings.Contains(indexHTML, "window.__OMCPA_CONFIG__") {
		start := strings.Index(indexHTML, "<script>")
		for start >= 0 {
			endRelative := strings.Index(indexHTML[start:], "</script>")
			if endRelative < 0 {
				break
			}
			end := start + endRelative + len("</script>")
			block := indexHTML[start:end]
			if strings.Contains(block, "window.__OMCPA_CONFIG__") {
				indexHTML = indexHTML[:start] + script + indexHTML[end:]
				replacedConfig = true
				break
			}
			next := strings.Index(indexHTML[end:], "<script>")
			if next < 0 {
				break
			}
			start = end + next
		}
	}
	if !replacedConfig {
		indexHTML = strings.Replace(indexHTML, "<head>", "<head>\n    "+script, 1)
	}
	baseHref := basePath + "/"
	if basePath == "" {
		baseHref = "/"
	}
	baseTag := fmt.Sprintf(`<base href="%s">`, template.HTMLEscapeString(baseHref))
	if !strings.Contains(indexHTML, "<base ") {
		indexHTML = strings.Replace(indexHTML, "<head>", "<head>\n    "+baseTag, 1)
	}
	return indexHTML, nil
}

func joinURLPath(base, suffix string) string {
	base = strings.TrimRight(base, "/")
	if base == "" {
		return suffix
	}
	return base + "/" + strings.TrimLeft(suffix, "/")
}

func mustJSON(value any) string {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(data)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		writer.Header().Set("Referrer-Policy", "no-referrer")
		writer.Header().Set("X-Frame-Options", "SAMEORIGIN")
		writer.Header().Set("Permissions-Policy", "geolocation=(), camera=(), microphone=(), payment=()")
		writer.Header().Set("Content-Security-Policy-Report-Only", "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self' blob:; worker-src 'self' blob:; frame-ancestors 'self';")
		if request.TLS != nil || strings.EqualFold(request.Header.Get("X-Forwarded-Proto"), "https") {
			writer.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(writer, request)
	})
}

func (h *Handler) notFound(writer http.ResponseWriter, _ *http.Request) {
	writeError(writer, http.StatusNotFound, "not found")
}

func (h *Handler) methodNotAllowed(writer http.ResponseWriter, _ *http.Request) {
	writeError(writer, http.StatusMethodNotAllowed, "method not allowed")
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func writeError(writer http.ResponseWriter, status int, message string) {
	writeJSON(writer, status, map[string]string{"error": message})
}

func writeErrorWithDetails(writer http.ResponseWriter, status int, message string, details []string) {
	writeJSON(writer, status, map[string]any{"error": message, "details": details})
}

// writeInternalError hides details from the client but never from the log: a
// swallowed 500 is undiagnosable in a running deployment.
func writeInternalError(writer http.ResponseWriter, err error) {
	if err != nil {
		slog.Error("api request failed", "error", err.Error())
	}
	writeError(writer, http.StatusInternalServerError, "internal server error")
}

func optionalTrimmedPtr(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func isHexColor(value string) bool {
	if len(value) != 7 || value[0] != '#' {
		return false
	}
	for _, char := range value[1:] {
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return false
		}
	}
	return true
}

func defaultInstanceID() string { return "default" }

func clearBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func (h *Handler) recordAudit(request *http.Request, action, targetType, targetID, result string, details map[string]any) error {
	if h == nil || h.repo == nil {
		return errors.New("repository is not initialized")
	}
	summary := requestSourceSummary(request)
	reqID := getOrGenerateRequestID(request)
	_, err := h.repo.RecordAuditEvent(request.Context(), repository.AuditEvent{
		Action:        action,
		TargetType:    targetType,
		TargetID:      targetID,
		Result:        result,
		RequestID:     reqID,
		SourceSummary: summary,
		Details:       details,
	})
	if err != nil {
		if h.logger != nil {
			h.logger.Error("audit event recording failed",
				"action", action,
				"target_type", targetType,
				"target_id", targetID,
				"result", result,
				"request_id", reqID,
				"error", err,
			)
		}
		return err
	}
	return nil
}

func getOrGenerateRequestID(request *http.Request) string {
	if request != nil {
		if id := strings.TrimSpace(request.Header.Get("X-Request-ID")); id != "" && len([]rune(id)) <= 128 {
			return security.RedactText(id)
		}
	}
	return uuid.NewString()
}

func requestSourceSummary(request *http.Request) string {
	if request == nil {
		return ""
	}
	parts := make([]string, 0, 2)
	ip := request.RemoteAddr
	if fwd := request.Header.Get("X-Forwarded-For"); fwd != "" {
		if masked := security.MaskForwardedFor(fwd); masked != nil {
			parts = append(parts, "ip="+*masked)
		}
	} else if masked := security.MaskIP(ip); masked != nil {
		parts = append(parts, "ip="+*masked)
	}
	if ua := security.MinimizeUserAgent(request.UserAgent()); ua != nil {
		parts = append(parts, "ua="+*ua)
	}
	return strings.Join(parts, " ")
}
