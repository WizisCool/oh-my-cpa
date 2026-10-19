import type { ManagementAuthFile, ManagementAuthFileSafeFields } from '../../types/managementAuthFile';

/**
 * A Vertex service account's OpenAPI overrides. CPA routes a partner or open model through
 * Vertex's OpenAPI endpoint when it detects one by name; `openapi` overrides that detection, so
 * "inherit" (no key) and an explicit "off" are different states.
 */
export type VertexOpenAPIMode = 'inherit' | 'on' | 'off';

export interface VertexOpenAPIDraft {
  mode: VertexOpenAPIMode;
  location: string;
  /** Newline- or comma-separated model IDs, as typed. */
  models: string;
}

/** The server's bounds, mirrored so a draft is refused before it is sent. */
export const MAX_VERTEX_OPENAPI_MODELS = 256;
const MAX_VERTEX_OPENAPI_MODEL_LENGTH = 256;
const VERTEX_LOCATION = /^[a-z0-9-]{0,64}$/;

export function isVertexServiceAccount(file: Pick<ManagementAuthFile, 'provider' | 'type'>): boolean {
  return [file.provider, file.type].some((value) => value?.trim().toLowerCase() === 'vertex');
}

export function readVertexOpenAPIDraft(fields: ManagementAuthFileSafeFields | undefined): VertexOpenAPIDraft {
  let mode: VertexOpenAPIMode = 'inherit';
  if (fields?.openapi === true) mode = 'on';
  else if (fields?.openapi === false) mode = 'off';
  return { mode, location: fields?.openapi_location ?? '', models: (fields?.openapi_models ?? []).join('\n') };
}

/** Model IDs in typed order, trimmed and without case-insensitive repeats. */
export function parseVertexOpenAPIModels(text: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of text.split(/[\n,]/)) {
    const model = part.trim();
    const key = model.toLowerCase();
    if (!model || seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result;
}

export type VertexOpenAPIProblem = 'location' | 'models_too_many' | 'model_too_long';

export function vertexOpenAPIProblem(draft: VertexOpenAPIDraft): VertexOpenAPIProblem | null {
  if (!VERTEX_LOCATION.test(draft.location.trim())) return 'location';
  const models = parseVertexOpenAPIModels(draft.models);
  if (models.length > MAX_VERTEX_OPENAPI_MODELS) return 'models_too_many';
  if (models.some((model) => model.length > MAX_VERTEX_OPENAPI_MODEL_LENGTH)) return 'model_too_long';
  return null;
}

/**
 * The fields to patch: only what changed. Null returns a field to inheritance, which CPA reads
 * the same as an absent key, so clearing never leaves an empty override behind.
 */
export function buildVertexOpenAPIPatch(draft: VertexOpenAPIDraft, baseline: VertexOpenAPIDraft): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (draft.mode !== baseline.mode) patch.openapi = draft.mode === 'inherit' ? null : draft.mode === 'on';
  const location = draft.location.trim();
  if (location !== baseline.location.trim()) patch.openapi_location = location || null;
  const models = parseVertexOpenAPIModels(draft.models);
  if (models.join('\n') !== parseVertexOpenAPIModels(baseline.models).join('\n')) {
    patch.openapi_models = models.length > 0 ? models : null;
  }
  return patch;
}
