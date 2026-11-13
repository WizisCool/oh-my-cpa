package api

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/oh-my-cpa/oh-my-cpa/internal/iconasset"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

func decodeCustomIconRequest(writer http.ResponseWriter, request *http.Request, target any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 1024*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(writer, http.StatusRequestEntityTooLarge, map[string]string{"error": "custom_icon_too_large", "code": "custom_icon_too_large"})
		} else {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "custom_icon_invalid_request", "code": "custom_icon_invalid_request"})
		}
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeJSON(writer, http.StatusRequestEntityTooLarge, map[string]string{"error": "custom_icon_too_large", "code": "custom_icon_too_large"})
		} else {
			writeJSON(writer, http.StatusBadRequest, map[string]string{"error": "custom_icon_invalid_request", "code": "custom_icon_invalid_request"})
		}
		return false
	}
	return true
}
func writeCustomIconError(writer http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	switch {
	case errors.Is(err, iconasset.ErrTooLarge):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, repository.ErrCustomIconMissing):
		status = http.StatusNotFound
	case errors.Is(err, repository.ErrCustomIconLimit):
		status = http.StatusConflict
	case errors.Is(err, iconasset.ErrInvalid), errors.Is(err, repository.ErrCustomIconName):
	default:
		writeInternalError(writer, errors.New("custom icon operation failed"))
		return
	}
	writeJSON(writer, status, map[string]string{"error": err.Error(), "code": err.Error()})
}

// CustomIconListResponseDTO lists stored custom provider icons.
type CustomIconListResponseDTO struct {
	Icons []repository.CustomIcon `json:"icons"`
}

// CustomIconPreviewRequestDTO carries raw image or SVG data for validation/preview.
type CustomIconPreviewRequestDTO struct {
	Data string `json:"data"`
}

// CustomIconPreviewResponseDTO returns the normalized data URL and MIME type.
type CustomIconPreviewResponseDTO struct {
	DataURL  string `json:"data_url"`
	MIMEType string `json:"mime_type"`
}

// CreateCustomIconRequestDTO creates a custom icon from a name and data payload.
type CreateCustomIconRequestDTO struct {
	Name string `json:"name"`
	Data string `json:"data"`
}

// UpdateCustomIconRequestDTO updates a custom icon's name and/or artwork data.
type UpdateCustomIconRequestDTO struct {
	Name *string `json:"name,omitempty"`
	Data *string `json:"data,omitempty"`
}

// @Summary List custom icons
// @Description Return metadata for all stored custom provider icons.
// @Tags CustomIcons
// @Produce json
// @Security CookieAuth
// @Success 200 {object} CustomIconListResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/custom-icons [get]
func (h *Handler) listCustomIcons(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	icons, err := h.repo.ListCustomIcons(request.Context())
	if err != nil {
		writeCustomIconError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, CustomIconListResponseDTO{Icons: icons})
}

// @Summary Preview a custom icon
// @Description Validate uploaded icon image/SVG data and return a sanitized data URL preview without persisting it.
// @Tags CustomIcons
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body CustomIconPreviewRequestDTO true "Icon data payload"
// @Success 200 {object} CustomIconPreviewResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 413 {object} ErrorResponseDTO
// @Router /v1/custom-icons/preview [post]
func (h *Handler) previewCustomIcon(writer http.ResponseWriter, request *http.Request) {
	var input CustomIconPreviewRequestDTO
	if !decodeCustomIconRequest(writer, request, &input) {
		return
	}
	artwork, err := iconasset.ValidateImage(input.Data)
	if err != nil {
		writeCustomIconError(writer, err)
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, http.StatusOK, CustomIconPreviewResponseDTO{
		DataURL:  "data:" + artwork.MIME + ";base64," + base64.StdEncoding.EncodeToString(artwork.Content),
		MIMEType: artwork.MIME,
	})
}

// @Summary Create a custom icon
// @Description Validate and persist a new custom provider icon.
// @Tags CustomIcons
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body CreateCustomIconRequestDTO true "Custom icon payload"
// @Success 201 {object} repository.CustomIcon
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 413 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/custom-icons [post]
func (h *Handler) createCustomIcon(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	var input CreateCustomIconRequestDTO
	if !decodeCustomIconRequest(writer, request, &input) {
		return
	}
	icon, err := h.repo.CreateCustomIcon(request.Context(), input.Name, input.Data)
	if err != nil {
		writeCustomIconError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, icon)
}

// @Summary Update a custom icon
// @Description Rename or replace artwork for an existing custom provider icon.
// @Tags CustomIcons
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param id path string true "Custom icon ID"
// @Param body body UpdateCustomIconRequestDTO true "Custom icon patch payload"
// @Success 200 {object} repository.CustomIcon
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 413 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/custom-icons/{id} [patch]
func (h *Handler) updateCustomIcon(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	var input UpdateCustomIconRequestDTO
	if !decodeCustomIconRequest(writer, request, &input) {
		return
	}
	icon, err := h.repo.UpdateCustomIcon(request.Context(), chi.URLParam(request, "id"), input.Name, input.Data)
	if err != nil {
		writeCustomIconError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, icon)
}

// @Summary Delete a custom icon
// @Description Delete a custom provider icon and refresh identity directory projections.
// @Tags CustomIcons
// @Security CookieAuth
// @Param id path string true "Custom icon ID"
// @Success 204 "No Content"
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/custom-icons/{id} [delete]
func (h *Handler) deleteCustomIcon(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	if err := h.repo.DeleteCustomIcon(request.Context(), chi.URLParam(request, "id")); err != nil {
		writeCustomIconError(writer, err)
		return
	}
	h.identityArchive.reset()
	h.publishStateSync("management-providers", "management-providers-sanitized", stateScopeIdentityDirectory)
	writer.WriteHeader(http.StatusNoContent)
}

// @Summary Serve custom icon artwork
// @Description Return the sandboxed binary image or SVG content of a stored custom icon with ETag caching.
// @Tags CustomIcons
// @Produce octet-stream
// @Security CookieAuth
// @Param id path string true "Custom icon ID"
// @Success 200 {file} binary
// @Success 304 "Not Modified"
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/custom-icons/{id}/content [get]
// @Router /v1/custom-icons/{id}/content [head]
func (h *Handler) customIconContent(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	icon, err := h.repo.GetCustomIcon(request.Context(), chi.URLParam(request, "id"))
	if err != nil {
		writeCustomIconError(writer, err)
		return
	}
	tag := fmt.Sprintf(`"%s-%d"`, icon.ID, icon.Revision)
	writer.Header().Set("Content-Type", icon.MIMEType)
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Cache-Control", "private, no-cache")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'none'; sandbox")
	writer.Header().Set("ETag", tag)
	if request.Header.Get("If-None-Match") == tag {
		writer.WriteHeader(http.StatusNotModified)
		return
	}
	writer.Header().Set("Content-Length", strconv.Itoa(len(icon.Content)))
	if request.Method != http.MethodHead {
		_, _ = writer.Write(icon.Content)
	}
}
