package usage

import (
	"encoding/json"
	"math"
	"reflect"
	"slices"
)

// Structured usage is independent evidence, not another token partition or a
// price-book input. Limits bound retained evidence even when a vendor sends
// arbitrarily many iterations or named counters.
const (
	// Leave room for request metadata under the shared Agent/MCP result limit.
	MaxStructuredUsageBytes       = 16 << 10
	MaxStructuredUsageIterations  = 16
	MaxStructuredUsageStringRunes = 128
)

// StructuredUsageDetails owns the non-secret subset of CPA's published queue
// contract. Pointers preserve an observed zero (or false) versus no observation.
type StructuredUsageDetails struct {
	Tokens                *StructuredTokenUsage   `json:"tokens,omitempty"`
	CacheDetails          *CacheUsageDetails      `json:"cache_details,omitempty"`
	ToolUsageDetails      *ToolUsageDetails       `json:"tool_usage_details,omitempty"`
	WebSearchRequests     *int64                  `json:"web_search_requests,omitempty"`
	ImageCount            *int64                  `json:"image_count,omitempty"`
	RequestedImageDetails *ImageUsageDetails      `json:"requested_image_details,omitempty"`
	ImageDetails          *ImageUsageDetails      `json:"image_details,omitempty"`
	MediaCounts           *MediaUsageCounts       `json:"media_counts,omitempty"`
	Iterations            []IterationUsageDetails `json:"iterations,omitempty"`
	CostDetails           *UpstreamCostDetails    `json:"cost_details,omitempty"`
	Speed                 string                  `json:"speed,omitempty"`
	InferenceGeo          string                  `json:"inference_geo,omitempty"`
	UpstreamServiceTier   string                  `json:"upstream_service_tier,omitempty"`
	IsPartial             bool                    `json:"is_partial,omitempty"`
}

type StructuredTokenUsage struct {
	CacheCreation5mTokens    *int64 `json:"cache_creation_5m_tokens,omitempty"`
	CacheCreation30mTokens   *int64 `json:"cache_creation_30m_tokens,omitempty"`
	CacheCreation1hTokens    *int64 `json:"cache_creation_1h_tokens,omitempty"`
	CacheCreation12hTokens   *int64 `json:"cache_creation_12h_tokens,omitempty"`
	TextInputTokens          *int64 `json:"text_input_tokens,omitempty"`
	ImageInputTokens         *int64 `json:"image_input_tokens,omitempty"`
	AudioInputTokens         *int64 `json:"audio_input_tokens,omitempty"`
	VideoInputTokens         *int64 `json:"video_input_tokens,omitempty"`
	FileInputTokens          *int64 `json:"file_input_tokens,omitempty"`
	CachedTextTokens         *int64 `json:"cached_text_tokens,omitempty"`
	TextOutputTokens         *int64 `json:"text_output_tokens,omitempty"`
	ImageOutputTokens        *int64 `json:"image_output_tokens,omitempty"`
	AudioOutputTokens        *int64 `json:"audio_output_tokens,omitempty"`
	AcceptedPredictionTokens *int64 `json:"accepted_prediction_tokens,omitempty"`
	RejectedPredictionTokens *int64 `json:"rejected_prediction_tokens,omitempty"`
}

type CacheUsageDetails struct {
	Mode                    string           `json:"mode,omitempty"`
	TTL                     string           `json:"ttl,omitempty"`
	Retention               string           `json:"retention,omitempty"`
	Ephemeral5mInputTokens  *int64           `json:"ephemeral_5m_input_tokens,omitempty"`
	Ephemeral30mInputTokens *int64           `json:"ephemeral_30m_input_tokens,omitempty"`
	Ephemeral1hInputTokens  *int64           `json:"ephemeral_1h_input_tokens,omitempty"`
	Ephemeral12hInputTokens *int64           `json:"ephemeral_12h_input_tokens,omitempty"`
	ByTTL                   map[string]int64 `json:"by_ttl,omitempty"`
}

