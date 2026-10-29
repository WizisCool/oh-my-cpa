package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// errUnknownLocalGrainZone marks derived local-day state whose zone this image
// cannot resolve, such as after a restore onto different tzdata.
var errUnknownLocalGrainZone = errors.New("local usage grain names an unknown zone")

// CheckpointFacts names the single watermark both fact grains advance under.
const CheckpointFacts = "facts"

// QuarterHourBucketMS is the fine fact grain. Every civil UTC offset in use is a
// multiple of it, so a local calendar day is a whole number of buckets in any
// deployment timezone.
const QuarterHourBucketMS int64 = 15 * 60 * 1000

// LifecycleUsageDetail is the lifecycle policy that rolls request records.
const LifecycleUsageDetail = "usage_detail"

const (
	usageFactsFineTable  = "usage_facts_15m"
	usageFactsDailyTable = "usage_facts_daily"
	// usageFactsLocalTable holds whole local days in the one zone its checkpoint
	// marker names; see migration 047.
	usageFactsLocalTable = "usage_facts_local_daily"
	// localFactsMarkerPrefix names the checkpoint row that says which zone the
	// local grain is built for. The row exists exactly when the grain is complete.
	localFactsMarkerPrefix = "facts_local:"
)

// usageFactDimensions are the columns a fact row is keyed on besides its bucket.
// usage_events carries the same names, so one expression groups either source.
const usageFactDimensions = `api_group_key, model, model_alias, auth_index, provider, auth_type`

// usageFactMeasures lists the additive columns, in the order every read scans them.
var usageFactMeasures = []string{
	"requests", "failures", "input_tokens", "output_tokens", "reasoning_tokens",
	"cached_tokens", "cache_read_tokens", "cache_creation_tokens", "total_tokens",
	"latency_sum_ms", "ttft_sum_ms", "ttft_count", "cost_nanos", "priced_requests",
	"costed_requests", "canonical_requests", "unresolved_accounting_requests",
	"raw_input_tokens", "raw_output_tokens", "raw_total_tokens",
}

// usageEventMeasures is one request record expressed as the same measures, so a
// record that has not been folded yet contributes exactly what its fact row will.
const usageEventMeasures = `
	1 AS requests, failed AS failures, input_tokens, output_tokens, reasoning_tokens,
	cached_tokens, cache_read_tokens, cache_creation_tokens, total_tokens,
	latency_ms AS latency_sum_ms, COALESCE(ttft_ms, 0) AS ttft_sum_ms,
	(ttft_ms IS NOT NULL) AS ttft_count, COALESCE(cost_nanos, 0) AS cost_nanos,
	(pricing_status = 'priced') AS priced_requests, (cost_nanos IS NOT NULL) AS costed_requests,
	(COALESCE(json_extract(token_accounting, '$.status'), '') = 'complete') AS canonical_requests,
	(token_accounting IS NOT NULL AND json_extract(token_accounting, '$.status') <> 'complete') AS unresolved_accounting_requests,
	COALESCE(json_extract(token_accounting, '$.raw_tokens.input_tokens'), 0) AS raw_input_tokens,
	COALESCE(json_extract(token_accounting, '$.raw_tokens.output_tokens'), 0) AS raw_output_tokens,
	COALESCE(json_extract(token_accounting, '$.raw_tokens.total_tokens'), 0) AS raw_total_tokens`

// UsageDimension is one column a usage read can partition or narrow by.
//
// A new way to slice usage is one more value here with its SQL expression in
// usageDimensionExpressions: the fact tables already carry every dimension, and
// the composition of facts and unfolded records is shared by every read.
type UsageDimension string

const (
	// UsageDimensionKey is the client key fingerprint (api_group_key). Traffic that
	// reached CPA without a client key carries CPA's own fallback label instead of
	// an `hmac:` fingerprint.
	UsageDimensionKey UsageDimension = "key"
	// UsageDimensionModel is the upstream model name as CPA recorded it.
	UsageDimensionModel UsageDimension = "model"
	// UsageDimensionCallPoint is the model alias a client requested, falling back
	// to the upstream model name when no alias was set.
	UsageDimensionCallPoint UsageDimension = "call_point"
	// UsageDimensionProvider is CPA's provider label, `unknown` when it sent none.
	UsageDimensionProvider UsageDimension = "provider"
	// UsageDimensionCredential is the runtime auth index of the credential that
	// served the request, whatever its type.
	UsageDimensionCredential UsageDimension = "credential"
	// UsageDimensionAuthType is the type of that credential (`apikey`, `oauth`, …).
	UsageDimensionAuthType UsageDimension = "auth_type"
	// UsageDimensionServingKey is the auth index of the API key that served an
	// API-key request, and empty for every other record. CPA labels an API-key
	// request with its family, the same label an OAuth request of that family
	// carries, so the provider label alone cannot say which configured provider
	// answered.
	UsageDimensionServingKey UsageDimension = "serving_key"
)

// usageDimensionExpressions maps a dimension to its SQL expression. The
// expressions only use columns present on both the fact tables and usage_events;
// model_alias is nullable on the latter, hence the COALESCE.
var usageDimensionExpressions = map[UsageDimension]string{
	UsageDimensionKey:        `api_group_key`,
	UsageDimensionModel:      `model`,
	UsageDimensionCallPoint:  `COALESCE(NULLIF(TRIM(COALESCE(model_alias, '')), ''), model)`,
	UsageDimensionProvider:   `COALESCE(NULLIF(TRIM(provider), ''), 'unknown')`,
	UsageDimensionCredential: `TRIM(auth_index)`,
	UsageDimensionAuthType:   `auth_type`,
	UsageDimensionServingKey: `CASE WHEN auth_type = 'apikey' THEN TRIM(auth_index) ELSE '' END`,
}

