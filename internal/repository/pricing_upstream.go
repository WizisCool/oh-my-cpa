package repository

import (
	"context"
	"errors"
	"fmt"

	"github.com/oh-my-cpa/oh-my-cpa/internal/pricing"
)

// ReplaceUpstreamCatalog stores a complete OpenRouter download atomically. An
// empty list is refused: it can only be a failed read, and publishing it would
// empty the console's model picker.
func (r *Repository) ReplaceUpstreamCatalog(ctx context.Context, models []pricing.UpstreamModel) error {
	if err := r.requireUpstreamMetadataSchema(ctx); err != nil {
		return err
	}
	if len(models) == 0 {
		return errors.New("refusing to store an empty OpenRouter price list")
	}
	tx, err := r.SQL().BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin upstream catalog replace: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM pricing_upstream_catalog`); err != nil {
		return fmt.Errorf("clear upstream catalog: %w", err)
	}
	statement, err := tx.PrepareContext(ctx, `INSERT INTO pricing_upstream_catalog (
		id, canonical_slug, name, author, description, context_length, max_completion_tokens,
		input_modalities_json, output_modalities_json, supported_parameters_json, reasoning_json,
		knowledge_cutoff, hugging_face_id, prompt_price_per_1m, completion_price_per_1m,
		cache_read_price_per_1m, cache_write_price_per_1m, tiers_json
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
	if err != nil {
		return fmt.Errorf("prepare upstream catalog insert: %w", err)
	}
	defer statement.Close()
	for _, model := range models {
		tiers, err := pricing.EncodeTiers(model.Tiers)
		if err != nil {
			return err
		}
		inputModalities, err := pricing.EncodeStringList(model.InputModalities)
		if err != nil {
			return fmt.Errorf("upstream model %q input modalities: %w", model.ID, err)
		}
		outputModalities, err := pricing.EncodeStringList(model.OutputModalities)
		if err != nil {
			return fmt.Errorf("upstream model %q output modalities: %w", model.ID, err)
		}
		supportedParameters, err := pricing.EncodeStringList(model.SupportedParameters)
		if err != nil {
			return fmt.Errorf("upstream model %q supported parameters: %w", model.ID, err)
		}
		reasoningJSON, err := pricing.EncodeReasoning(model.Reasoning)
		if err != nil {
			return fmt.Errorf("upstream model %q reasoning: %w", model.ID, err)
		}
		if _, err := statement.ExecContext(ctx,
			model.ID, model.CanonicalSlug, model.Name, model.Author, model.Description,
			max(model.ContextLength, 0), max(model.MaxCompletionTokens, 0),
			inputModalities, outputModalities, supportedParameters, reasoningJSON,
			model.KnowledgeCutoff, pricing.SanitizeHuggingFaceID(model.HuggingFaceID),
			model.PromptPricePer1M, model.CompletionPer1M, model.CacheReadPer1M, model.CacheWritePer1M, tiers,
		); err != nil {
			return fmt.Errorf("store upstream model %q: %w", model.ID, err)
		}
	}
	return tx.Commit()
}

// ListUpstreamCatalog returns the stored OpenRouter snapshot ordered by id.
func (r *Repository) ListUpstreamCatalog(ctx context.Context) ([]pricing.UpstreamModel, error) {
	if err := r.requireUpstreamMetadataSchema(ctx); err != nil {
		return nil, err
	}
	rows, err := r.SQL().QueryContext(ctx, `SELECT id, canonical_slug, name, author, description,
 context_length, max_completion_tokens, input_modalities_json, output_modalities_json,
 supported_parameters_json, reasoning_json, knowledge_cutoff, hugging_face_id,
 prompt_price_per_1m, completion_price_per_1m, cache_read_price_per_1m, cache_write_price_per_1m, tiers_json
 FROM pricing_upstream_catalog ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("list upstream catalog: %w", err)
	}
	defer rows.Close()
	result := make([]pricing.UpstreamModel, 0, 512)
	for rows.Next() {
		var model pricing.UpstreamModel
		var inputModalities, outputModalities, supportedParameters, reasoningJSON, tiers string
		if err := rows.Scan(
			&model.ID, &model.CanonicalSlug, &model.Name, &model.Author, &model.Description,
			&model.ContextLength, &model.MaxCompletionTokens,
			&inputModalities, &outputModalities, &supportedParameters, &reasoningJSON,
			&model.KnowledgeCutoff, &model.HuggingFaceID,
			&model.PromptPricePer1M, &model.CompletionPer1M, &model.CacheReadPer1M, &model.CacheWritePer1M, &tiers,
		); err != nil {
			return nil, fmt.Errorf("scan upstream model: %w", err)
		}
		if model.InputModalities, err = pricing.DecodeStringList(inputModalities); err != nil {
			return nil, fmt.Errorf("upstream model %q input modalities: %w", model.ID, err)
		}
		if model.OutputModalities, err = pricing.DecodeStringList(outputModalities); err != nil {
			return nil, fmt.Errorf("upstream model %q output modalities: %w", model.ID, err)
		}
		if model.SupportedParameters, err = pricing.DecodeStringList(supportedParameters); err != nil {
			return nil, fmt.Errorf("upstream model %q supported parameters: %w", model.ID, err)
		}
		if model.Reasoning, err = pricing.DecodeReasoning(reasoningJSON); err != nil {
			return nil, fmt.Errorf("upstream model %q reasoning: %w", model.ID, err)
		}
		model.HuggingFaceID = pricing.SanitizeHuggingFaceID(model.HuggingFaceID)
		if model.Tiers, err = pricing.DecodeTiers(tiers); err != nil {
			return nil, fmt.Errorf("upstream model %q: %w", model.ID, err)
		}
		result = append(result, model)
	}
	return result, rows.Err()
}
