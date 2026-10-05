package api

import (
	"errors"
	"net/http"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/gateway"
	"github.com/oh-my-cpa/oh-my-cpa/internal/modelcatalog"
	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
)

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