// UsageCalendarUnit is a civil bucket on the deployment's calendar.
type UsageCalendarUnit string

const (
	UsageCalendarHour UsageCalendarUnit = "hour"
	UsageCalendarDay  UsageCalendarUnit = "day"
	// UsageCalendarWeek starts on Monday, as the token activity grid does.
	UsageCalendarWeek UsageCalendarUnit = "week"
)

// UsageCalendar asks for buckets that follow a time zone's wall clock instead of
// the epoch grid: a day bucket then starts at local midnight even across a
// daylight-saving change, when the day is 23 or 25 hours long.
type UsageCalendar struct {
	Location *time.Location
	Unit     UsageCalendarUnit
}

// TokenAccountingMeasures retain the scope of raw evidence alongside the
// normalized sums. Requests not counted here are legacy, not known zero usage.
type TokenAccountingMeasures struct {
	CanonicalRequests  int64 `json:"canonical_requests"`
	UnresolvedRequests int64 `json:"unresolved_requests"`
	RawInputTokens     int64 `json:"raw_input_tokens"`
	RawOutputTokens    int64 `json:"raw_output_tokens"`
	RawTotalTokens     int64 `json:"raw_total_tokens"`
}

// UsageMeasures is the additive content of one fact row or one request record.
type UsageMeasures struct {
	Accounting TokenAccountingMeasures
	UsageTotals
	// CostNanos sums request-time cost snapshots; a request with no usable price
	// contributes nothing rather than a fabricated zero price.
	CostNanos int64
	// PricedRequests counts requests priced at request time. Requests minus this
	// is the number the cost leaves out.
	PricedRequests int64
	// CostedRequests counts requests that carry a stored cost.
	CostedRequests int64
}

func (m *UsageMeasures) add(other UsageMeasures) {
	m.UsageTotals.add(other.UsageTotals)
	m.CostNanos += other.CostNanos
	m.PricedRequests += other.PricedRequests
	m.CostedRequests += other.CostedRequests
	m.Accounting.CanonicalRequests += other.Accounting.CanonicalRequests
	m.Accounting.UnresolvedRequests += other.Accounting.UnresolvedRequests
	m.Accounting.RawInputTokens += other.Accounting.RawInputTokens
	m.Accounting.RawOutputTokens += other.Accounting.RawOutputTokens
	m.Accounting.RawTotalTokens += other.Accounting.RawTotalTokens
}

// UsageFactQuery is one read of deployment usage.
type UsageFactQuery struct {
	InstanceID string
	// FromMS and ToMS are inclusive.
	FromMS int64
	ToMS   int64
	// BucketMS is the series grid on the epoch. Zero returns one row per group for
	// the whole window, with StartMS zero. Ignored when Calendar is set.
	BucketMS int64
	// Calendar replaces the epoch grid with civil buckets in a time zone.
	Calendar *UsageCalendar
	// Dimensions partition the rows, in this order; none returns one series for
	// the whole deployment.
	Dimensions []UsageDimension
	// Filters keep only rows whose dimension value is one of the listed values.
	// An empty list for a dimension is no constraint.
	Filters map[UsageDimension][]string
}

// UsageFactRow is one group's usage inside one bucket.
type UsageFactRow struct {
	// Keys holds one value per requested dimension, in the query's order.
	Keys    []string
	StartMS int64
	UsageMeasures
}

// UsageFactResult is a usage read together with what it actually covered.
type UsageFactResult struct {
	// Rows are ordered by their keys and then by bucket.
	Rows []UsageFactRow
	// FromMS, ToMS and BucketMS are the window that was read. They differ from the
	// request only where request records for part of it have been deleted: the
	// window is then widened to whole fact buckets, because a bucket cannot be
	// split once the records behind it are gone. BucketMS is zero for a calendar read.
	FromMS   int64
	ToMS     int64
	BucketMS int64
	// FactRequests were answered from the fact tables and DetailRequests from
	// request records, so a caller can say how much of a window was pre-aggregated.
	FactRequests   int64
	DetailRequests int64
}

// Totals sums every row of the read.
func (result UsageFactResult) Totals() UsageMeasures {
	var totals UsageMeasures
	for _, row := range result.Rows {
		totals.add(row.UsageMeasures)
	}
	return totals
}

// usageFactPlan says which source answers which part of a window.
//
// The window is cut on the fact grid: whole days come from the daily table, the
// remaining whole quarter hours from the fine table, and the sub-bucket edges
// from request records. Every request record past the checkpoint is read from
// usage_events wherever it falls, because no fact row contains it yet.
type usageFactPlan struct {
	fromMS, toMS, bucketMS int64
	// fineFrom and fineTo bound the quarter-hour-aligned core, [fineFrom, fineTo).
	// Equal values mean no fact table is read.
	fineFrom, fineTo int64
	// dailyFrom and dailyTo bound the whole days inside the core, [dailyFrom,
	// dailyTo). Equal values mean the fine table answers the whole core.
	dailyFrom, dailyTo int64
	// localFrom and localTo bound the whole local days inside the core, as
	// instants, and wallFrom and wallTo name the same days on the wall clock.
	// Equal instants mean the local grain is not read.
	localFrom, localTo int64
	wallFrom, wallTo   int64
	// localMarker is the checkpoint row that must exist for the local grain to
	// answer [localFrom, localTo); without it the fine table answers instead.
	localMarker string
}

func alignDown(value, step int64) int64 { return (value / step) * step }

func alignUp(value, step int64) int64 { return ((value + step - 1) / step) * step }