type ToolUsageDetails struct {
	WebSearchCalls         *int64           `json:"web_search_calls,omitempty"`
	WebSearchQueries       *int64           `json:"web_search_queries,omitempty"`
	WebFetchCalls          *int64           `json:"web_fetch_calls,omitempty"`
	NumSearchResults       *int64           `json:"num_search_results,omitempty"`
	NumSourcesUsed         *int64           `json:"num_sources_used,omitempty"`
	NumServerSideToolsUsed *int64           `json:"num_server_side_tools_used,omitempty"`
	ToolCallsRequested     *int64           `json:"tool_calls_requested,omitempty"`
	ToolCallsExecuted      *int64           `json:"tool_calls_executed,omitempty"`
	XSearchCalls           *int64           `json:"x_search_calls,omitempty"`
	XPostsFetched          *int64           `json:"x_posts_fetched,omitempty"`
	XUsersFetched          *int64           `json:"x_users_fetched,omitempty"`
	CodeExecutionCalls     *int64           `json:"code_execution_calls,omitempty"`
	FileSearchCalls        *int64           `json:"file_search_calls,omitempty"`
	MCPCalls               *int64           `json:"mcp_calls,omitempty"`
	DocumentSearchCalls    *int64           `json:"document_search_calls,omitempty"`
	ImageGenerationCalls   *int64           `json:"image_generation_calls,omitempty"`
	Extra                  map[string]int64 `json:"extra,omitempty"`
}

type ImageUsageDetails struct {
	Size           string `json:"size,omitempty"`
	Resolution     string `json:"resolution,omitempty"`
	ImageSize      string `json:"image_size,omitempty"`
	AspectRatio    string `json:"aspect_ratio,omitempty"`
	Quality        string `json:"quality,omitempty"`
	Background     string `json:"background,omitempty"`
	OutputFormat   string `json:"output_format,omitempty"`
	ResponseFormat string `json:"response_format,omitempty"`
	MIMEType       string `json:"mime_type,omitempty"`
	InputFidelity  string `json:"input_fidelity,omitempty"`
}

type MediaUsageCounts struct {
	PromptMedia     *int64   `json:"prompt_media,omitempty"`
	CompletionMedia *int64   `json:"completion_media,omitempty"`
	PromptAudio     *int64   `json:"prompt_audio,omitempty"`
	AudioSeconds    *float64 `json:"audio_seconds,omitempty"`
}

type IterationUsageDetails struct {
	Type                     string             `json:"type,omitempty"`
	Model                    string             `json:"model,omitempty"`
	InputTokens              *int64             `json:"input_tokens,omitempty"`
	OutputTokens             *int64             `json:"output_tokens,omitempty"`
	ThinkingTokens           *int64             `json:"thinking_tokens,omitempty"`
	ReasoningTokens          *int64             `json:"reasoning_tokens,omitempty"`
	CacheReadInputTokens     *int64             `json:"cache_read_input_tokens,omitempty"`
	CacheCreationInputTokens *int64             `json:"cache_creation_input_tokens,omitempty"`
	CacheCreation5mTokens    *int64             `json:"cache_creation_5m_tokens,omitempty"`
	CacheCreation1hTokens    *int64             `json:"cache_creation_1h_tokens,omitempty"`
	CacheCreation            *CacheUsageDetails `json:"cache_creation,omitempty"`
}

type UpstreamCostDetails struct {
	Cost                             *float64 `json:"cost,omitempty"`
	UpstreamInferenceCost            *float64 `json:"upstream_inference_cost,omitempty"`
	UpstreamInferencePromptCost      *float64 `json:"upstream_inference_prompt_cost,omitempty"`
	UpstreamInferenceCompletionsCost *float64 `json:"upstream_inference_completions_cost,omitempty"`
	CostInUSDTicks                   *int64   `json:"cost_in_usd_ticks,omitempty"`
	IsBYOK                           *bool    `json:"is_byok,omitempty"`
}

