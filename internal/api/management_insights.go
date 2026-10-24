package api

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
	"github.com/oh-my-cpa/oh-my-cpa/internal/security"
)

// The Insights page reads a window once and pivots it in the browser.
//
// Every panel on the page - the metric tiles, the stacked trend, the rankings, the
// key-by-model matrix and the flow - is a different projection of the same usage:
// one window, partitioned by client key, call point, model, provider and
// credential. The cube carries that partition whole, so regrouping or narrowing
// the page is arithmetic on rows already in hand rather than another read, every
// panel describes one snapshot, and a group keeps its colour and rank across them.
// It is bounded by the dimension tuples that were active per bucket, not by
// traffic, and an automatic granularity coarsens rather than exceed
// maxInsightsCubeRows.

// maxInsightsCubeRows bounds one cube. At about a hundred bytes a row before
// compression it keeps the largest response within a few megabytes.
const maxInsightsCubeRows = 60000

// insightsCubeDimensions is the partition every cube row carries, in column order.
var insightsCubeDimensions = []repository.UsageDimension{
	repository.UsageDimensionKey, repository.UsageDimensionCallPoint, repository.UsageDimensionModel,
	repository.UsageDimensionProvider, repository.UsageDimensionCredential, repository.UsageDimensionAuthType,
}

// insightsCubeColumns names a row's cells. The first six are indices: the bucket
// into bucket_starts and the rest into the dictionaries, the credential column
// pointing at an (auth index, auth type) pair. The measures follow.
var insightsCubeColumns = []string{
	"bucket", "key", "call_point", "model", "provider", "credential",
	"requests", "failures", "input_tokens", "output_tokens", "reasoning_tokens", "cached_tokens",
	"cache_read_tokens", "cache_creation_tokens", "total_tokens", "latency_sum_ms", "ttft_sum_ms",
	"ttft_count", "cost_nanos", "priced_requests", "costed_requests",
}

type insightsCubeResponse struct {
	Window insightsWindow `json:"window"`
	// Compare is the period the window is measured against; null for all time.
	Compare      *insightsCompareWindow `json:"compare_window"`
	BucketStarts []int64                `json:"bucket_starts"`
	Dims         insightsDims           `json:"dims"`
	Columns      []string               `json:"columns"`
	Rows         [][]int64              `json:"rows"`
	// PreviousRows are the comparison period's totals per dimension tuple, in the
	// same columns without the leading bucket.
	PreviousRows [][]int64        `json:"previous_rows"`
	Coverage     insightsCoverage `json:"coverage"`
}

type insightsDims struct {
	Keys        []insightsKey        `json:"keys"`
	CallPoints  []string             `json:"call_points"`
	Models      []string             `json:"models"`
	Providers   []string             `json:"providers"`
	Credentials []insightsCredential `json:"credentials"`
}

// insightsKey names a client key by its fingerprint. The key itself never leaves
// the server: the alias is the operator's name for it and the mask the display
// form its last retained request carried.
type insightsKey struct {
	ID    string `json:"id"`
	Alias string `json:"alias,omitempty"`
	Mask  string `json:"mask,omitempty"`
	// IsClientKey is false for traffic that reached CPA without a client key,
	// which CPA labels with a provider or endpoint instead of a fingerprint.
	IsClientKey bool `json:"is_client_key"`
}

type insightsCredential struct {
	AuthIndex string `json:"auth_index"`
	AuthType  string `json:"auth_type"`
}

type insightsCoverage struct {
	FactRequests   int64 `json:"fact_requests"`
	DetailRequests int64 `json:"detail_requests"`
}

// insightsZone is the OMC Time Zone, which every civil window and bucket follows.
func (h *Handler) insightsZone() *time.Location {
	if h.repo != nil && h.repo.Timezone() != nil && h.repo.Timezone().Location() != nil {
		return h.repo.Timezone().Location()
	}
	return time.UTC
}

// insightsRangeFromRequest resolves the window on the handler's clock and widens
// it the way every facts read is widened behind the retention horizon.
func (h *Handler) insightsRangeFromRequest(ctx context.Context, request *http.Request) (insightsRange, string, error) {
	zone := h.insightsZone()
	resolved, message, err := resolveInsightsRange(request.URL.Query(), h.now(), zone, func() (*int64, error) {
		return h.repo.FirstUsageRecordMS(ctx, defaultInstanceID())
	})
	return resolved, message, err
}

