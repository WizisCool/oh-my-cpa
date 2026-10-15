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
	writeJSON(writer, http.StatusOK, map[string]any{"fonts": fonts})
}

func (h *Handler) googleFonts() (*fontasset.GoogleInstaller, error) {
	h.fontInstallerOnce.Do(func() {
		if h.fontInstaller == nil {
			h.fontInstaller, h.fontInstallerErr = fontasset.NewGoogleInstaller(h.cfg.GoogleFontsURL, http.DefaultTransport)
		}
	})
	return h.fontInstaller, h.fontInstallerErr
}

func (h *Handler) installGoogleFont(writer http.ResponseWriter, request *http.Request) {
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "repository_unavailable")
		return
	}
	var input struct {
		Family string `json:"family"`
	}
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
	writeJSON(writer, http.StatusCreated, font)
}

// uploadFont stores the files of one family. The family's name is the operator's when
// given and otherwise the one the first file declares in its own name table.
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
	writeJSON(writer, http.StatusCreated, font)
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