func decodeStructuredUsage(raw []byte) *StructuredUsageDetails {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return &StructuredUsageDetails{IsPartial: true}
	}
	partial := false
	text := func(key string) string {
		if value := decodeUsageField[string](fields[key], &partial); value != nil {
			return *value
		}
		return ""
	}
	details := StructuredUsageDetails{
		Tokens:                decodeUsageField[StructuredTokenUsage](fields["tokens"], &partial),
		CacheDetails:          decodeUsageField[CacheUsageDetails](fields["cache_details"], &partial),
		ToolUsageDetails:      decodeUsageField[ToolUsageDetails](fields["tool_usage_details"], &partial),
		WebSearchRequests:     decodeUsageField[int64](fields["web_search_requests"], &partial),
		ImageCount:            decodeUsageField[int64](fields["image_count"], &partial),
		RequestedImageDetails: decodeUsageField[ImageUsageDetails](fields["requested_image_details"], &partial),
		ImageDetails:          decodeUsageField[ImageUsageDetails](fields["image_details"], &partial),
		MediaCounts:           decodeUsageField[MediaUsageCounts](fields["media_counts"], &partial),
		CostDetails:           decodeUsageField[UpstreamCostDetails](fields["cost_details"], &partial),
		Speed:                 text("speed"), InferenceGeo: text("inference_geo"), UpstreamServiceTier: text("upstream_service_tier"),
	}
	if iterations := decodeUsageField[[]json.RawMessage](fields["iterations"], &partial); iterations != nil {
		records := *iterations
		if len(records) > MaxStructuredUsageIterations {
			records = records[:MaxStructuredUsageIterations]
			partial = true
		}
		for _, rawIteration := range records {
			iteration := decodeUsageField[IterationUsageDetails](rawIteration, &partial)
			if iteration == nil {
				// Preserve iteration positions without representing rejected counts as zeros.
				details.Iterations = append(details.Iterations, IterationUsageDetails{})
			} else {
				details.Iterations = append(details.Iterations, *iteration)
			}
		}
	}
	details.IsPartial = partial // Capture metadata is owned by OMC, never upstream.
	return SanitizeStructuredUsage(&details)
}

func decodeUsageField[T any](raw json.RawMessage, partial *bool) *T {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		// Reject only this optional group, not the request or its other observations.
		*partial = true
		return nil
	}
	return &value
}

// SanitizeStructuredUsage returns an independent, bounded projection. Apply it at
// the storage and read boundaries too, including callers that construct Events.
func SanitizeStructuredUsage(source *StructuredUsageDetails) *StructuredUsageDetails {
	if source == nil {
		return nil
	}
	details := *source
	partial := &details.IsPartial
	sanitizeUsageStrings(partial, &details.Speed, &details.InferenceGeo, &details.UpstreamServiceTier)
	sanitizeUsageCounts(partial, &details.WebSearchRequests, &details.ImageCount)
	if source.Tokens != nil {
		value := *source.Tokens
		sanitizeUsageCounts(partial, &value.CacheCreation5mTokens, &value.CacheCreation30mTokens, &value.CacheCreation1hTokens, &value.CacheCreation12hTokens, &value.TextInputTokens, &value.ImageInputTokens, &value.AudioInputTokens, &value.VideoInputTokens, &value.FileInputTokens, &value.CachedTextTokens, &value.TextOutputTokens, &value.ImageOutputTokens, &value.AudioOutputTokens, &value.AcceptedPredictionTokens, &value.RejectedPredictionTokens)
		details.Tokens = nonEmptyUsage(&value)
	}
	details.CacheDetails = sanitizeCacheUsage(source.CacheDetails, partial)
	if source.ToolUsageDetails != nil {
		value := *source.ToolUsageDetails
		sanitizeUsageCounts(partial, &value.WebSearchCalls, &value.WebSearchQueries, &value.WebFetchCalls, &value.NumSearchResults, &value.NumSourcesUsed, &value.NumServerSideToolsUsed, &value.ToolCallsRequested, &value.ToolCallsExecuted, &value.XSearchCalls, &value.XPostsFetched, &value.XUsersFetched, &value.CodeExecutionCalls, &value.FileSearchCalls, &value.MCPCalls, &value.DocumentSearchCalls, &value.ImageGenerationCalls)
		value.Extra = sanitizeUsageMap(value.Extra, partial,
			"image_search_calls", "tool_use_prompt_tokens", "google_maps_chunks")
		details.ToolUsageDetails = nonEmptyUsage(&value)
	}
	details.RequestedImageDetails = sanitizeImageUsage(source.RequestedImageDetails, partial)
	details.ImageDetails = sanitizeImageUsage(source.ImageDetails, partial)
	if source.MediaCounts != nil {
		value := *source.MediaCounts
		sanitizeUsageCounts(partial, &value.PromptMedia, &value.CompletionMedia, &value.PromptAudio)
		if value.AudioSeconds != nil && *value.AudioSeconds < 0 {
			value.AudioSeconds = nil
			*partial = true
		}
		sanitizeUsageNumbers(partial, &value.AudioSeconds)
		details.MediaCounts = nonEmptyUsage(&value)
	}
	if source.CostDetails != nil {
		value := *source.CostDetails
		sanitizeUsageNumbers(partial, &value.Cost, &value.UpstreamInferenceCost, &value.UpstreamInferencePromptCost, &value.UpstreamInferenceCompletionsCost)
		// Monetary values are upstream evidence, not nonnegative usage counts.
		// Preserve their sign, including credits, without feeding them to pricing.
		if value.CostInUSDTicks != nil {
			observed := *value.CostInUSDTicks
			value.CostInUSDTicks = &observed
		}
		if value.IsBYOK != nil {
			observed := *value.IsBYOK
			value.IsBYOK = &observed
		}
		details.CostDetails = nonEmptyUsage(&value)
	}
	details.Iterations = nil
	iterations := source.Iterations
	if len(iterations) > MaxStructuredUsageIterations {
		iterations = iterations[:MaxStructuredUsageIterations]
		*partial = true
	}
	for _, original := range iterations {
		value := original
		sanitizeUsageStrings(partial, &value.Type, &value.Model)
		sanitizeUsageCounts(partial, &value.InputTokens, &value.OutputTokens, &value.ThinkingTokens, &value.ReasoningTokens, &value.CacheReadInputTokens, &value.CacheCreationInputTokens, &value.CacheCreation5mTokens, &value.CacheCreation1hTokens)
		value.CacheCreation = sanitizeCacheUsage(value.CacheCreation, partial)
		// Keep empty iterations in place: dropping one would renumber later rounds.
		details.Iterations = append(details.Iterations, value)
	}
	for {
		encoded, err := json.Marshal(&details)
		if err == nil && len(encoded) <= MaxStructuredUsageBytes {
			return nonEmptyUsage(&details)
		}
		details.IsPartial = true
		if err != nil || len(details.Iterations) == 0 {
			// Refuse oversized optional evidence explicitly, never the request's
			// identity, token partition or locked price-book amount.
			return &StructuredUsageDetails{IsPartial: true}
		}
		details.Iterations = details.Iterations[:len(details.Iterations)-1]
	}
}

