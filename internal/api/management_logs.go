package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/oh-my-cpa/oh-my-cpa/internal/cpa/management"
)

// management_logs.go is the session-protected facade over CPA's log endpoints.
//
// These routes are the whole surface: there is no general "call any management
// URL" proxy behind them. Every response is no-store — a cached log tail is a
// lie about what just happened.

// logsFacadeResponse is the browser shape of one incremental log read.
type logsFacadeResponse struct {
	Lines       []string `json:"lines"`
	LatestAfter int64    `json:"latest_after"`
	NextCursor  string   `json:"next_cursor"`
	CursorReset bool     `json:"cursor_reset"`
	Limit       int      `json:"limit"`
}

// managementLogs tails CPA's log file.
//
// `cursor` is preferred and `after` is the fallback for builds that predate it;
// the client shifts the `after` boundary back one second so lines sharing a
// timestamp with the last one read are not silently lost.
func (h *Handler) managementLogs(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	query := request.URL.Query()
	after := int64(0)
	if raw := strings.TrimSpace(query.Get("after")); raw != "" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed < 0 {
			writeError(writer, http.StatusBadRequest, "after must be a unix timestamp in seconds")
			return
		}
		after = parsed
	}
	page, _, err := client.Logs(request.Context(), management.LogsQuery{
		Cursor: strings.TrimSpace(query.Get("cursor")),
		After:  after,
		Limit:  parseLogsLimit(query.Get("limit")),
	})
	if err != nil {
		if fileLoggingDisabled(err) {
			writeJSON(writer, http.StatusConflict, map[string]string{
				"error": "CPA is not writing a log file",
				"code":  "file_logging_disabled",
			})
			return
		}
		writeCPAFacadeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, logsFacadeResponse{
		Lines:       page.Lines,
		LatestAfter: page.LatestAfter,
		NextCursor:  page.NextCursor,
		CursorReset: page.CursorReset,
		Limit:       len(page.Lines),
	})
}

// clearManagementLogs truncates CPA's log file. Destructive, so it is a POST-ish
// DELETE the operator triggers deliberately; nothing here runs on a timer.
func (h *Handler) clearManagementLogs(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	if _, err := client.ClearLogs(request.Context()); err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"cleared": true})
}

// managementLogsStatus reports the two CPA switches the log page depends on.
//
// CPAMC hides its log navigation entry when file logging is off, which reads to
// an operator as "the feature is broken" rather than "the switch is off". Oh My
// CPA keeps the entry and answers the question directly instead.
func (h *Handler) managementLogsStatus(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	config, _, err := client.Config(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]bool{
		"logging_to_file": configBool(config, "logging-to-file"),
		"request_log":     configBool(config, "request-log"),
	})
}

// requestErrorLogs lists the downloadable request-error log files.
func (h *Handler) requestErrorLogs(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	files, err := client.RequestErrorLogs(request.Context())
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"files": files})
}

// downloadRequestErrorLog streams one error log file back to the browser.
func (h *Handler) downloadRequestErrorLog(writer http.ResponseWriter, request *http.Request) {
	name := chi.URLParam(request, "name")
	if !management.ValidLogFileName(name) {
		writeError(writer, http.StatusBadRequest, "invalid log file name")
		return
	}
	client, ok := h.managementClientOrError(writer, request)
	if !ok {
		return
	}
	data, _, err := client.DownloadRequestErrorLog(request.Context(), name)
	if err != nil {
		writeCPAFacadeError(writer, err)
		return
	}
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write(data)
}

// fileLoggingDisabled recognises CPA's "logging to file disabled" answer.
//
// CPA replies 400, which is technically true and operationally useless: nobody
// sent a malformed request, the proxy is simply not writing a log file. That is
// a state the page can explain and offer a fix for, so it leaves here under its
// own code instead of as a generic upstream rejection.
func fileLoggingDisabled(err error) bool {
	var httpErr *management.HTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusBadRequest {
		return false
	}
	return strings.Contains(strings.ToLower(httpErr.Body), "logging to file")
}

// parseLogsLimit clamps a caller-supplied page size into the range CPA is
// asked to serve. Zero and garbage fall back to the default, not to "all".
func parseLogsLimit(raw string) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || parsed <= 0 {
		return management.DefaultLogsLimit
	}
	if parsed > management.MaxLogsLimit {
		return management.MaxLogsLimit
	}
	return parsed
}

// configBool reads a CPA config flag that arrives as a bool in some builds and
// a "true" string in others.
func configBool(config map[string]any, key string) bool {
	switch typed := config[key].(type) {
	case bool:
		return typed
	case string:
		return strings.EqualFold(strings.TrimSpace(typed), "true")
	}
	return false
}
