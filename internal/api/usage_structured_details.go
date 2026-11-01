package api

import "github.com/oh-my-cpa/oh-my-cpa/internal/usage"

// Ordinary HTTP responses deliberately enumerate every nested field; never
// serialize a stored blob or the ingestion model directly through this boundary.
type structuredUsageDetailsResponse struct {
	Tokens                *structuredTokenUsageResponse   `json:"tokens,omitempty"`
	CacheDetails          *cacheUsageDetailsResponse      `json:"cache_details,omitempty"`
	ToolUsageDetails      *toolUsageDetailsResponse       `json:"tool_usage_details,omitempty"`
	WebSearchRequests     *int64                          `json:"web_search_requests,omitempty"`
	ImageCount            *int64                          `json:"image_count,omitempty"`
	RequestedImageDetails *imageUsageDetailsResponse      `json:"requested_image_details,omitempty"`
	ImageDetails          *imageUsageDetailsResponse      `json:"image_details,omitempty"`
	MediaCounts           *mediaUsageCountsResponse       `json:"media_counts,omitempty"`
	Iterations            []iterationUsageDetailsResponse `json:"iterations,omitempty"`
	CostDetails           *upstreamCostDetailsResponse    `json:"cost_details,omitempty"`
	Speed                 string                          `json:"speed,omitempty"`
	InferenceGeo          string                          `json:"inference_geo,omitempty"`
	UpstreamServiceTier   string                          `json:"upstream_service_tier,omitempty"`
	IsPartial             bool                            `json:"is_partial,omitempty"`
}

