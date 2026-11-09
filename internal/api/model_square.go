package api

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
	"github.com/oh-my-cpa/oh-my-cpa/internal/modelcatalog"
	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
)

// modelSquareCache retains only projected provenance, never credential material.
type modelSquareCache struct {
	// refreshMu serializes manual and scheduled sweeps through cache publication.
	refreshMu sync.Mutex
	// mu protects publication and isolates each reader's mutable projection.
	mu sync.RWMutex
	// baseURL prevents a newly selected gateway from using the old one's routes.
	baseURL string
	// directory is replaced atomically after a successful full sweep.
	directory operations.ModelSquareDirectory
	// isIncomplete reports a failed refresh while preserving the last good entry.
	isIncomplete bool
	// once initializes the coalescing wake channel for zero-value handlers too.
	once sync.Once
	// refresh queues a background sweep after a model configuration change.
	refresh chan struct{}
}

// modelSquareRefreshSignal returns the shared, lazily initialized wake channel.
func (h *Handler) modelSquareRefreshSignal() chan struct{} {
	h.modelSquare.once.Do(func() { h.modelSquare.refresh = make(chan struct{}, 1) })
	return h.modelSquare.refresh
}

// requestModelSquareProvenanceRefresh coalesces changes without blocking writes.
func (h *Handler) requestModelSquareProvenanceRefresh() {
	select {
	case h.modelSquareRefreshSignal() <- struct{}{}:
	default:
	}
}

// cachedModelSquareProvenance gives callers their own slices for filtering and branding.
func (h *Handler) cachedModelSquareProvenance(baseURL string) operations.ModelSquareDirectory {
	h.modelSquare.mu.RLock()
	defer h.modelSquare.mu.RUnlock()
	if h.modelSquare.baseURL != baseURL {
		return operations.ModelSquareDirectory{Providers: []operations.ModelSquareProvider{}, Routes: []operations.ModelSquareRoute{}, Partial: []string{"routes"}}
	}
	directory := h.modelSquare.directory
	directory.Providers = append([]operations.ModelSquareProvider{}, directory.Providers...)
	directory.Routes = append([]operations.ModelSquareRoute{}, directory.Routes...)
	directory.Partial = append([]string{}, directory.Partial...)
	if h.modelSquare.isIncomplete {
		directory.Partial = append(directory.Partial, "routes")
	}
	return directory
}

// RunModelSquareProvenance refreshes every credential at startup and once a minute.
// The application owns cancellation; page requests only read the last published entry.
func (h *Handler) RunModelSquareProvenance(ctx context.Context) error {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	refresh := h.modelSquareRefreshSignal()
	for {
		_ = h.RefreshModelSquareProvenance(ctx)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		case <-refresh:
		}
	}
}

// RefreshModelSquareProvenance publishes a full sweep or retains the last good entry.
// Demo startup also uses this once against its local fixture, without starting a loop.
func (h *Handler) RefreshModelSquareProvenance(ctx context.Context) error {
	h.modelSquare.refreshMu.Lock()
	defer h.modelSquare.refreshMu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	client, err := h.capabilityClient(ctx)
	var directory operations.ModelSquareDirectory
	if err == nil {
		directory, err = operations.LoadModelSquareProvenance(ctx, client)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	h.modelSquare.mu.Lock()
	defer h.modelSquare.mu.Unlock()
	if err != nil && !h.modelSquare.isIncomplete && h.logger != nil {
		// Upstream error text can include credential identities; keep the log non-secret.
		h.logger.Warn("model provenance refresh failed; keeping cached sources")
	}
	h.modelSquare.isIncomplete = err != nil
	if err == nil {
		h.modelSquare.baseURL = client.BaseURL()
		h.modelSquare.directory = directory
	}
	return err
}

func (h *Handler) listModelSquare(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	directory, err := h.operationsService().ListModelSquare(request.Context(), operations.ModelSquareQuery{})
	if err != nil {
		writeModelSquareError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, projectModelSquareDTO(directory))
}

func writeModelSquareError(writer http.ResponseWriter, err error) {
	var gatewayErr *gateway.Error
	switch {
	case errors.Is(err, operations.ErrClientKeyRequired):
		writePlaygroundError(writer, http.StatusConflict, operations.ErrClientKeyRequired.Error())
	case errors.As(err, &gatewayErr):
		writeJSON(writer, http.StatusBadGateway, gateway.ErrorEvent(err))
	default:
		writeCPAFacadeError(writer, err)
	}
}

// Keep the HTTP allowlist independent of internal operation and catalog expansion.
type modelSquareDTO struct {
	Models            []modelSquareModelDTO              `json:"models"`
	Providers         []modelSquareProviderDTO           `json:"providers"`
	Routes            []modelSquareRouteDTO              `json:"routes"`
	Partial           []string                           `json:"partial"`
	ModelInfo         map[string]modelSquareReferenceDTO `json:"model_info"`
	MetadataUpdatedAt string                             `json:"metadata_updated_at"`
}
type modelSquareModelDTO struct {
	ID        string `json:"id"`
	CallPoint string `json:"call_point"`
	Vision    string `json:"vision"`
}
type modelSquareProviderDTO struct {
	ID           string `json:"id"`
	Family       string `json:"family"`
	Name         string `json:"name"`
	EndpointHost string `json:"endpoint_host,omitempty"`
	IsOAuth      bool   `json:"is_oauth"`
	IconID       string `json:"icon_id,omitempty"`
}
type modelSquareRouteDTO struct {
	ProviderID    string `json:"provider_id"`
	UpstreamModel string `json:"upstream_model"`
	CallPoint     string `json:"call_point"`
}
type modelSquareReferenceLinkDTO struct {
	Label string `json:"label"`
	URL   string `json:"url"`
	Type  string `json:"type,omitempty"`
}
type modelSquareLimitsDTO struct {
	Context int64 `json:"context,omitempty"`
	Input   int64 `json:"input,omitempty"`
	Output  int64 `json:"output,omitempty"`
}
type modelSquareModalitiesDTO struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}
type modelSquareReferenceDTO struct {
	ID               string                        `json:"id"`
	Name             string                        `json:"name"`
	Description      string                        `json:"description,omitempty"`
	Family           string                        `json:"family,omitempty"`
	OpenWeights      *bool                         `json:"open_weights,omitempty"`
	Reasoning        *bool                         `json:"reasoning,omitempty"`
	ToolCall         *bool                         `json:"tool_call,omitempty"`
	StructuredOutput *bool                         `json:"structured_output,omitempty"`
	Attachment       *bool                         `json:"attachment,omitempty"`
	Temperature      *bool                         `json:"temperature,omitempty"`
	Knowledge        string                        `json:"knowledge,omitempty"`
	ReleaseDate      string                        `json:"release_date,omitempty"`
	LastUpdated      string                        `json:"last_updated,omitempty"`
	License          string                        `json:"license,omitempty"`
	Limit            modelSquareLimitsDTO          `json:"limit"`
	Modalities       modelSquareModalitiesDTO      `json:"modalities"`
	Weights          []modelSquareReferenceLinkDTO `json:"weights,omitempty"`
	Links            []modelSquareReferenceLinkDTO `json:"links,omitempty"`
}

