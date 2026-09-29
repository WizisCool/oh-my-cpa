package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/configyaml"
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
	// reason is CPA's own sentence for a rejected configuration, carried apart
	// from the message so the console can frame it in the reader's language.
	reason := ""
	var httpErr *management.HTTPError
	if errors.Is(err, management.ErrManagementV8Required) {
		status = http.StatusBadGateway
		code = "cpa_v8_required"
		message = "CPA does not serve the v8 Management API; upgrade CPA to v8.0.0 or later"
	} else if errors.Is(err, management.ErrManagementDisabled) {
		status = http.StatusBadGateway
		code = "cpa_management_disabled"
		message = "CPA does not serve its Management API; set remote-management.secret-key in the CPA configuration"
	} else if errors.Is(err, management.ErrConfigBackupUnavailable) {
		// Nothing was sent to CPA: the file is unchanged.
		status = http.StatusServiceUnavailable
		code = "config_backup_failed"
		message = "the CPA configuration file could not be backed up before converting it to the v8 layout; nothing was changed"
	} else if errors.Is(err, management.ErrConfigPartiallyApplied) {
		status = http.StatusBadGateway
		code = "config_partially_applied"
		message = "CPA applied only part of the configuration change before a request failed; reload the configuration to see what was saved"
	} else if cpaReason, rejected := management.IsConfigRejected(err); rejected {
		status = http.StatusUnprocessableEntity
		code = "config_rejected"
		message = "CPA rejected the configuration: " + cpaReason
		reason = cpaReason
	} else if errors.As(err, &httpErr) {
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
	body := map[string]string{"error": message, "code": code}
	if reason != "" {
		body["reason"] = reason
	}
	writeJSON(writer, status, body)
}

// scrubConfigRejection removes the stored document's hidden values from CPA's
// reason for refusing a save. The save restored those values into what it sent,
// and CPA's reason can quote the value it refused.
func scrubConfigRejection(err error, storedYAML string) error {
	reason, rejected := management.IsConfigRejected(err)
	var httpErr *management.HTTPError
	if !rejected || !errors.As(err, &httpErr) {
		return err
	}
	body, marshalErr := json.Marshal(map[string]string{"error": "invalid_config", "message": configyaml.ScrubStoredSecrets(reason, storedYAML)})
	if marshalErr != nil {
		return err
	}
	return &management.HTTPError{StatusCode: httpErr.StatusCode, Body: string(body)}
}

// configWriteFailureDetail is the audit detail of a failed configuration write.
// A change set CPA stopped partway through did change the file, so the failure
// says so and the caller drops what the write made stale.
func configWriteFailureDetail(err error, detail map[string]any) map[string]any {
	detail["error"] = publicCPAErrorMessage(err)
	if errors.Is(err, management.ErrConfigPartiallyApplied) {
		detail["partially_applied"] = true
	}
	return detail
}

func publicCPAErrorMessage(err error) string {
	if errors.Is(err, management.ErrManagementV8Required) {
		return "CPA does not serve the v8 Management API"
	}
	if errors.Is(err, management.ErrManagementDisabled) {
		return "CPA does not serve its Management API"
	}
	if errors.Is(err, management.ErrConfigBackupUnavailable) {
		return "the CPA configuration file could not be backed up before converting it"
	}
	if errors.Is(err, management.ErrConfigPartiallyApplied) {
		return "CPA applied only part of the configuration change"
	}
	if _, rejected := management.IsConfigRejected(err); rejected {
		return "CPA rejected the configuration"
	}
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
