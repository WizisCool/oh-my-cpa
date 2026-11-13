package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// AuthFileUploadFailureItemDTO describes one failed auth file upload entry.
type AuthFileUploadFailureItemDTO struct {
	Name  string `json:"name"`
	Error string `json:"error"`
}

// AuthFileUploadResponseDTO summarizes single or batch auth file upload results.
type AuthFileUploadResponseDTO struct {
	Status   string                         `json:"status"`
	Uploaded int                            `json:"uploaded"`
	Files    []string                       `json:"files"`
	Failed   []AuthFileUploadFailureItemDTO `json:"failed,omitempty"`
}

// @Summary Upload credential auth file(s)
// @Description Upload one JSON auth file via raw body (`?name=*.json`) or batch upload up to 100 JSON files via multipart/form-data.
// @Tags AuthFiles
// @Accept json,mpfd
// @Produce json
// @Security CookieAuth
// @Param name query string false "Target filename (*.json) when uploading raw JSON body"
// @Param files formData file false "Auth JSON file(s) when using multipart/form-data"
// @Success 200 {object} AuthFileUploadResponseDTO
// @Success 207 {object} AuthFileUploadResponseDTO
// @Failure 400 {object} ErrorResponseDTO
// @Failure 401 {object} ErrorResponseDTO
// @Failure 413 {object} ErrorResponseDTO
// @Failure 502 {object} ErrorResponseDTO
// @Failure 503 {object} ErrorResponseDTO
// @Router /v1/management/auth-files [post]
func (h *Handler) uploadManagementAuthFiles(writer http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(writer, request.Body, managementAuthFileUploadLimit)
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}

	if strings.HasPrefix(strings.ToLower(request.Header.Get("Content-Type")), "multipart/form-data") {
		if err := request.ParseMultipartForm(2 * 1024 * 1024); err != nil {
			writeError(writer, http.StatusBadRequest, "invalid multipart form")
			return
		}
		files := make([]*multipartFileHeader, 0)
		for key, headers := range request.MultipartForm.File {
			if key != "file" && key != "files" {
				continue
			}
			for _, header := range headers {
				files = append(files, &multipartFileHeader{filename: header.Filename, open: header.Open})
			}
		}
		if len(files) == 0 {
			writeError(writer, http.StatusBadRequest, "no files uploaded")
			return
		}
		if len(files) > 100 {
			writeError(writer, http.StatusBadRequest, "too many files")
			return
		}
		h.handleUploadResults(writer, request.Context(), client, files)
		return
	}

	name, validationErr := validateJSONUploadName(request.URL.Query().Get("name"))
	if validationErr != nil {
		writeError(writer, http.StatusBadRequest, validationErr.Error())
		return
	}
	data, err := io.ReadAll(io.LimitReader(request.Body, managementAuthFileUploadLimit+1))
	if err != nil {
		writeError(writer, http.StatusBadRequest, "cannot read upload")
		return
	}
	if int64(len(data)) > managementAuthFileUploadLimit {
		writeError(writer, http.StatusRequestEntityTooLarge, "upload is too large")
		return
	}
	if err := validateAuthJSON(data); err != nil {
		writeError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if err := h.providerWrites.acquire(request.Context()); err != nil {
		writeProviderWriteError(writer, err)
		return
	}
	defer h.providerWrites.release()
	if err := h.flushCoordinatorUnderProviderGate(request.Context()); err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	if _, err := client.UploadAuthFile(request.Context(), name, data); err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	h.invalidateCoordinator("management-auth-files", "management-routing", "management-quota")
	writeJSON(writer, http.StatusOK, AuthFileUploadResponseDTO{Status: "ok", Uploaded: 1, Files: []string{name}})
}

type multipartFileHeader struct {
	filename string
	open     func() (multipart.File, error)
}

func (h *Handler) handleUploadResults(writer http.ResponseWriter, ctx context.Context, client *management.Client, files []*multipartFileHeader) {
	type preparedUpload struct {
		name string
		data []byte
	}
	prepared := make([]preparedUpload, 0, len(files))
	uploaded := make([]string, 0, len(files))
	failed := make([]AuthFileUploadFailureItemDTO, 0)
	for _, file := range files {
		name, uploadNameErr := validateJSONUploadName(file.filename)
		if uploadNameErr != nil {
			failed = append(failed, AuthFileUploadFailureItemDTO{Name: filepath.Base(file.filename), Error: uploadNameErr.Error()})
			continue
		}
		source, err := file.open()
		if err != nil {
			failed = append(failed, AuthFileUploadFailureItemDTO{Name: name, Error: "cannot open upload"})
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(source, managementAuthFileUploadLimit+1))
		_ = source.Close()
		if readErr != nil || int64(len(data)) > managementAuthFileUploadLimit {
			failed = append(failed, AuthFileUploadFailureItemDTO{Name: name, Error: "upload is too large or unreadable"})
			continue
		}
		if jsonErr := validateAuthJSON(data); jsonErr != nil {
			failed = append(failed, AuthFileUploadFailureItemDTO{Name: name, Error: jsonErr.Error()})
			continue
		}
		prepared = append(prepared, preparedUpload{name: name, data: data})
	}
	if len(prepared) > 0 {
		if err := h.providerWrites.acquire(ctx); err != nil {
			writeProviderWriteError(writer, err)
			return
		}
		defer h.providerWrites.release()
		if err := h.flushCoordinatorUnderProviderGate(ctx); err != nil {
			writeCPAFacadeError(writer, err)
			return
		}
		for _, item := range prepared {
			if _, uploadErr := client.UploadAuthFile(ctx, item.name, item.data); uploadErr != nil {
				failed = append(failed, AuthFileUploadFailureItemDTO{Name: item.name, Error: publicCPAErrorMessage(uploadErr)})
				continue
			}
			uploaded = append(uploaded, item.name)
		}
	}
	if len(uploaded) > 0 {
		if h.pricing != nil {
			h.pricing.NotifyModelsChanged()
		}
		h.invalidateCoordinator("management-auth-files", "management-routing", "management-quota")
	}
	if len(failed) > 0 {
		writeJSON(writer, http.StatusMultiStatus, AuthFileUploadResponseDTO{Status: "partial", Uploaded: len(uploaded), Files: uploaded, Failed: failed})
		return
	}
	writeJSON(writer, http.StatusOK, AuthFileUploadResponseDTO{Status: "ok", Uploaded: len(uploaded), Files: uploaded})
}

func validateJSONUploadName(raw string) (string, error) {
	name, err := validateAuthSelector(raw)
	if err != nil {
		return "", err
	}
	if !strings.HasSuffix(strings.ToLower(name), ".json") {
		return "", errors.New("name must end with .json")
	}
	return name, nil
}

func validateAuthJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	var object map[string]any
	if err := decoder.Decode(&object); err != nil || object == nil {
		return errors.New("auth file must be a JSON object")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("auth file must contain one JSON object")
	}
	return nil
}

// Keep this compile-time reference close to the upload adapter: the standard
// library multipart types are intentionally hidden behind a small adapter so
// the handler can enforce one upload contract.
var _ multipart.File