// AlignUsageWindow widens a window so every part of it can still be answered.
//
// Request records before horizonMS have been deleted, so an edge that reaches
// behind it can only be read as whole fact buckets, and a grid finer than the
// fact grain has nothing left to bucket. The horizon itself is always a whole
// day, so a bucket is either entirely readable from request records or not at all.
func AlignUsageWindow(horizonMS, fromMS, toMS, bucketMS int64) (int64, int64, int64) {
	if fromMS < horizonMS {
		fromMS = alignDown(fromMS, QuarterHourBucketMS)
		if bucketMS > 0 && bucketMS%QuarterHourBucketMS != 0 {
			bucketMS = alignUp(bucketMS, QuarterHourBucketMS)
		}
	}
	if toMS < horizonMS {
		toMS = alignUp(toMS+1, QuarterHourBucketMS) - 1
	}
	return fromMS, toMS, bucketMS
}

// planUsageFactRead cuts a window into sources. isDailyUsable says whether a whole
// UTC day of the daily table falls inside a single output bucket; an epoch grid of
// whole days and the totals read guarantee it, and a calendar grid only when its
// zone keeps a zero offset over the window.
func planUsageFactRead(horizonMS, fromMS, toMS, bucketMS int64, isDailyUsable bool) usageFactPlan {
	fromMS, toMS, bucketMS = AlignUsageWindow(horizonMS, fromMS, toMS, bucketMS)
	plan := usageFactPlan{fromMS: fromMS, toMS: toMS, bucketMS: bucketMS}

	// A fact row cannot be split across a grid finer than its grain: re-aligning
	// it would report the whole bucket in its first slot and the rest as zero,
	// leaving the total right and the distribution wrong. Such a grid is read from
	// request records alone.
	if bucketMS > 0 && bucketMS%QuarterHourBucketMS != 0 {
		return plan
	}
	fineFrom := alignUp(fromMS, QuarterHourBucketMS)
	fineTo := alignDown(toMS+1, QuarterHourBucketMS)
	if fineFrom >= fineTo {
		return plan
	}
	plan.fineFrom, plan.fineTo = fineFrom, fineTo
	plan.dailyFrom, plan.dailyTo = fineFrom, fineFrom

	if isDailyUsable {
		dailyFrom := alignUp(fromMS, DayBucketMS)
		dailyTo := alignDown(toMS+1, DayBucketMS)
		if dailyFrom < dailyTo {
			plan.dailyFrom, plan.dailyTo = dailyFrom, dailyTo
		}
	}
	return plan
}

// calendarGrid is a calendar read compiled for SQL: the wall-clock bucket width and
// the zone's offsets over the window, as half-open instant segments.
type calendarGrid struct {
	location *time.Location
	unit     UsageCalendarUnit
	segments []offsetSegment
}

type offsetSegment struct {
	// untilMS is exclusive; the last segment's is unused.
	untilMS  int64
	offsetMS int64
}

// compileCalendar lists the offsets a zone takes over [fromMS, toMS]. Zones change
// offset a handful of times a year, so the list stays short however long the window.
func compileCalendar(calendar UsageCalendar, fromMS, toMS int64) (calendarGrid, error) {
	if calendar.Location == nil {
		return calendarGrid{}, errors.New("calendar read needs a time zone")
	}
	switch calendar.Unit {
	case UsageCalendarHour, UsageCalendarDay, UsageCalendarWeek:
	default:
		return calendarGrid{}, fmt.Errorf("unknown calendar unit %q", calendar.Unit)
	}
	grid := calendarGrid{location: calendar.Location, unit: calendar.Unit}
	at := time.UnixMilli(fromMS).In(calendar.Location)
	for {
		_, offset := at.Zone()
		_, end := at.ZoneBounds()
		segment := offsetSegment{offsetMS: int64(offset) * 1000}
		if end.IsZero() || end.UnixMilli() > toMS {
			grid.segments = append(grid.segments, segment)
			return grid, nil
		}
		segment.untilMS = end.UnixMilli()
		grid.segments = append(grid.segments, segment)
		at = end.In(calendar.Location)
	}
}

// isZeroOffset reports whether the zone sits on UTC for the whole window, which is
// the only case where a UTC day of the daily table is also a local day.
func (grid calendarGrid) isZeroOffset() bool {
	for _, segment := range grid.segments {
		if segment.offsetMS != 0 {
			return false
		}
	}
	return true
}

// wallClock renders the SQL for an instant column's local wall-clock time, as
// milliseconds on a clock that never changes offset.
//
// Bucketing the wall clock rather than the instant is what keeps a local day one
// bucket when daylight saving starts or ends inside it: every row of that day has
// the same wall-clock date, whichever offset it was recorded under. Every offset in
// use is a multiple of fifteen minutes and transitions fall on fact buckets, so a
// fact row never straddles a local hour.
func (grid calendarGrid) wallClock(column string) string {
	if len(grid.segments) == 1 {
		return fmt.Sprintf("(%s + %d)", column, grid.segments[0].offsetMS)
	}
	var builder strings.Builder
	builder.WriteString("(" + column + " + CASE")
	for _, segment := range grid.segments[:len(grid.segments)-1] {
		fmt.Fprintf(&builder, " WHEN %s < %d THEN %d", column, segment.untilMS, segment.offsetMS)
	}
	fmt.Fprintf(&builder, " ELSE %d END)", grid.segments[len(grid.segments)-1].offsetMS)
	return builder.String()
}

// The Unix epoch fell on a Thursday; shifting by three days puts week boundaries
// on Monday.
const mondayShiftMS = 3 * DayBucketMS