func projectModelSquareDTO(directory operations.ModelSquareDirectory) modelSquareDTO {
	result := modelSquareDTO{
		Models:            make([]modelSquareModelDTO, 0, len(directory.Models)),
		Providers:         make([]modelSquareProviderDTO, 0, len(directory.Providers)),
		Routes:            make([]modelSquareRouteDTO, 0, len(directory.Routes)),
		Partial:           append([]string{}, directory.Partial...),
		ModelInfo:         make(map[string]modelSquareReferenceDTO, len(directory.ModelInfo)),
		MetadataUpdatedAt: directory.MetadataUpdatedAt,
	}
	for _, model := range directory.Models {
		result.Models = append(result.Models, modelSquareModelDTO{ID: model.ID, CallPoint: model.CallPoint, Vision: model.Vision})
	}
	for _, provider := range directory.Providers {
		result.Providers = append(result.Providers, modelSquareProviderDTO{ID: provider.ID, Family: provider.Family, Name: provider.Name, EndpointHost: provider.EndpointHost, IsOAuth: provider.IsOAuth, IconID: provider.IconID})
	}
	for _, route := range directory.Routes {
		result.Routes = append(result.Routes, modelSquareRouteDTO{ProviderID: route.ProviderID, UpstreamModel: route.UpstreamModel, CallPoint: route.CallPoint})
	}
	for identity, model := range directory.ModelInfo {
		result.ModelInfo[identity] = modelSquareReferenceDTO{
			ID:               model.ID,
			Name:             model.Name,
			Description:      model.Description,
			Family:           model.Family,
			OpenWeights:      model.OpenWeights,
			Reasoning:        model.Reasoning,
			ToolCall:         model.ToolCall,
			StructuredOutput: model.StructuredOutput,
			Attachment:       model.Attachment,
			Temperature:      model.Temperature,
			Knowledge:        model.Knowledge,
			ReleaseDate:      model.ReleaseDate,
			LastUpdated:      model.LastUpdated,
			License:          model.License,
			Limit:            modelSquareLimitsDTO{Context: model.Limit.Context, Input: model.Limit.Input, Output: model.Limit.Output},
			Modalities:       modelSquareModalitiesDTO{Input: model.Modalities.Input, Output: model.Modalities.Output},
			Weights:          projectModelSquareLinks(model.Weights),
			Links:            projectModelSquareLinks(model.Links),
		}
	}
	return result
}
func projectModelSquareLinks(links []modelcatalog.Link) []modelSquareReferenceLinkDTO {
	result := make([]modelSquareReferenceLinkDTO, 0, len(links))
	for _, link := range links {
		result = append(result, modelSquareReferenceLinkDTO{Label: link.Label, URL: link.URL, Type: link.Type})
	}
	return result
}
