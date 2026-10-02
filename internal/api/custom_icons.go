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
	writeJSON(writer, http.StatusOK, map[string]any{"icons": icons})
}
func (h *Handler) previewCustomIcon(writer http.ResponseWriter, request *http.Request) {
	var input struct {
		Data string `json:"data"`
	}
	if !decodeCustomIconRequest(writer, request, &input) {
		return
	}
	artwork, err := iconasset.ValidateImage(input.Data)
	if err != nil {
		writeCustomIconError(writer, err)
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, http.StatusOK, map[string]any{"data_url": "data:" + artwork.MIME + ";base64," + base64.StdEncoding.EncodeToString(artwork.Content), "mime_type": artwork.MIME})
}
func (h *Handler) createCustomIcon(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	var input struct {
		Name string `json:"name"`
		Data string `json:"data"`
	}
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
func (h *Handler) updateCustomIcon(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	var input struct {
		Name *string `json:"name"`
		Data *string `json:"data"`
	}
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
func (h *Handler) deleteCustomIcon(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	if err := h.repo.DeleteCustomIcon(request.Context(), chi.URLParam(request, "id")); err != nil {
		writeCustomIconError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}
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