func sanitizeCacheUsage(source *CacheUsageDetails, partial *bool) *CacheUsageDetails {
	if source == nil {
		return nil
	}
	value := *source
	sanitizeUsageStrings(partial, &value.Mode, &value.TTL, &value.Retention)
	sanitizeUsageCounts(partial, &value.Ephemeral5mInputTokens, &value.Ephemeral30mInputTokens, &value.Ephemeral1hInputTokens, &value.Ephemeral12hInputTokens)
	value.ByTTL = sanitizeUsageMap(value.ByTTL, partial, "5m", "30m", "1h", "12h")
	return nonEmptyUsage(&value)
}

func sanitizeImageUsage(source *ImageUsageDetails, partial *bool) *ImageUsageDetails {
	if source == nil {
		return nil
	}
	value := *source
	sanitizeUsageStrings(partial, &value.Size, &value.Resolution, &value.ImageSize, &value.AspectRatio, &value.Quality, &value.Background, &value.OutputFormat, &value.ResponseFormat, &value.MIMEType, &value.InputFidelity)
	return nonEmptyUsage(&value)
}

// Pointer presence, not its numeric value, determines whether evidence exists.
func nonEmptyUsage[T any](value *T) *T {
	if reflect.ValueOf(*value).IsZero() {
		return nil
	}
	return value
}

func sanitizeUsageStrings(partial *bool, values ...*string) {
	for _, value := range values {
		original := *value
		*value = boundedSafe(original, MaxStructuredUsageStringRunes)
		if *value != original {
			*partial = true
		}
	}
}

func sanitizeUsageCounts(partial *bool, values ...**int64) {
	for _, value := range values {
		if *value != nil && **value < 0 {
			*value = nil
			*partial = true
		} else if *value != nil {
			observed := **value
			*value = &observed
		}
	}
}

func sanitizeUsageNumbers(partial *bool, values ...**float64) {
	for _, value := range values {
		if *value != nil && (math.IsNaN(**value) || math.IsInf(**value, 0)) {
			*value = nil
			*partial = true
		} else if *value != nil {
			observed := **value
			*value = &observed
		}
	}
}

// Map names are part of the retained evidence contract, not a free-text export
// path. These vocabularies come from CPA's published usage parsers; new names
// remain unknown until explicitly supported, and rejection marks the capture partial.
func sanitizeUsageMap(source map[string]int64, partial *bool, names ...string) map[string]int64 {
	result := make(map[string]int64)
	for key, value := range source {
		if !slices.Contains(names, key) || value < 0 {
			*partial = true
			continue
		}
		result[key] = value
	}
	if len(result) == 0 {
		return nil
	}
	return result
}
