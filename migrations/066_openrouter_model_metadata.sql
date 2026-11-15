-- Persist OpenRouter model specifications, modalities, supported parameters,
-- reasoning capabilities, knowledge cutoff, and Hugging Face identifiers beside
-- pricing so Model Square reads them from the runtime cache without a bundled
-- static snapshot.
ALTER TABLE pricing_upstream_catalog ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE pricing_upstream_catalog ADD COLUMN max_completion_tokens INTEGER NOT NULL DEFAULT 0 CHECK (max_completion_tokens >= 0);
ALTER TABLE pricing_upstream_catalog ADD COLUMN input_modalities_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(input_modalities_json) AND json_type(input_modalities_json) = 'array');
ALTER TABLE pricing_upstream_catalog ADD COLUMN output_modalities_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(output_modalities_json) AND json_type(output_modalities_json) = 'array');
ALTER TABLE pricing_upstream_catalog ADD COLUMN supported_parameters_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(supported_parameters_json) AND json_type(supported_parameters_json) = 'array');
ALTER TABLE pricing_upstream_catalog ADD COLUMN reasoning_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(reasoning_json) AND json_type(reasoning_json) = 'object');
ALTER TABLE pricing_upstream_catalog ADD COLUMN knowledge_cutoff TEXT NOT NULL DEFAULT '';
ALTER TABLE pricing_upstream_catalog ADD COLUMN hugging_face_id TEXT NOT NULL DEFAULT '';
