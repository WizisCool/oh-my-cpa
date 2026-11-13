package api

import (
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/oh-my-cpa/oh-my-cpa/internal/fontasset"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

// The console's font library. Every face it stores is served from this origin, which
// is what lets an operator choose any typeface while the console keeps loading
// nothing from another host: an uploaded file is validated and stored, and a Google
// Fonts family is downloaded by the server once and stored the same way.

const (
	// maxFontUploadFiles bounds one upload: the four styles of a family, plus room
	// for a family shipped as separate weights.
	maxFontUploadFiles = 12
	// maxFontUploadBytes bounds one upload request; one file is bounded separately by
	// fontasset.MaxFileBytes.
	maxFontUploadBytes = 96 * 1024 * 1024
	// fontTransferWindow replaces the server's 30-second read and write deadlines for
	// the two requests that move a family: an upload over a slow link, and an install
	// that downloads a CJK family's slices before it answers.
	fontTransferWindow = 4 * time.Minute
)

func writeFontError(writer http.ResponseWriter, err error) {
	status := http.StatusBadRequest
	switch {
	case errors.Is(err, fontasset.ErrTooLarge):
		status = http.StatusRequestEntityTooLarge
	case errors.Is(err, repository.ErrFontMissing), errors.Is(err, fontasset.ErrGoogleFamilyMissing):
		status = http.StatusNotFound
	case errors.Is(err, repository.ErrFontLimit):
		status = http.StatusConflict
	case errors.Is(err, fontasset.ErrGoogleUnreachable):
		status = http.StatusBadGateway
	case errors.Is(err, fontasset.ErrInvalid), errors.Is(err, fontasset.ErrFamily), errors.Is(err, repository.ErrFontReference), errors.Is(err, repository.ErrFontNoFaces):
	default:
		writeInternalError(writer, fmt.Errorf("font operation failed: %w", err))
		return
	}
	writeJSON(writer, status, map[string]string{"error": err.Error(), "code": err.Error()})
}

func extendTransferDeadlines(writer http.ResponseWriter) {
	controller := http.NewResponseController(writer)
	deadline := time.Now().Add(fontTransferWindow)
	_ = controller.SetReadDeadline(deadline)
	_ = controller.SetWriteDeadline(deadline)
}

// FontFaceDTO describes one stored `@font-face` rule without exposing binary font content.
type FontFaceDTO struct {
	ID           string `json:"id"`
	WeightMin    int    `json:"weight_min"`
	WeightMax    int    `json:"weight_max"`
	Style        string `json:"style"`
	UnicodeRange string `json:"unicode_range,omitempty"`
	Format       string `json:"format"`
}

// FontDTO describes an installed console font family and its face descriptors.
type FontDTO struct {
	ID          string        `json:"id"`
	Family      string        `json:"family"`
	Source      string        `json:"source"`
	CreatedAtMS int64         `json:"created_at_ms"`
	ByteSize    int64         `json:"byte_size"`
	Faces       []FontFaceDTO `json:"faces"`
}

func projectFontDTO(font repository.Font) FontDTO {
	faces := make([]FontFaceDTO, 0, len(font.Faces))
	for _, face := range font.Faces {
		faces = append(faces, FontFaceDTO{
			ID:           face.ID,
			WeightMin:    face.WeightMin,
			WeightMax:    face.WeightMax,
			Style:        face.Style,
			UnicodeRange: face.UnicodeRange,
			Format:       string(face.Format),
		})
	}
	return FontDTO{
		ID:          font.ID,
		Family:      font.Family,
		Source:      string(font.Source),
		CreatedAtMS: font.CreatedAtMS,
		ByteSize:    font.ByteSize,
		Faces:       faces,
	}
}

func projectFontDTOs(fonts []repository.Font) []FontDTO {
	out := make([]FontDTO, 0, len(fonts))
	for _, font := range fonts {
		out = append(out, projectFontDTO(font))
	}
	return out
}

// FontListResponseDTO lists stored console font families.
type FontListResponseDTO struct {
	Fonts []FontDTO `json:"fonts"`
}

// InstallGoogleFontRequestDTO identifies a Google Fonts family to download and store locally.
type InstallGoogleFontRequestDTO struct {
	Family string `json:"family"`
}

// @Summary List stored font families
// @Description Return metadata and face descriptors for all installed console fonts.
// @Tags Fonts
// @Produce json
// @Security CookieAuth
// @Success 200 {object} FontListResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/fonts [get]
func (h *Handler) listFonts(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	fonts, err := h.repo.ListFonts(request.Context())
	if err != nil {
		writeFontError(writer, err)
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writeJSON(writer, http.StatusOK, FontListResponseDTO{Fonts: projectFontDTOs(fonts)})
}

func (h *Handler) googleFonts() (*fontasset.GoogleInstaller, error) {
	h.fontInstallerOnce.Do(func() {
		if h.fontInstaller == nil {
			transport := h.outboundTransport
			if transport == nil {
				transport = http.DefaultTransport
			}
			h.fontInstaller, h.fontInstallerErr = fontasset.NewGoogleInstaller(h.cfg.GoogleFontsURL, transport)
		}
	})
	return h.fontInstaller, h.fontInstallerErr
}

// @Summary Install a Google Font family
// @Description Download a Google Fonts family server-side and store its faces locally for offline serving.
// @Tags Fonts
// @Accept json
// @Produce json
// @Security CookieAuth
// @Param body body InstallGoogleFontRequestDTO true "Google Fonts family name"
// @Success 201 {object} FontDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/fonts/google [post]
func (h *Handler) installGoogleFont(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	var input InstallGoogleFontRequestDTO
	if !decodeCustomIconRequest(writer, request, &input) {
		return
	}
	installer, err := h.googleFonts()
	if err != nil {
		writeInternalError(writer, err)
		return
	}
	extendTransferDeadlines(writer)
	family, faces, err := installer.Install(request.Context(), input.Family)
	if err != nil {
		writeFontError(writer, err)
		return
	}
	font, err := h.repo.CreateFont(request.Context(), family, repository.FontSourceGoogle, faces)
	if err != nil {
		writeFontError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, projectFontDTO(font))
}

// uploadFont stores the files of one family. The family's name is the operator's when
// given and otherwise the one the first file declares in its own name table.
//
// @Summary Upload custom font files
// @Description Upload up to 12 font files via multipart/form-data and store them as a local font family.
// @Tags Fonts
// @Accept multipart/form-data
// @Produce json
// @Security CookieAuth
// @Param family formData string false "Optional family name override"
// @Param file formData file true "Font file(s)"
// @Success 201 {object} FontDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 409 {object} ErrorResponseDTO
// @Failure 413 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/fonts/upload [post]
func (h *Handler) uploadFont(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	extendTransferDeadlines(writer)
	request.Body = http.MaxBytesReader(writer, request.Body, maxFontUploadBytes)
	reader, err := request.MultipartReader()
	if err != nil {
		writeFontError(writer, fontasset.ErrInvalid)
		return
	}
	family := ""
	var faces []fontasset.Face
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeFontUploadReadError(writer, err)
			return
		}
		switch part.FormName() {
		case "family":
			value, err := io.ReadAll(io.LimitReader(part, 1024))
			if err != nil {
				writeFontUploadReadError(writer, err)
				return
			}
			if len(value) > 0 {
				if family, err = fontasset.CleanFamily(string(value)); err != nil {
					writeFontError(writer, err)
					return
				}
			}
		case "file":
			if len(faces) == maxFontUploadFiles {
				writeFontError(writer, fontasset.ErrTooLarge)
				return
			}
			face, described, err := readFontPart(part)
			if err != nil {
				writeFontUploadReadError(writer, err)
				return
			}
			if family == "" {
				family = described
			}
			faces = append(faces, face)
		}
		_ = part.Close()
	}
	if len(faces) == 0 {
		writeFontError(writer, repository.ErrFontNoFaces)
		return
	}
	font, err := h.repo.CreateFont(request.Context(), family, repository.FontSourceUpload, faces)
	if err != nil {
		writeFontError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, projectFontDTO(font))
}