func (h *Handler) insightsCube(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.queryTimeout())
	defer cancel()
	resolved, message, err := h.insightsRangeFromRequest(ctx, request)
	if err != nil {
		writeInternalError(writer, fmt.Errorf("resolve insights window: %w", err))
		return
	}
	if message != "" {
		writeError(writer, http.StatusBadRequest, message)
		return
	}
	zone := h.insightsZone()
	window := resolved.window

	var current repository.UsageFactResult
	var starts []int64
	var rows [][]int64
	builder := newInsightsDictionary()
	for {
		current, err = h.repo.QueryUsageFacts(ctx, repository.UsageFactQuery{
			InstanceID: defaultInstanceID(), FromMS: window.FromMS, ToMS: window.ToMS,
			Calendar:   &repository.UsageCalendar{Location: zone, Unit: window.Bucket.calendarUnit()},
			Dimensions: insightsCubeDimensions,
		})
		if err != nil {
			writeInternalError(writer, fmt.Errorf("query insights cube: %w", err))
			return
		}
		starts = window.Bucket.bucketStarts(current.FromMS, current.ToMS, zone)
		rows = builder.bucketedRows(current.Rows, starts, window.Bucket, zone)
		if len(rows) <= maxInsightsCubeRows {
			break
		}
		coarser, canCoarsen := insightsCoarser[window.Bucket]
		if !resolved.isAutoBucket || !canCoarsen {
			writeError(writer, http.StatusBadRequest, "the window holds too many combinations at this bucket; choose a coarser one")
			return
		}
		window.Bucket = coarser
		builder = newInsightsDictionary()
	}
	window.Widened = current.FromMS != window.FromMS || current.ToMS != window.ToMS
	window.FromMS, window.ToMS = current.FromMS, current.ToMS

	response := insightsCubeResponse{
		Window: window, Compare: resolved.compare, BucketStarts: starts, Columns: insightsCubeColumns,
		Rows: rows, PreviousRows: [][]int64{},
		Coverage: insightsCoverage{FactRequests: current.FactRequests, DetailRequests: current.DetailRequests},
	}
	if resolved.compare != nil {
		previous, errPrevious := h.repo.QueryUsageFacts(ctx, repository.UsageFactQuery{
			InstanceID: defaultInstanceID(), FromMS: resolved.compare.FromMS, ToMS: resolved.compare.ToMS,
			Dimensions: insightsCubeDimensions,
		})
		if errPrevious != nil {
			writeInternalError(writer, fmt.Errorf("query insights comparison: %w", errPrevious))
			return
		}
		response.Compare = &insightsCompareWindow{FromMS: previous.FromMS, ToMS: previous.ToMS}
		for _, row := range previous.Rows {
			response.PreviousRows = append(response.PreviousRows, builder.row(-1, row)[1:])
		}
	}
	response.Rows = builder.remap(response.Rows, 1)
	response.PreviousRows = builder.remap(response.PreviousRows, 0)
	dims, err := builder.dimensions(ctx, h.repo)
	if err != nil {
		writeInternalError(writer, fmt.Errorf("name insights keys: %w", err))
		return
	}
	response.Dims = dims
	writeJSON(writer, http.StatusOK, response)
}

// insightsDictionary assigns each dimension value an index while rows are built,
// then sorts the dictionaries so a response is stable for the same data.
type insightsDictionary struct {
	values [4]map[string]int
	// credentials are keyed by auth index and type together.
	credentials map[insightsCredential]int
}

func newInsightsDictionary() *insightsDictionary {
	dictionary := &insightsDictionary{credentials: map[insightsCredential]int{}}
	for index := range dictionary.values {
		dictionary.values[index] = map[string]int{}
	}
	return dictionary
}

func dictionaryIndex(values map[string]int, value string) int64 {
	if index, known := values[value]; known {
		return int64(index)
	}
	values[value] = len(values)
	return int64(len(values) - 1)
}