// bucket renders the SQL for the wall-clock start of the bucket holding a column.
func (grid calendarGrid) bucket(column string) string {
	wall := grid.wallClock(column)
	switch grid.unit {
	case UsageCalendarHour:
		return fmt.Sprintf("((%s / %d) * %d)", wall, HourBucketMS, HourBucketMS)
	case UsageCalendarDay:
		return fmt.Sprintf("((%s / %d) * %d)", wall, DayBucketMS, DayBucketMS)
	default:
		week := 7 * DayBucketMS
		return fmt.Sprintf("(((%s + %d) / %d) * %d - %d)", wall, mondayShiftMS, week, week, mondayShiftMS)
	}
}

// instant turns a wall-clock bucket start back into the instant it names. A local
// midnight or hour that a daylight-saving jump skips resolves forward, as Go's
// time.Date does.
func (grid calendarGrid) instant(wallMS int64) int64 {
	wall := time.UnixMilli(wallMS).UTC()
	return time.Date(wall.Year(), wall.Month(), wall.Day(), wall.Hour(), 0, 0, 0, grid.location).UnixMilli()
}

// bucketFromWall renders the bucket for a column that already holds a wall-clock
// local midnight, as the local grain does.
func (grid calendarGrid) bucketFromWall(column string) string {
	if grid.unit == UsageCalendarDay {
		return column
	}
	week := 7 * DayBucketMS
	return fmt.Sprintf("(((%s + %d) / %d) * %d - %d)", column, mondayShiftMS, week, week, mondayShiftMS)
}

// localMidnight is the instant a local day begins, and the same day's midnight on
// the wall clock. A midnight that a daylight-saving jump skips resolves to the
// first instant of that day, which is also where its records start.
func localMidnight(at time.Time, location *time.Location, dayOffset int) (int64, int64) {
	local := at.In(location)
	start := time.Date(local.Year(), local.Month(), local.Day()+dayOffset, 0, 0, 0, 0, location)
	wall := time.Date(start.Year(), start.Month(), start.Day(), 0, 0, 0, 0, time.UTC)
	return start.UnixMilli(), wall.UnixMilli()
}

// planLocalDays marks the whole local days inside the plan's quarter-hour core for
// the local grain. Local midnights fall on quarter hours in every zone, so the
// fine table still answers exactly what is left on either side.
func planLocalDays(plan *usageFactPlan, location *time.Location) {
	if plan.fineFrom >= plan.fineTo {
		return
	}
	fromMS, fromWall := localMidnight(time.UnixMilli(plan.fineFrom), location, 0)
	if fromMS < plan.fineFrom {
		fromMS, fromWall = localMidnight(time.UnixMilli(plan.fineFrom), location, 1)
	}
	toMS, toWall := localMidnight(time.UnixMilli(plan.fineTo), location, 0)
	if fromMS >= toMS {
		return
	}
	plan.localFrom, plan.localTo, plan.wallFrom, plan.wallTo = fromMS, toMS, fromWall, toWall
	plan.localMarker = localFactsMarkerPrefix + location.String()
}