type structuredTokenUsageResponse struct {
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

type cacheUsageDetailsResponse struct {
	Mode                    string           `json:"mode,omitempty"`
	TTL                     string           `json:"ttl,omitempty"`
	Retention               string           `json:"retention,omitempty"`
	Ephemeral5mInputTokens  *int64           `json:"ephemeral_5m_input_tokens,omitempty"`
	Ephemeral30mInputTokens *int64           `json:"ephemeral_30m_input_tokens,omitempty"`
	Ephemeral1hInputTokens  *int64           `json:"ephemeral_1h_input_tokens,omitempty"`
	Ephemeral12hInputTokens *int64           `json:"ephemeral_12h_input_tokens,omitempty"`
	ByTTL                   map[string]int64 `json:"by_ttl,omitempty"`
}

type toolUsageDetailsResponse struct {
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

type imageUsageDetailsResponse struct {
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

type mediaUsageCountsResponse struct {
	PromptMedia     *int64   `json:"prompt_media,omitempty"`
	CompletionMedia *int64   `json:"completion_media,omitempty"`
	PromptAudio     *int64   `json:"prompt_audio,omitempty"`
	AudioSeconds    *float64 `json:"audio_seconds,omitempty"`
}

type iterationUsageDetailsResponse struct {
	Type                     string                     `json:"type,omitempty"`
	Model                    string                     `json:"model,omitempty"`
	InputTokens              *int64                     `json:"input_tokens,omitempty"`
	OutputTokens             *int64                     `json:"output_tokens,omitempty"`
	ThinkingTokens           *int64                     `json:"thinking_tokens,omitempty"`
	ReasoningTokens          *int64                     `json:"reasoning_tokens,omitempty"`
	CacheReadInputTokens     *int64                     `json:"cache_read_input_tokens,omitempty"`
	CacheCreationInputTokens *int64                     `json:"cache_creation_input_tokens,omitempty"`
	CacheCreation5mTokens    *int64                     `json:"cache_creation_5m_tokens,omitempty"`
	CacheCreation1hTokens    *int64                     `json:"cache_creation_1h_tokens,omitempty"`
	CacheCreation            *cacheUsageDetailsResponse `json:"cache_creation,omitempty"`
}

type upstreamCostDetailsResponse struct {
	Cost                             *float64 `json:"cost,omitempty"`
	UpstreamInferenceCost            *float64 `json:"upstream_inference_cost,omitempty"`
	UpstreamInferencePromptCost      *float64 `json:"upstream_inference_prompt_cost,omitempty"`
	UpstreamInferenceCompletionsCost *float64 `json:"upstream_inference_completions_cost,omitempty"`
	CostInUSDTicks                   *int64   `json:"cost_in_usd_ticks,omitempty"`
	IsBYOK                           *bool    `json:"is_byok,omitempty"`
}

func projectStructuredUsage(source *usage.StructuredUsageDetails) *structuredUsageDetailsResponse {
	source = usage.SanitizeStructuredUsage(source)
	if source == nil {
		return nil
	}
	result := &structuredUsageDetailsResponse{
		Tokens:                projectStructuredTokenUsage(source.Tokens),
		CacheDetails:          projectCacheUsageDetails(source.CacheDetails),
		ToolUsageDetails:      projectToolUsageDetails(source.ToolUsageDetails),
		WebSearchRequests:     source.WebSearchRequests,
		ImageCount:            source.ImageCount,
		RequestedImageDetails: projectImageUsageDetails(source.RequestedImageDetails),
		ImageDetails:          projectImageUsageDetails(source.ImageDetails),
		MediaCounts:           projectMediaUsageCounts(source.MediaCounts),
		CostDetails:           projectUpstreamCostDetails(source.CostDetails),
		Speed:                 source.Speed,
		InferenceGeo:          source.InferenceGeo,
		UpstreamServiceTier:   source.UpstreamServiceTier,
		IsPartial:             source.IsPartial,
	}
	for index := range source.Iterations {
		result.Iterations = append(result.Iterations, *projectIterationUsageDetails(&source.Iterations[index]))
	}
	return result
}

func projectStructuredTokenUsage(source *usage.StructuredTokenUsage) *structuredTokenUsageResponse {
	if source == nil {
		return nil
	}
	result := &structuredTokenUsageResponse{
		CacheCreation5mTokens:    source.CacheCreation5mTokens,
		CacheCreation30mTokens:   source.CacheCreation30mTokens,
		CacheCreation1hTokens:    source.CacheCreation1hTokens,
		CacheCreation12hTokens:   source.CacheCreation12hTokens,
		TextInputTokens:          source.TextInputTokens,
		ImageInputTokens:         source.ImageInputTokens,
		AudioInputTokens:         source.AudioInputTokens,
		VideoInputTokens:         source.VideoInputTokens,
		FileInputTokens:          source.FileInputTokens,
		CachedTextTokens:         source.CachedTextTokens,
		TextOutputTokens:         source.TextOutputTokens,
		ImageOutputTokens:        source.ImageOutputTokens,
		AudioOutputTokens:        source.AudioOutputTokens,
		AcceptedPredictionTokens: source.AcceptedPredictionTokens,
		RejectedPredictionTokens: source.RejectedPredictionTokens,
	}
	return result
}

func projectCacheUsageDetails(source *usage.CacheUsageDetails) *cacheUsageDetailsResponse {
	if source == nil {
		return nil
	}
	result := &cacheUsageDetailsResponse{
		Mode:                    source.Mode,
		TTL:                     source.TTL,
		Retention:               source.Retention,
		Ephemeral5mInputTokens:  source.Ephemeral5mInputTokens,
		Ephemeral30mInputTokens: source.Ephemeral30mInputTokens,
		Ephemeral1hInputTokens:  source.Ephemeral1hInputTokens,
		Ephemeral12hInputTokens: source.Ephemeral12hInputTokens,
		ByTTL:                   source.ByTTL,
	}
	return result
}

func projectToolUsageDetails(source *usage.ToolUsageDetails) *toolUsageDetailsResponse {
	if source == nil {
		return nil
	}
	result := &toolUsageDetailsResponse{
		WebSearchCalls:         source.WebSearchCalls,
		WebSearchQueries:       source.WebSearchQueries,
		WebFetchCalls:          source.WebFetchCalls,
		NumSearchResults:       source.NumSearchResults,
		NumSourcesUsed:         source.NumSourcesUsed,
		NumServerSideToolsUsed: source.NumServerSideToolsUsed,
		ToolCallsRequested:     source.ToolCallsRequested,
		ToolCallsExecuted:      source.ToolCallsExecuted,
		XSearchCalls:           source.XSearchCalls,
		XPostsFetched:          source.XPostsFetched,
		XUsersFetched:          source.XUsersFetched,
		CodeExecutionCalls:     source.CodeExecutionCalls,
		FileSearchCalls:        source.FileSearchCalls,
		MCPCalls:               source.MCPCalls,
		DocumentSearchCalls:    source.DocumentSearchCalls,
		ImageGenerationCalls:   source.ImageGenerationCalls,
		Extra:                  source.Extra,
	}
	return result
}

func projectImageUsageDetails(source *usage.ImageUsageDetails) *imageUsageDetailsResponse {
	if source == nil {
		return nil
	}
	result := &imageUsageDetailsResponse{
		Size:           source.Size,
		Resolution:     source.Resolution,
		ImageSize:      source.ImageSize,
		AspectRatio:    source.AspectRatio,
		Quality:        source.Quality,
		Background:     source.Background,
		OutputFormat:   source.OutputFormat,
		ResponseFormat: source.ResponseFormat,
		MIMEType:       source.MIMEType,
		InputFidelity:  source.InputFidelity,
	}
	return result
}

func projectMediaUsageCounts(source *usage.MediaUsageCounts) *mediaUsageCountsResponse {
	if source == nil {
		return nil
	}
	result := &mediaUsageCountsResponse{
		PromptMedia:     source.PromptMedia,
		CompletionMedia: source.CompletionMedia,
		PromptAudio:     source.PromptAudio,
		AudioSeconds:    source.AudioSeconds,
	}
	return result
}

func projectIterationUsageDetails(source *usage.IterationUsageDetails) *iterationUsageDetailsResponse {
	if source == nil {
		return nil
	}
	result := &iterationUsageDetailsResponse{
		Type:                     source.Type,
		Model:                    source.Model,
		InputTokens:              source.InputTokens,
		OutputTokens:             source.OutputTokens,
		ThinkingTokens:           source.ThinkingTokens,
		ReasoningTokens:          source.ReasoningTokens,
		CacheReadInputTokens:     source.CacheReadInputTokens,
		CacheCreationInputTokens: source.CacheCreationInputTokens,
		CacheCreation5mTokens:    source.CacheCreation5mTokens,
		CacheCreation1hTokens:    source.CacheCreation1hTokens,
		CacheCreation:            projectCacheUsageDetails(source.CacheCreation),
	}
	return result
}

func projectUpstreamCostDetails(source *usage.UpstreamCostDetails) *upstreamCostDetailsResponse {
	if source == nil {
		return nil
	}
	result := &upstreamCostDetailsResponse{
		Cost:                             source.Cost,
		UpstreamInferenceCost:            source.UpstreamInferenceCost,
		UpstreamInferencePromptCost:      source.UpstreamInferencePromptCost,
		UpstreamInferenceCompletionsCost: source.UpstreamInferenceCompletionsCost,
		CostInUSDTicks:                   source.CostInUSDTicks,
		IsBYOK:                           source.IsBYOK,
	}
	return result
}