// row encodes one fact row with provisional dictionary indices.
func (dictionary *insightsDictionary) row(bucket int64, fact repository.UsageFactRow) []int64 {
	credential := insightsCredential{AuthIndex: fact.Keys[4], AuthType: fact.Keys[5]}
	credentialIndex, known := dictionary.credentials[credential]
	if !known {
		credentialIndex = len(dictionary.credentials)
		dictionary.credentials[credential] = credentialIndex
	}
	measures := fact.UsageMeasures
	return []int64{
		bucket, dictionaryIndex(dictionary.values[0], fact.Keys[0]), dictionaryIndex(dictionary.values[1], fact.Keys[1]),
		dictionaryIndex(dictionary.values[2], fact.Keys[2]), dictionaryIndex(dictionary.values[3], fact.Keys[3]), int64(credentialIndex),
		measures.Requests, measures.Failures, measures.InputTokens, measures.OutputTokens, measures.ReasoningTokens,
		measures.CachedTokens, measures.CacheReadTokens, measures.CacheCreationTokens, measures.TotalTokens,
		measures.LatencySumMS, measures.TTFTSumMS, measures.TTFTCount, measures.CostNanos,
		measures.PricedRequests, measures.CostedRequests,
	}
}

// bucketedRows places each fact row on the bucket grid and merges rows that land in
// one bucket - the local days of a month, which the repository returns separately.
func (dictionary *insightsDictionary) bucketedRows(facts []repository.UsageFactRow, starts []int64, bucket insightsBucket, zone *time.Location) [][]int64 {
	positions := make(map[int64]int64, len(starts))
	for index, start := range starts {
		positions[start] = int64(index)
	}
	merged := map[string][]int64{}
	order := []string{}
	for _, fact := range facts {
		position, onGrid := positions[bucket.bucketStart(time.UnixMilli(fact.StartMS), zone).UnixMilli()]
		if !onGrid {
			continue
		}
		encoded := dictionary.row(position, fact)
		identity := fmt.Sprint(encoded[:6])
		if existing, seen := merged[identity]; seen {
			for column := 6; column < len(encoded); column++ {
				existing[column] += encoded[column]
			}
			continue
		}
		merged[identity] = encoded
		order = append(order, identity)
	}
	rows := make([][]int64, 0, len(order))
	for _, identity := range order {
		rows = append(rows, merged[identity])
	}
	return rows
}

// sortedIndex maps provisional indices onto the sorted order of their values.
func sortedIndex[T comparable](values map[T]int, less func(left, right T) bool) ([]T, []int64) {
	sorted := make([]T, 0, len(values))
	for value := range values {
		sorted = append(sorted, value)
	}
	sort.Slice(sorted, func(left, right int) bool { return less(sorted[left], sorted[right]) })
	remap := make([]int64, len(values))
	for position, value := range sorted {
		remap[values[value]] = int64(position)
	}
	return sorted, remap
}

// remap rewrites provisional indices to the sorted dictionaries. offset is where the
// dimension columns start: 1 after a bucket column, 0 without one.
func (dictionary *insightsDictionary) remap(rows [][]int64, offset int) [][]int64 {
	var remaps [5][]int64
	for index := range dictionary.values {
		_, remaps[index] = sortedIndex(dictionary.values[index], func(left, right string) bool { return left < right })
	}
	_, remaps[4] = sortedIndex(dictionary.credentials, lessCredential)
	for _, row := range rows {
		for dimension, remap := range remaps {
			row[offset+dimension] = remap[row[offset+dimension]]
		}
	}
	return rows
}

func lessCredential(left, right insightsCredential) bool {
	if left.AuthIndex != right.AuthIndex {
		return left.AuthIndex < right.AuthIndex
	}
	return left.AuthType < right.AuthType
}

// dimensions renders the sorted dictionaries, naming each client key.
func (dictionary *insightsDictionary) dimensions(ctx context.Context, repo *repository.Repository) (insightsDims, error) {
	sortedStrings := func(values map[string]int) []string {
		sorted, _ := sortedIndex(values, func(left, right string) bool { return left < right })
		return sorted
	}
	keyIDs := sortedStrings(dictionary.values[0])
	fingerprints := make([]string, 0, len(keyIDs))
	for _, id := range keyIDs {
		if strings.HasPrefix(id, "hmac:") {
			fingerprints = append(fingerprints, id)
		}
	}
	aliases, err := repo.ClientKeyAliasesFor(ctx, defaultInstanceID(), fingerprints)
	if err != nil {
		return insightsDims{}, err
	}
	masks, err := repo.ClientKeyMasksFor(ctx, defaultInstanceID(), fingerprints)
	if err != nil {
		return insightsDims{}, err
	}
	dims := insightsDims{
		Keys:       make([]insightsKey, 0, len(keyIDs)),
		CallPoints: sortedStrings(dictionary.values[1]), Models: sortedStrings(dictionary.values[2]),
		Providers: sortedStrings(dictionary.values[3]),
	}
	for _, id := range keyIDs {
		dims.Keys = append(dims.Keys, insightsKey{ID: id, Alias: aliases[id], Mask: security.NormalizeMask(masks[id]), IsClientKey: strings.HasPrefix(id, "hmac:")})
	}
	dims.Credentials, _ = sortedIndex(dictionary.credentials, lessCredential)
	return dims, nil
}

