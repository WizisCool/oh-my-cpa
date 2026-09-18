package management

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// DownloadRequestLog fetches one CPA raw request log by request id.
//
// The id is validated here rather than by callers: CPA resolves it to a filename
// inside its log directory, so a traversal or empty value must never reach it.
// The response is capped like other downloads.
func (c *Client) DownloadRequestLog(ctx context.Context, requestID string) ([]byte, ResponseMeta, error) {
	requestID = strings.TrimSpace(requestID)
	if requestID == "" || strings.ContainsAny(requestID, "/\\") || strings.Contains(requestID, "..") {
		return nil, ResponseMeta{}, errors.New("invalid request id")
	}
	request, err := c.newRequest(ctx, http.MethodGet, "/request-log-by-id/"+url.PathEscape(requestID), nil, "")
	if err != nil {
		return nil, ResponseMeta{}, err
	}
	return c.doBytes(request, 16*1024*1024)
}

// DefaultLogsLimit and MaxLogsLimit bound one incremental log read.
//
// CPAMC asks for its whole 10k-line buffer on every poll. That is a
// multi-megabyte first response for a page whose whole value is "the recent
// tail", so the default page is smaller; the cap stays at 10k for a deliberate
// widening of the searchable window.
const (
	DefaultLogsLimit = 2000
	MaxLogsLimit     = 10000
)

// LogsQuery narrows one read of CPA's file log.
//
// CPA has two generations of this endpoint: an opaque server-side cursor, and
// the older `after` measured in unix seconds. The cursor wins when the server
// offers one. With `after`, the boundary is re-sent one second back, because a
// second-granularity cut drops whatever else shares that timestamp — a
// duplicated line is recoverable at render time, a missing one is not.
type LogsQuery struct {
	Cursor string
	After  int64
	Limit  int
}

// LogsPage is one normalised incremental read of the log tail.
type LogsPage struct {
	Lines       []string
	LatestAfter int64
	NextCursor  string
	CursorReset bool
}

// Logs reads the tail of CPA's file log.
func (c *Client) Logs(ctx context.Context, query LogsQuery) (LogsPage, ResponseMeta, error) {
	limit := query.Limit
	if limit <= 0 {
		limit = DefaultLogsLimit
	}
	if limit > MaxLogsLimit {
		limit = MaxLogsLimit
	}
	params := url.Values{}
	params.Set("limit", strconv.Itoa(limit))
	if cursor := strings.TrimSpace(query.Cursor); cursor != "" {
		params.Set("cursor", cursor)
	} else if query.After > 1 {
		params.Set("after", strconv.FormatInt(query.After-1, 10))
	}

	// The two positional fields are typed loosely on purpose: CPA builds vary
	// (numbers vs strings, absent vs false), and a rejected decode would blank
	// the whole log page over a cosmetic difference.
	var response struct {
		Lines       []string `json:"lines"`
		LatestAfter any      `json:"latest-timestamp"`
		NextCursor  string   `json:"next-cursor"`
		CursorReset any      `json:"cursor-reset"`
	}
	meta, err := c.DoJSONWithMeta(ctx, http.MethodGet, "/logs?"+params.Encode(), &response)
	if err != nil {
		return LogsPage{Lines: []string{}}, meta, err
	}
	page := LogsPage{
		Lines:       make([]string, 0, len(response.Lines)),
		LatestAfter: unixSecondsValue(response.LatestAfter),
		NextCursor:  strings.TrimSpace(response.NextCursor),
		CursorReset: boolValue(response.CursorReset),
	}
	for _, line := range response.Lines {
		if trimmed := strings.TrimRight(line, "\r\n"); trimmed != "" {
			page.Lines = append(page.Lines, trimmed)
		}
	}
	return page, meta, nil
}

// ClearLogs truncates CPA's log file. Destructive, and never reached by a
// poll: only an explicit operator action gets here.
func (c *Client) ClearLogs(ctx context.Context) (ResponseMeta, error) {
	return c.DoJSONWithMeta(ctx, http.MethodDelete, "/logs", nil)
}

// ErrorLogFile is one request-error log file held by CPA.
type ErrorLogFile struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
}

// RequestErrorLogs lists the downloadable request-error log files.
func (c *Client) RequestErrorLogs(ctx context.Context) ([]ErrorLogFile, error) {
	var response struct {
		Files []struct {
			Name     string `json:"name"`
			Size     any    `json:"size"`
			Modified any    `json:"modified"`
		} `json:"files"`
	}
	if err := c.DoJSON(ctx, http.MethodGet, "/request-error-logs", &response); err != nil {
		return nil, err
	}
	files := make([]ErrorLogFile, 0, len(response.Files))
	for _, file := range response.Files {
		name := strings.TrimSpace(file.Name)
		if name == "" {
			continue
		}
		files = append(files, ErrorLogFile{
			Name:     name,
			Size:     int64Value(file.Size),
			Modified: unixSecondsValue(file.Modified),
		})
	}
	return files, nil
}

// DownloadRequestErrorLog returns raw bytes for one named error log file.
//
// The name is validated here rather than by callers: CPA resolves it inside its
// log directory, so an empty value, a traversal or a path separator must never
// reach it.
func (c *Client) DownloadRequestErrorLog(ctx context.Context, name string) ([]byte, ResponseMeta, error) {
	if !ValidLogFileName(name) {
		return nil, ResponseMeta{}, errors.New("invalid log file name")
	}
	request, err := c.newRequest(ctx, http.MethodGet, "/request-error-logs/"+url.PathEscape(name), nil, "")
	if err != nil {
		return nil, ResponseMeta{}, err
	}
	return c.doBytes(request, 16*1024*1024)
}

// ValidLogFileName accepts a bare log filename and nothing else.
func ValidLogFileName(name string) bool {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 128 || strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		return false
	}
	return !strings.HasPrefix(name, ".")
}
