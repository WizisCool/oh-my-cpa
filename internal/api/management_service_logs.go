package api

import (
	"net/http"
	"strconv"

	"github.com/oh-my-cpa/oh-my-cpa/internal/applog"
)

// serviceLogPageDefault is one read when the console does not name a size: enough
// to fill the view on first open, small enough that a poll stays cheap.
const serviceLogPageDefault = 500

// serviceLogRecordDTO is the wire shape of one service log record.
type serviceLogRecordDTO struct {
	Seq        uint64        `json:"seq"`
	LoggedAtMS int64         `json:"logged_at_ms"`
	Level      string        `json:"level"`
	Message    string        `json:"message"`
	Attrs      []applog.Attr `json:"attrs,omitempty"`
}

// serviceLogs serves Oh My CPA's own recent log records - the ones it writes to
// stderr - so an operator can read them without shell access to the container.
//
// `after` resumes from the last sequence the console saw. A process built without
// the capture (tests, embedded use) answers `capturing: false` rather than an
// error, because "this build keeps no copy" is a state, not a failure.
func (h *Handler) serviceLogs(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	values := request.URL.Query()
	var after uint64
	if raw := values.Get("after"); raw != "" {
		parsed, err := strconv.ParseUint(raw, 10, 64)
		if err != nil {
			writeError(writer, http.StatusBadRequest, "after must be a non-negative integer")
			return
		}
		after = parsed
	}
	limit := serviceLogPageDefault
	if raw := values.Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed <= 0 {
			writeError(writer, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		limit = parsed
	}

	if h.serviceLog == nil {
		writeJSON(writer, http.StatusOK, map[string]any{
			"capturing": false,
			"records":   []serviceLogRecordDTO{},
		})
		return
	}
	page := h.serviceLog.Since(after, limit)
	records := make([]serviceLogRecordDTO, 0, len(page.Records))
	for _, record := range page.Records {
		records = append(records, serviceLogRecordDTO(record))
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"capturing":     true,
		"records":       records,
		"latest_seq":    page.LatestSeq,
		"oldest_seq":    page.OldestSeq,
		"gap":           page.Gap,
		"capacity":      h.serviceLog.Capacity(),
		"started_at_ms": h.serviceLog.StartedAt().UnixMilli(),
	})
}