// insightsRhythmResponse is the window's usage by local weekday and hour.
type insightsRhythmResponse struct {
	Window insightsWindow `json:"window"`
	// Cells hold all 168 weekday-hour slots, Monday first, zero where nothing ran.
	Cells []insightsRhythmCell `json:"cells"`
}

type insightsRhythmCell struct {
	// Weekday counts from Monday (0) to Sunday (6).
	Weekday     int   `json:"weekday"`
	Hour        int   `json:"hour"`
	Requests    int64 `json:"requests"`
	TotalTokens int64 `json:"total_tokens"`
	CostNanos   int64 `json:"cost_nanos"`
}

// insightsRhythmFilters reads the filter vocabulary the request list already uses.
// A raw client key is fingerprinted, so the key itself is never a query value.
func (h *Handler) insightsRhythmFilters(request *http.Request) map[repository.UsageDimension][]string {
	query := request.URL.Query()
	filters := map[repository.UsageDimension][]string{}
	for parameter, dimension := range map[string]repository.UsageDimension{
		"model_alias": repository.UsageDimensionCallPoint, "model": repository.UsageDimensionModel,
		"provider": repository.UsageDimensionProvider, "auth_index": repository.UsageDimensionCredential,
	} {
		for _, value := range query[parameter] {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				filters[dimension] = append(filters[dimension], trimmed)
			}
		}
	}
	for _, value := range query["api_key"] {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		filters[repository.UsageDimensionKey] = append(filters[repository.UsageDimensionKey], trimmed)
		// A value that is not a fingerprint is either a raw key or the label CPA gives
		// keyless traffic. Matching both is exact: a raw key is never stored as a group.
		if !strings.HasPrefix(trimmed, "hmac:") {
			if fingerprint, err := h.repo.UsageClientKeyFingerprint(trimmed); err == nil {
				filters[repository.UsageDimensionKey] = append(filters[repository.UsageDimensionKey], fingerprint)
			}
		}
	}
	return filters
}

// insightsRhythm answers when in the week usage happens. It needs local hours,
// which the cube's coarser buckets cannot give, so it is its own read; it honours
// the same filters the page applies to the cube.
func (h *Handler) insightsRhythm(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	if h.repo == nil {
		writeError(writer, http.StatusServiceUnavailable, "database is unavailable")
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), h.queryTimeout())
	defer cancel()
	resolved, message, err := h.insightsRangeFromRequest(ctx, request)
	if err != nil {
		writeInternalError(writer, fmt.Errorf("resolve insights window: %w", err))
		return
	}
	if message != "" {
		writeError(writer, http.StatusBadRequest, message)
		return
	}
	zone := h.insightsZone()
	window := resolved.window
	result, err := h.repo.QueryUsageFacts(ctx, repository.UsageFactQuery{
		InstanceID: defaultInstanceID(), FromMS: window.FromMS, ToMS: window.ToMS,
		Calendar: &repository.UsageCalendar{Location: zone, Unit: repository.UsageCalendarHour},
		Filters:  h.insightsRhythmFilters(request),
	})
	if err != nil {
		writeInternalError(writer, fmt.Errorf("query insights rhythm: %w", err))
		return
	}
	window.Widened = result.FromMS != window.FromMS || result.ToMS != window.ToMS
	window.FromMS, window.ToMS, window.Bucket = result.FromMS, result.ToMS, insightsBucketHour
	cells := make([]insightsRhythmCell, 7*24)
	for index := range cells {
		cells[index].Weekday, cells[index].Hour = index/24, index%24
	}
	for _, row := range result.Rows {
		local := time.UnixMilli(row.StartMS).In(zone)
		cell := &cells[((int(local.Weekday())+6)%7)*24+local.Hour()]
		cell.Requests += row.Requests
		cell.TotalTokens += row.TotalTokens
		cell.CostNanos += row.CostNanos
	}
	writeJSON(writer, http.StatusOK, insightsRhythmResponse{Window: window, Cells: cells})
}