// QueryUsageFacts answers one usage window, for any partition, from the permanent
// facts plus whatever request records the facts do not cover yet.
//
// It is one SQL statement on purpose. The parts are only disjoint against a
// single view of the checkpoint: a fold committing between two statements would
// move records from "past the checkpoint" into the fact tables and one of the
// two reads would count them twice or not at all. A statement reads one snapshot.
//
// The boundary between facts and records is the event id, not a timestamp. CPA
// reports a request's start time, so records arrive out of time order; an id
// boundary is exact regardless, because a fold covers precisely the ids up to
// its checkpoint.
func (r *Repository) QueryUsageFacts(ctx context.Context, query UsageFactQuery) (UsageFactResult, error) {
	result := UsageFactResult{Rows: []UsageFactRow{}}
	if r == nil || r.SQL() == nil {
		return result, errors.New("repository is not initialized")
	}
	if query.ToMS < query.FromMS {
		return result, errors.New("usage window is negative")
	}
	if query.BucketMS < 0 {
		return result, fmt.Errorf("invalid usage bucket width %d", query.BucketMS)
	}
	for _, dimension := range query.Dimensions {
		if _, known := usageDimensionExpressions[dimension]; !known {
			return result, fmt.Errorf("unknown usage dimension %q", dimension)
		}
	}
	for dimension := range query.Filters {
		if _, known := usageDimensionExpressions[dimension]; !known {
			return result, fmt.Errorf("unknown usage filter %q", dimension)
		}
	}
	horizonMS, err := r.LifecycleHorizonMS(ctx, LifecycleUsageDetail)
	if err != nil {
		return result, err
	}
	var grid *calendarGrid
	bucketMS := query.BucketMS
	isDailyUsable := bucketMS == 0 || bucketMS%DayBucketMS == 0
	if query.Calendar != nil {
		compiled, errCompile := compileCalendar(*query.Calendar, query.FromMS, query.ToMS)
		if errCompile != nil {
			return result, errCompile
		}
		grid = &compiled
		// The grid only needs to be a multiple of the fact grain here; the calendar
		// expression does the bucketing.
		bucketMS = QuarterHourBucketMS
		isDailyUsable = query.Calendar.Unit != UsageCalendarHour && compiled.isZeroOffset()
	}
	plan := planUsageFactRead(horizonMS, query.FromMS, query.ToMS, bucketMS, isDailyUsable)
	if grid != nil && !isDailyUsable && grid.unit != UsageCalendarHour {
		planLocalDays(&plan, grid.location)
	}
	result.FromMS, result.ToMS, result.BucketMS = plan.fromMS, plan.toMS, plan.bucketMS
	if grid != nil {
		result.BucketMS = 0
	}

	statement, args := buildUsageFactStatement(plan, query, grid)
	rows, err := r.SQL().QueryContext(ctx, statement, args...)
	if err != nil {
		return result, fmt.Errorf("read usage facts: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		row := UsageFactRow{Keys: make([]string, len(query.Dimensions))}
		var factRequests int64
		targets := make([]any, 0, len(query.Dimensions)+len(usageFactMeasures)+2)
		for index := range row.Keys {
			targets = append(targets, &row.Keys[index])
		}
		targets = append(targets, &row.StartMS)
		targets = append(targets, usageMeasureTargets(&row.UsageMeasures)...)
		targets = append(targets, &factRequests)
		if errScan := rows.Scan(targets...); errScan != nil {
			return result, fmt.Errorf("scan usage fact row: %w", errScan)
		}
		if grid != nil {
			row.StartMS = grid.instant(row.StartMS)
		}
		result.FactRequests += factRequests
		result.DetailRequests += row.Requests - factRequests
		result.Rows = append(result.Rows, row)
	}
	if err := rows.Err(); err != nil {
		return result, fmt.Errorf("iterate usage facts: %w", err)
	}
	return result, nil
}

func usageMeasureTargets(measures *UsageMeasures) []any {
	return append(scanTargets(&measures.UsageTotals),
		&measures.CostNanos, &measures.PricedRequests, &measures.CostedRequests,
		&measures.Accounting.CanonicalRequests, &measures.Accounting.UnresolvedRequests,
		&measures.Accounting.RawInputTokens, &measures.Accounting.RawOutputTokens, &measures.Accounting.RawTotalTokens)
}

// ClientKeyFilter narrows a read to one client key fingerprint, or to nothing
// when the fingerprint is empty.
func ClientKeyFilter(fingerprint string) map[UsageDimension][]string {
	if fingerprint == "" {
		return nil
	}
	return map[UsageDimension][]string{UsageDimensionKey: {fingerprint}}
}

// usageFilterClause renders the filters in a stable order, so one query always
// compiles to one statement.
func usageFilterClause(filters map[UsageDimension][]string) (string, []any) {
	dimensions := make([]string, 0, len(filters))
	for dimension, values := range filters {
		if len(values) > 0 {
			dimensions = append(dimensions, string(dimension))
		}
	}
	sort.Strings(dimensions)
	var clause strings.Builder
	var args []any
	for _, name := range dimensions {
		values := filters[UsageDimension(name)]
		clause.WriteString(" AND " + usageDimensionExpressions[UsageDimension(name)] + " IN (" +
			strings.TrimSuffix(strings.Repeat("?, ", len(values)), ", ") + ")")
		for _, value := range values {
			args = append(args, value)
		}
	}
	return clause.String(), args
}

func buildUsageFactStatement(plan usageFactPlan, query UsageFactQuery, grid *calendarGrid) (string, []any) {
	aligned := func(column string) string {
		if grid != nil {
			return grid.bucket(column)
		}
		if plan.bucketMS == 0 {
			return "0"
		}
		return fmt.Sprintf("(%s / %d) * %d", column, plan.bucketMS, plan.bucketMS)
	}
	keyColumns := make([]string, 0, len(query.Dimensions))
	keyNames := make([]string, 0, len(query.Dimensions))
	for index, dimension := range query.Dimensions {
		name := fmt.Sprintf("k%d", index)
		keyColumns = append(keyColumns, usageDimensionExpressions[dimension]+" AS "+name)
		keyNames = append(keyNames, name)
	}
	keySelect := ""
	if len(keyColumns) > 0 {
		keySelect = strings.Join(keyColumns, ", ") + ", "
	}
	filterClause, filterArgs := usageFilterClause(query.Filters)
	withFilters := func(args ...any) []any { return append(args, filterArgs...) }

	var parts []string
	var args []any
	factArm := func(table string, fromMS, toMS int64) {
		if fromMS >= toMS {
			return
		}
		parts = append(parts, `
			SELECT 1 AS from_facts, `+keySelect+aligned("bucket_start_ms")+` AS aligned, `+strings.Join(usageFactMeasures, ", ")+`
			FROM `+table+`
			WHERE instance_id = ? AND bucket_start_ms >= ? AND bucket_start_ms < ?`+filterClause)
		args = append(args, withFilters(query.InstanceID, fromMS, toMS)...)
	}
	// Each arm over usage_events names its index. The planner cannot know that the
	// records past the checkpoint are a handful while the window may span years,
	// and the wrong choice turns the dashboard's five-second poll into a scan of
	// every retained record.
	eventArm := func(index, predicate string, predicateArgs ...any) {
		parts = append(parts, `
			SELECT 0 AS from_facts, `+keySelect+aligned("timestamp_ms")+` AS aligned, `+usageEventMeasures+`
			FROM usage_events INDEXED BY `+index+`
			WHERE instance_id = ? AND `+predicate+filterClause)
		args = append(args, withFilters(append([]any{query.InstanceID}, predicateArgs...)...)...)
	}
	const checkpoint = `(SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = '` + CheckpointFacts + `')`

	if plan.fineFrom < plan.fineTo && plan.localFrom < plan.localTo {
		factArm(usageFactsFineTable, plan.fineFrom, plan.localFrom)
		factArm(usageFactsFineTable, plan.localTo, plan.fineTo)
		// The whole local days come from the local grain when it is built for this
		// zone and from the quarter hours otherwise. Both arms test the marker in
		// this statement, so a rebuild for another zone committing just before the
		// read cannot leave the days counted by neither.
		const marker = ` AND EXISTS (SELECT 1 FROM usage_aggregation_checkpoints WHERE name = ?)`
		parts = append(parts, `
			SELECT 1 AS from_facts, `+keySelect+grid.bucketFromWall("day_wall_ms")+` AS aligned, `+strings.Join(usageFactMeasures, ", ")+`
			FROM `+usageFactsLocalTable+`
			WHERE instance_id = ? AND zone = ? AND day_wall_ms >= ? AND day_wall_ms < ?`+filterClause+marker)
		args = append(args, withFilters(query.InstanceID, grid.location.String(), plan.wallFrom, plan.wallTo)...)
		args = append(args, plan.localMarker)
		parts = append(parts, `
			SELECT 1 AS from_facts, `+keySelect+aligned("bucket_start_ms")+` AS aligned, `+strings.Join(usageFactMeasures, ", ")+`
			FROM `+usageFactsFineTable+`
			WHERE instance_id = ? AND bucket_start_ms >= ? AND bucket_start_ms < ?`+filterClause+` AND NOT`+strings.TrimPrefix(marker, " AND"))
		args = append(args, withFilters(query.InstanceID, plan.localFrom, plan.localTo)...)
		args = append(args, plan.localMarker)
	} else if plan.fineFrom < plan.fineTo {
		factArm(usageFactsDailyTable, plan.dailyFrom, plan.dailyTo)
		factArm(usageFactsFineTable, plan.fineFrom, plan.dailyFrom)
		factArm(usageFactsFineTable, plan.dailyTo, plan.fineTo)
	}
	if plan.fineFrom < plan.fineTo {
		// Folded records on the sub-bucket edges, which no whole fact bucket covers.
		if plan.fromMS < plan.fineFrom {
			eventArm("idx_usage_events_instance_time",
				`timestamp_ms >= ? AND timestamp_ms < ? AND id <= `+checkpoint, plan.fromMS, plan.fineFrom)
		}
		if plan.fineTo <= plan.toMS {
			eventArm("idx_usage_events_instance_time",
				`timestamp_ms >= ? AND timestamp_ms <= ? AND id <= `+checkpoint, plan.fineTo, plan.toMS)
		}
	} else {
		eventArm("idx_usage_events_instance_time",
			`timestamp_ms >= ? AND timestamp_ms <= ? AND id <= `+checkpoint, plan.fromMS, plan.toMS)
	}
	// Everything not folded yet, wherever in the window it falls.
	eventArm("idx_usage_events_instance_id",
		`id > `+checkpoint+` AND timestamp_ms >= ? AND timestamp_ms <= ?`, plan.fromMS, plan.toMS)

	sums := make([]string, 0, len(usageFactMeasures))
	for _, measure := range usageFactMeasures {
		sums = append(sums, "COALESCE(SUM("+measure+"), 0)")
	}
	groupColumns := strings.Join(append(append([]string{}, keyNames...), "aligned"), ", ")
	keyOutput := ""
	if len(keyNames) > 0 {
		keyOutput = strings.Join(keyNames, ", ") + ", "
	}
	statement := `
		SELECT ` + keyOutput + `aligned, ` + strings.Join(sums, ", ") + `,
		       COALESCE(SUM(CASE WHEN from_facts = 1 THEN requests ELSE 0 END), 0)
		FROM (` + strings.Join(parts, `
			UNION ALL`) + `
		)
		GROUP BY ` + groupColumns + `
		ORDER BY ` + strings.ReplaceAll(groupColumns, ", ", " ASC, ") + ` ASC`
	return statement, args
}

// AggregateUsageFacts folds request records beyond the checkpoint into both fact
// grains and returns how many records it absorbed.
//
// Both grains and the checkpoint move in one transaction. A crash leaves either
// all three as they were or all three advanced, so a record is never in one grain
// and missing from the other, and a repeated pass cannot count it twice.
func (r *Repository) AggregateUsageFacts(ctx context.Context, batchSize int) (int, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	if batchSize <= 0 {
		batchSize = 5000
	}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin usage fold: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var lastID int64
	err = tx.QueryRowContext(ctx, `
		SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = ?`, CheckpointFacts).Scan(&lastID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("read checkpoint inside usage fold: %w", err)
	}
	var highID sql.NullInt64
	var absorbed int
	err = tx.QueryRowContext(ctx, `
		SELECT MAX(id), COUNT(1) FROM (SELECT id FROM usage_events WHERE id > ? ORDER BY id ASC LIMIT ?)`,
		lastID, batchSize).Scan(&highID, &absorbed)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, fmt.Errorf("find usage fold high water: %w", err)
	}
	if !highID.Valid {
		return 0, nil
	}

	updates := make([]string, 0, len(usageFactMeasures))
	for _, measure := range usageFactMeasures {
		updates = append(updates, measure+" = "+measure+" + excluded."+measure)
	}
	for _, grain := range []struct {
		table    string
		bucketMS int64
	}{{usageFactsFineTable, QuarterHourBucketMS}, {usageFactsDailyTable, DayBucketMS}} {
		// INSERT..SELECT keeps the fold inside SQLite: the records never cross into Go.
		_, err = tx.ExecContext(ctx, `
			INSERT INTO `+grain.table+` (instance_id, bucket_start_ms, `+usageFactDimensions+`, `+strings.Join(usageFactMeasures, ", ")+`)
			SELECT instance_id, (timestamp_ms / ?1) * ?1, api_group_key, model, COALESCE(model_alias, ''),
			       auth_index, provider, auth_type,
			       COUNT(1), SUM(failed), SUM(input_tokens), SUM(output_tokens), SUM(reasoning_tokens),
			       SUM(cached_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(total_tokens),
			       SUM(latency_ms), SUM(COALESCE(ttft_ms, 0)), SUM(ttft_ms IS NOT NULL),
			       SUM(COALESCE(cost_nanos, 0)), SUM(pricing_status = 'priced'), SUM(cost_nanos IS NOT NULL),
		       SUM(COALESCE(json_extract(token_accounting, '$.status'), '') = 'complete'),
		       SUM(token_accounting IS NOT NULL AND json_extract(token_accounting, '$.status') <> 'complete'),
		       SUM(COALESCE(json_extract(token_accounting, '$.raw_tokens.input_tokens'), 0)),
		       SUM(COALESCE(json_extract(token_accounting, '$.raw_tokens.output_tokens'), 0)),
		       SUM(COALESCE(json_extract(token_accounting, '$.raw_tokens.total_tokens'), 0))
			FROM usage_events
			WHERE id > ?2 AND id <= ?3
			GROUP BY instance_id, (timestamp_ms / ?1) * ?1, api_group_key, model, COALESCE(model_alias, ''),
			         auth_index, provider, auth_type
			ON CONFLICT DO UPDATE SET `+strings.Join(updates, ", "),
			grain.bucketMS, lastID, highID.Int64)
		if err != nil {
			return 0, fmt.Errorf("fold usage into %s: %w", grain.table, err)
		}
	}

	if err := foldLocalUsageFacts(ctx, tx, lastID, highID.Int64); err != nil {
		return 0, err
	}

	nowMS := time.Now().UnixMilli()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO usage_aggregation_checkpoints (name, last_usage_event_id, stats_updated_at_ms, created_at_ms, updated_at_ms)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			last_usage_event_id = MAX(excluded.last_usage_event_id, usage_aggregation_checkpoints.last_usage_event_id),
			stats_updated_at_ms = excluded.stats_updated_at_ms,
			updated_at_ms = excluded.updated_at_ms`,
		CheckpointFacts, highID.Int64, nowMS, nowMS, nowMS); err != nil {
		return 0, fmt.Errorf("advance usage fold checkpoint: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit usage fold: %w", err)
	}
	return absorbed, nil
}

// localFactsSelect renders the grouped SELECT that turns rows of a source with an
// instant column into local-day rows, with the zone's offsets over [fromMS, toMS].
func localFactsSelect(location *time.Location, column string, fromMS, toMS int64) (string, error) {
	grid, err := compileCalendar(UsageCalendar{Location: location, Unit: UsageCalendarDay}, fromMS, toMS)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("((%s / %d) * %d)", grid.wallClock(column), DayBucketMS, DayBucketMS), nil
}

// builtLocalZone names the zone the local grain is complete for, or nil.
func builtLocalZone(ctx context.Context, querier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}) (*time.Location, error) {
	var name string
	err := querier.QueryRowContext(ctx, `
		SELECT name FROM usage_aggregation_checkpoints WHERE name LIKE ? ORDER BY name LIMIT 1`,
		localFactsMarkerPrefix+"%").Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read local usage grain: %w", err)
	}
	location, err := time.LoadLocation(strings.TrimPrefix(name, localFactsMarkerPrefix))
	if err != nil {
		return nil, fmt.Errorf("%w %q: %v", errUnknownLocalGrainZone, name, err)
	}
	return location, nil
}

// foldLocalUsageFacts adds one fold batch to the local grain, inside the fold's
// own transaction, when the grain is built. A grain that is not built is left
// alone: the rebuild that creates it reads the quarter hours, which already hold
// this batch by the time it runs.
func foldLocalUsageFacts(ctx context.Context, tx *sql.Tx, lastID, highID int64) error {
	location, err := builtLocalZone(ctx, tx)
	if errors.Is(err, errUnknownLocalGrainZone) {
		// Derived rows cannot be extended without their calendar. Drop their claim
		// so reads fall back to quarter hours and a later rebuild can replace them.
		if errClear := clearLocalUsageFacts(ctx, tx); errClear != nil {
			return errClear
		}
		return nil
	}
	if err != nil || location == nil {
		return err
	}
	var fromMS, toMS int64
	if err := tx.QueryRowContext(ctx, `
		SELECT MIN(timestamp_ms), MAX(timestamp_ms) FROM usage_events WHERE id > ? AND id <= ?`,
		lastID, highID).Scan(&fromMS, &toMS); err != nil {
		return fmt.Errorf("bound local usage fold: %w", err)
	}
	day, err := localFactsSelect(location, "timestamp_ms", fromMS, toMS)
	if err != nil {
		return err
	}
	updates := make([]string, 0, len(usageFactMeasures))
	for _, measure := range usageFactMeasures {
		updates = append(updates, measure+" = "+measure+" + excluded."+measure)
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO `+usageFactsLocalTable+` (instance_id, zone, day_wall_ms, `+usageFactDimensions+`, `+strings.Join(usageFactMeasures, ", ")+`)
		SELECT instance_id, ?1, `+day+`, api_group_key, model, COALESCE(model_alias, ''),
		       auth_index, provider, auth_type,
		       COUNT(1), SUM(failed), SUM(input_tokens), SUM(output_tokens), SUM(reasoning_tokens),
		       SUM(cached_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(total_tokens),
		       SUM(latency_ms), SUM(COALESCE(ttft_ms, 0)), SUM(ttft_ms IS NOT NULL),
		       SUM(COALESCE(cost_nanos, 0)), SUM(pricing_status = 'priced'), SUM(cost_nanos IS NOT NULL),
		       SUM(COALESCE(json_extract(token_accounting, '$.status'), '') = 'complete'),
		       SUM(token_accounting IS NOT NULL AND json_extract(token_accounting, '$.status') <> 'complete'),
		       SUM(COALESCE(json_extract(token_accounting, '$.raw_tokens.input_tokens'), 0)),
		       SUM(COALESCE(json_extract(token_accounting, '$.raw_tokens.output_tokens'), 0)),
		       SUM(COALESCE(json_extract(token_accounting, '$.raw_tokens.total_tokens'), 0))
		FROM usage_events
		WHERE id > ?2 AND id <= ?3
		GROUP BY instance_id, `+day+`, api_group_key, model, COALESCE(model_alias, ''), auth_index, provider, auth_type
		ON CONFLICT DO UPDATE SET `+strings.Join(updates, ", "),
		location.String(), lastID, highID)
	if err != nil {
		return fmt.Errorf("fold usage into %s: %w", usageFactsLocalTable, err)
	}
	return nil
}

