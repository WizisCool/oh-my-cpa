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
	if _, err := client.UploadAuthFile(request.Context(), name, data); err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	if h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "uploaded": 1, "files": []string{name}})
}

type multipartFileHeader struct {
	filename string
	open     func() (multipart.File, error)
}

func (h *Handler) handleUploadResults(writer http.ResponseWriter, ctx context.Context, client *management.Client, files []*multipartFileHeader) {
	uploaded := make([]string, 0, len(files))
	failed := make([]map[string]string, 0)
	for _, file := range files {
		name, uploadNameErr := validateJSONUploadName(file.filename)
		if uploadNameErr != nil {
			failed = append(failed, map[string]string{"name": filepath.Base(file.filename), "error": uploadNameErr.Error()})
			continue
		}
		source, err := file.open()
		if err != nil {
			failed = append(failed, map[string]string{"name": name, "error": "cannot open upload"})
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(source, managementAuthFileUploadLimit+1))
		_ = source.Close()
		if readErr != nil || int64(len(data)) > managementAuthFileUploadLimit {
			failed = append(failed, map[string]string{"name": name, "error": "upload is too large or unreadable"})
			continue
		}
		if jsonErr := validateAuthJSON(data); jsonErr != nil {
			failed = append(failed, map[string]string{"name": name, "error": jsonErr.Error()})
			continue
		}
		if _, uploadErr := client.UploadAuthFile(ctx, name, data); uploadErr != nil {
			failed = append(failed, map[string]string{"name": name, "error": publicCPAErrorMessage(uploadErr)})
			continue
		}
		uploaded = append(uploaded, name)
	}
	if len(uploaded) > 0 && h.pricing != nil {
		h.pricing.NotifyModelsChanged()
	}
	if len(failed) > 0 {
		status := http.StatusMultiStatus
		writeJSON(writer, status, map[string]any{"status": "partial", "uploaded": len(uploaded), "files": uploaded, "failed": failed})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "uploaded": len(uploaded), "files": uploaded})
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