func readFontPart(part *multipart.Part) (fontasset.Face, string, error) {
	content, err := io.ReadAll(io.LimitReader(part, fontasset.MaxFileBytes+1))
	if err != nil {
		return fontasset.Face{}, "", err
	}
	format, err := fontasset.Sniff(content)
	if err != nil {
		return fontasset.Face{}, "", err
	}
	description, err := fontasset.Describe(content, part.FileName())
	if err != nil {
		return fontasset.Face{}, "", err
	}
	return fontasset.Face{
		WeightMin: description.WeightMin,
		WeightMax: description.WeightMax,
		Italic:    description.Italic,
		Format:    format,
		Content:   content,
	}, description.Family, nil
}

func writeFontUploadReadError(writer http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeFontError(writer, fontasset.ErrTooLarge)
		return
	}
	if errors.Is(err, fontasset.ErrTooLarge) || errors.Is(err, fontasset.ErrInvalid) || errors.Is(err, fontasset.ErrFamily) {
		writeFontError(writer, err)
		return
	}
	writeFontError(writer, fontasset.ErrInvalid)
}

// @Summary Delete a stored font family
// @Description Remove an uploaded or Google-installed font family from storage.
// @Tags Fonts
// @Security CookieAuth
// @Param id path string true "Font family ID"
// @Success 204 "No Content"
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/fonts/{id} [delete]
func (h *Handler) deleteFont(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	if err := h.repo.DeleteFont(request.Context(), chi.URLParam(request, "id")); err != nil {
		writeFontError(writer, err)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}

// fontFaceContent serves one stored file. A face's bytes never change under its id -
// a family is replaced by deleting and installing it again - so the response is
// cacheable for good, which is what keeps a CJK family's slices from being revalidated
// one request each on every page load.
//
// @Summary Serve font face file
// @Description Stream an immutable stored font face file by family ID and face ID.
// @Tags Fonts
// @Produce octet-stream
// @Security CookieAuth
// @Param id path string true "Font family ID"
// @Param faceId path string true "Font face ID"
// @Success 200 {file} binary
// @Failure 401 {object} ErrorResponseDTO
// @Failure 404 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/fonts/{id}/faces/{faceId} [get]
// @Router /v1/fonts/{id}/faces/{faceId} [head]
func (h *Handler) fontFaceContent(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	face, err := h.repo.GetFontFace(request.Context(), chi.URLParam(request, "id"), chi.URLParam(request, "faceId"))
	if err != nil {
		writeFontError(writer, err)
		return
	}
	writer.Header().Set("Content-Type", face.Format.MIME())
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	writer.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'none'; sandbox")
	writer.Header().Set("Content-Length", strconv.Itoa(len(face.Content)))
	if request.Method != http.MethodHead {
		_, _ = writer.Write(face.Content)
	}
}