// clearLocalUsageFacts removes the derived rows and every zone marker together;
// callers run it inside the transaction that makes the next state authoritative.
func clearLocalUsageFacts(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM `+usageFactsLocalTable); err != nil {
		return fmt.Errorf("clear local usage grain: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM usage_aggregation_checkpoints WHERE name LIKE ?`, localFactsMarkerPrefix+"%"); err != nil {
		return fmt.Errorf("clear local usage marker: %w", err)
	}
	return nil
}

// EnsureLocalUsageFacts builds the local grain for the deployment's current time
// zone when it is built for another one, or not at all, and reports whether it did.
//
// The rebuild is one transaction over the quarter hours: they cover exactly the
// event ids the checkpoint covers, so the rebuilt grain does too, and a read never
// sees a half-built table because the marker row commits with it. A zone the
// process only knows as `Local` has no name to rebuild under; reads in it keep
// folding quarter hours.
func (r *Repository) EnsureLocalUsageFacts(ctx context.Context) (bool, error) {
	if r == nil || r.SQL() == nil {
		return false, errors.New("repository is not initialized")
	}
	if r.Timezone() == nil {
		return false, nil
	}
	location := r.Timezone().Location()
	if location == nil || location.String() == "Local" {
		return false, nil
	}
	built, err := builtLocalZone(ctx, r.SQL())
	if err != nil && !errors.Is(err, errUnknownLocalGrainZone) {
		return false, err
	}
	if built != nil && built.String() == location.String() {
		return false, nil
	}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin local usage rebuild: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := clearLocalUsageFacts(ctx, tx); err != nil {
		return false, err
	}
	var fromMS, toMS sql.NullInt64
	if err := tx.QueryRowContext(ctx, `SELECT MIN(bucket_start_ms), MAX(bucket_start_ms) FROM `+usageFactsFineTable).Scan(&fromMS, &toMS); err != nil {
		return false, fmt.Errorf("bound local usage rebuild: %w", err)
	}
	if fromMS.Valid {
		day, errSelect := localFactsSelect(location, "bucket_start_ms", fromMS.Int64, toMS.Int64)
		if errSelect != nil {
			return false, errSelect
		}
		sums := make([]string, 0, len(usageFactMeasures))
		for _, measure := range usageFactMeasures {
			sums = append(sums, "SUM("+measure+")")
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO `+usageFactsLocalTable+` (instance_id, zone, day_wall_ms, `+usageFactDimensions+`, `+strings.Join(usageFactMeasures, ", ")+`)
			SELECT instance_id, ?, `+day+`, `+usageFactDimensions+`, `+strings.Join(sums, ", ")+`
			FROM `+usageFactsFineTable+`
			GROUP BY instance_id, `+day+`, `+usageFactDimensions, location.String()); err != nil {
			return false, fmt.Errorf("rebuild local usage grain: %w", err)
		}
	}
	nowMS := time.Now().UnixMilli()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO usage_aggregation_checkpoints (name, last_usage_event_id, stats_updated_at_ms, created_at_ms, updated_at_ms)
		VALUES (?, COALESCE((SELECT last_usage_event_id FROM usage_aggregation_checkpoints WHERE name = ?), 0), ?, ?, ?)`,
		localFactsMarkerPrefix+location.String(), CheckpointFacts, nowMS, nowMS, nowMS); err != nil {
		return false, fmt.Errorf("mark local usage grain: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit local usage rebuild: %w", err)
	}
	return true, nil
}

// FirstUsageRecordMS reports the earliest instant the deployment has usage for,
// or nil when nothing has been captured.
//
// It reads the facts as well as the request records: once retention has rolled
// the early records away, the facts are the only thing that still remembers when
// usage began. The fact side is a bucket start, so the answer is exact to the
// quarter hour, which is as fine as anything read from the facts can be.
func (r *Repository) FirstUsageRecordMS(ctx context.Context, instanceID string) (*int64, error) {
	if r == nil || r.SQL() == nil {
		return nil, errors.New("repository is not initialized")
	}
	var value *int64
	err := r.SQL().QueryRowContext(ctx, `
		SELECT MIN(first_ms) FROM (
			SELECT MIN(bucket_start_ms) AS first_ms FROM `+usageFactsFineTable+` WHERE instance_id = ?1
			UNION ALL
			SELECT MIN(timestamp_ms) FROM usage_events WHERE instance_id = ?1
		)`, instanceID).Scan(&value)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("read first usage record: %w", err)
	}
	return value, nil
}

// LifecycleHorizonMS reports the instant before which a rolling policy's rows
// have been deleted, zero when it has deleted nothing.
func (r *Repository) LifecycleHorizonMS(ctx context.Context, policy string) (int64, error) {
	if r == nil || r.SQL() == nil {
		return 0, errors.New("repository is not initialized")
	}
	var horizonMS int64
	err := r.SQL().QueryRowContext(ctx,
		`SELECT horizon_ms FROM data_lifecycle_state WHERE policy = ?`, policy).Scan(&horizonMS)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read lifecycle horizon %s: %w", policy, err)
	}
	return horizonMS, nil
}
