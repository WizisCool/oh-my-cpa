import type { ProviderModelOptionField, ProviderModelOptions } from '../../types/providers';

/**
 * The editable form of a model entry's advanced settings.
 *
 * CPA reads a zero context length or thinking bound as "not stated", so the numeric fields are
 * null when empty rather than zero: the form cannot offer a zero that would mean something.
 */
export interface ModelOptionsDraft {
  displayName: string;
  maxContextLength: number | null;
  forceMapping: boolean;
  isCompat: boolean;
  supportConfigurationUpdate: boolean;
  inputModalities: string[];
  outputModalities: string[];
  useMaxCompletionTokens: boolean;
  thinkingMin: number | null;
  thinkingMax: number | null;
  thinkingZeroAllowed: boolean;
  thinkingDynamicAllowed: boolean;
}

export const EMPTY_MODEL_OPTIONS_DRAFT: ModelOptionsDraft = {
  displayName: '',
  maxContextLength: null,
  forceMapping: false,
  isCompat: false,
  supportConfigurationUpdate: false,
  inputModalities: [],
  outputModalities: [],
  useMaxCompletionTokens: false,
  thinkingMin: null,
  thinkingMax: null,
  thinkingZeroAllowed: false,
  thinkingDynamicAllowed: false,
};

/** The modalities the form suggests; CPA accepts any name, so the field also takes typed ones. */
export const MODALITY_SUGGESTIONS = ['text', 'image', 'audio', 'video', 'pdf'] as const;

export type ModelOptionsProblem = 'context_length' | 'thinking_bounds' | 'thinking_order';

export function readModelOptionsDraft(options: ProviderModelOptions | undefined): ModelOptionsDraft {
  if (!options) return EMPTY_MODEL_OPTIONS_DRAFT;
  return {
    displayName: options.display_name ?? '',
    maxContextLength: options.max_context_length || null,
    forceMapping: options.force_mapping ?? false,
    isCompat: options.is_compat ?? false,
    supportConfigurationUpdate: options.support_configuration_update ?? false,
    inputModalities: options.input_modalities ?? [],
    outputModalities: options.output_modalities ?? [],
    useMaxCompletionTokens: options.use_max_completion_tokens ?? false,
    thinkingMin: options.thinking_min || null,
    thinkingMax: options.thinking_max || null,
    thinkingZeroAllowed: options.thinking_zero_allowed ?? false,
    thinkingDynamicAllowed: options.thinking_dynamic_allowed ?? false,
  };
}

const isWholeNumber = (value: number | null) => value === null || (Number.isSafeInteger(value) && value > 0);

export function modelOptionsProblem(
  draft: ModelOptionsDraft,
  fields: readonly ProviderModelOptionField[],
): ModelOptionsProblem | null {
  if (fields.includes('max_context_length') && !isWholeNumber(draft.maxContextLength)) return 'context_length';
  if (!isWholeNumber(draft.thinkingMin) || !isWholeNumber(draft.thinkingMax)) return 'thinking_bounds';
  if (draft.thinkingMin !== null && draft.thinkingMax !== null && draft.thinkingMin > draft.thinkingMax) {
    return 'thinking_order';
  }
  return null;
}

/** Lowercased and deduplicated, which is how CPA compares modalities. */
export function normalizeModalities(modalities: string[]): string[] {
  const seen = new Set<string>();
  for (const modality of modalities) {
    for (const part of modality.split(/[,\s]+/)) {
      if (part) seen.add(part.toLowerCase());
    }
  }
  return [...seen];
}

/**
 * Builds the payload, which states the whole entry: a setting left out is cleared. Only the
 * settings the family has are named, because CPA refuses a configuration naming any other.
 */
export function buildModelOptions(
  draft: ModelOptionsDraft,
  fields: readonly ProviderModelOptionField[],
): ProviderModelOptions {
  const options: ProviderModelOptions = {};
  const displayName = draft.displayName.trim();
  if (displayName) options.display_name = displayName;
  if (draft.forceMapping) options.force_mapping = true;
  if (draft.thinkingMin !== null) options.thinking_min = draft.thinkingMin;
  if (draft.thinkingMax !== null) options.thinking_max = draft.thinkingMax;
  if (draft.thinkingZeroAllowed) options.thinking_zero_allowed = true;
  if (draft.thinkingDynamicAllowed) options.thinking_dynamic_allowed = true;
  if (fields.includes('max_context_length') && draft.maxContextLength !== null) {
    options.max_context_length = draft.maxContextLength;
  }
  if (fields.includes('is_compat') && draft.isCompat) options.is_compat = true;
  if (fields.includes('support_configuration_update') && draft.supportConfigurationUpdate) {
    options.support_configuration_update = true;
  }
  if (fields.includes('use_max_completion_tokens') && draft.useMaxCompletionTokens) {
    options.use_max_completion_tokens = true;
  }
  if (fields.includes('modalities')) {
    const inputModalities = normalizeModalities(draft.inputModalities);
    const outputModalities = normalizeModalities(draft.outputModalities);
    if (inputModalities.length > 0) options.input_modalities = inputModalities;
    if (outputModalities.length > 0) options.output_modalities = outputModalities;
  }
  return options;
}

/** How many advanced settings the entry states, for the group's count. */
export function countModelOptions(draft: ModelOptionsDraft, fields: readonly ProviderModelOptionField[]): number {
  return Object.keys(buildModelOptions(draft, fields)).length;
}
