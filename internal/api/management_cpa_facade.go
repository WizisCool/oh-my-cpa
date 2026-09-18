package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

func (h *Handler) managementClientOrError(writer http.ResponseWriter, request *http.Request) (*management.Client, bool) {
	instance, err := h.repo.GetInstance(request.Context(), defaultInstanceID())
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || strings.Contains(err.Error(), sql.ErrNoRows.Error()) {
			writeError(writer, http.StatusServiceUnavailable, "default CPA instance is not configured")
			return nil, false
		}
		writeInternalError(writer, err)
		return nil, false
	}
	client, err := h.clientForInstance(request.Context(), instance)
	if err != nil {
		writeInternalError(writer, err)
		return nil, false
	}
	return client, true
}

func writeCPAFacadeError(writer http.ResponseWriter, err error) {
	status := http.StatusBadGateway
	code := "cpa_unavailable"
	message := "CPA management request failed"
	var httpErr *management.HTTPError
	if errors.As(err, &httpErr) {
		switch httpErr.StatusCode {
		case http.StatusNotFound, http.StatusMethodNotAllowed:
			status = http.StatusNotImplemented
			code = "capability_missing"
			message = "CPA does not support this management operation"
		case http.StatusUnauthorized, http.StatusForbidden:
			status = http.StatusBadGateway
			code = "cpa_authentication_failed"
			message = "CPA management authentication failed"
		case http.StatusBadRequest, http.StatusUnprocessableEntity:
			status = http.StatusBadGateway
			code = "cpa_rejected_request"
			message = "CPA rejected the management request"
			if httpErr.Body != "" {
				var cpaErr struct {
					Error string `json:"error"`
				}
				if errJson := json.Unmarshal([]byte(httpErr.Body), &cpaErr); errJson == nil && cpaErr.Error != "" {
					message = fmt.Sprintf("CPA rejected the management request: %s", cpaErr.Error)
				}
			}
		}
	}
	writeJSON(writer, status, map[string]string{"error": message, "code": code})
}

func publicCPAErrorMessage(err error) string {
	var httpErr *management.HTTPError
	if errors.As(err, &httpErr) {
		if httpErr.StatusCode == http.StatusNotFound || httpErr.StatusCode == http.StatusMethodNotAllowed {
			return "CPA does not support this operation"
		}
		return fmt.Sprintf("CPA returned HTTP %d", httpErr.StatusCode)
	}
	return "CPA management request failed"
}

func decodeManagementJSON(writer http.ResponseWriter, request *http.Request, limit int64, output any) error {
	request.Body = http.MaxBytesReader(writer, request.Body, limit)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		writeError(writer, http.StatusBadRequest, "invalid request body")
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		writeError(writer, http.StatusBadRequest, "invalid request body")
		return errors.New("multiple JSON values")
	}
	return nil
}
