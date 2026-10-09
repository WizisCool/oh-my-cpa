import type { GatewayModelItem } from './gatewayModels';

export interface ModelSquareProvider {
  id: string;
  family: string;
  name: string;
  endpoint_host?: string;
  is_oauth: boolean;
  icon_id?: string;
}
export interface ModelSquareRoute {
  provider_id: string;
  upstream_model: string;
  call_point: string;
}
export interface ModelReferenceLink { label: string; url: string; type?: string }
export interface ModelReference {
  id: string;
  name: string;
  description?: string;
  family?: string;
  open_weights?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  structured_output?: boolean;
  attachment?: boolean;
  temperature?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  license?: string;
  limit: { context?: number; input?: number; output?: number };
  modalities: { input?: string[]; output?: string[] };
  weights?: ModelReferenceLink[];
  links?: ModelReferenceLink[];
}
export interface ModelSquareDirectory {
  models: GatewayModelItem[];
  providers: ModelSquareProvider[];
  routes: ModelSquareRoute[];
  partial: string[];
  model_info: Record<string, ModelReference>;
  metadata_updated_at: string;
}
export interface ModelManufacturer {
  id: string;
  name: string;
  iconId?: string;
  modelIconId?: string;
}

// A model's maker is distinct from the relay or protocol adapter carrying it.
const MODEL_MANUFACTURERS: Record<string, ModelManufacturer> = {
  openai: { id: 'openai', name: 'OpenAI', iconId: 'OpenAI', modelIconId: 'OpenAI' },
  anthropic: { id: 'anthropic', name: 'Anthropic', iconId: 'Anthropic', modelIconId: 'Claude' },
  google: { id: 'google', name: 'Google', iconId: 'Google', modelIconId: 'Gemini' },
  xai: { id: 'xai', name: 'xAI', iconId: 'XAI', modelIconId: 'Grok' },
  alibaba: { id: 'alibaba', name: 'Qwen', iconId: 'Qwen', modelIconId: 'Qwen' },
  deepseek: { id: 'deepseek', name: 'DeepSeek', iconId: 'DeepSeek', modelIconId: 'DeepSeek' },
  moonshotai: { id: 'moonshotai', name: 'Moonshot AI', iconId: 'Moonshot', modelIconId: 'Kimi' },
  zai: { id: 'zai', name: 'Z.ai', iconId: 'ZAI', modelIconId: 'Zhipu' },
  minimax: { id: 'minimax', name: 'MiniMax', iconId: 'Minimax', modelIconId: 'Minimax' },
  mistral: { id: 'mistral', name: 'Mistral AI', iconId: 'Mistral', modelIconId: 'Mistral' },
  meta: { id: 'meta', name: 'Meta', iconId: 'Meta', modelIconId: 'Meta' },
  cohere: { id: 'cohere', name: 'Cohere', iconId: 'Cohere', modelIconId: 'Cohere' },
  'bytedance-seed': { id: 'bytedance-seed', name: 'ByteDance', iconId: 'ByteDance', modelIconId: 'Doubao' },
  xiaomi: { id: 'xiaomi', name: 'Xiaomi', iconId: 'XiaomiMiMo', modelIconId: 'XiaomiMiMo' },
  inception: { id: 'inception', name: 'Inception', iconId: 'Inception', modelIconId: 'Inception' },
  bilibili: { id: 'bilibili', name: 'Bilibili', iconId: 'Bilibili', modelIconId: 'BilibiliIndex' },
  microsoft: { id: 'microsoft', name: 'Microsoft', iconId: 'Microsoft', modelIconId: 'Microsoft' },
  amazon: { id: 'amazon', name: 'Amazon', iconId: 'Aws', modelIconId: 'Nova' },
  baidu: { id: 'baidu', name: 'Baidu', iconId: 'Baidu', modelIconId: 'Wenxin' },
  tencent: { id: 'tencent', name: 'Tencent', iconId: 'Tencent', modelIconId: 'Hunyuan' },
  perplexity: { id: 'perplexity', name: 'Perplexity', iconId: 'Perplexity', modelIconId: 'Perplexity' },
  nvidia: { id: 'nvidia', name: 'NVIDIA', iconId: 'Nvidia', modelIconId: 'Nvidia' },
  stepfun: { id: 'stepfun', name: 'StepFun', iconId: 'Stepfun', modelIconId: 'Stepfun' },
};
const AUTHOR_ALIASES: Record<string, string> = { 'x-ai': 'xai', qwen: 'alibaba', 'z-ai': 'zai', zhipuai: 'zai', 'zai-org': 'zai', mistralai: 'mistral', 'meta-llama': 'meta', 'moonshotai-cn': 'moonshotai', 'deepseek-ai': 'deepseek', inceptionlabs: 'inception', 'amazon-nova': 'amazon', bytedance: 'bytedance-seed' };
const UNKNOWN_MANUFACTURER: ModelManufacturer = { id: 'unknown', name: '' };
const MODEL_FAMILY_RULES: readonly [RegExp, string][] = [
  [/^(?:gpt(?:-|\d)|chatgpt-|o[134](?:-|$)|codex(?:-|$))/, 'openai'],
  [/^claude(?:-|$)/, 'anthropic'], [/^(?:gemini|gemma)(?:-|$)/, 'google'],
  [/^grok(?:-|$)/, 'xai'], [/^(?:qwen|qwq)(?:\d|[-.]|$)/, 'alibaba'],
  [/^deepseek(?:-|$)/, 'deepseek'], [/^(?:kimi|moonshot)(?:[-\d]|$)/, 'moonshotai'],
  [/^glm(?:[-\d]|$)/, 'zai'], [/^minimax(?:[-\d]|$)/, 'minimax'],
  [/^(?:mistral|mixtral|codestral|devstral|magistral|ministral|pixtral|voxtral)(?:[-\d]|$)/, 'mistral'],
  [/^(?:llama(?:[-\d.]|$)|muse-)/, 'meta'], [/^command(?:-|$)/, 'cohere'],
  [/^(?:doubao|seed)(?:-|$)/, 'bytedance-seed'], [/^mimo(?:-|$)/, 'xiaomi'],
  [/^mercury(?:[-\d]|$)/, 'inception'], [/^index-/, 'bilibili'], [/^phi(?:[-\d]|$)/, 'microsoft'],
  [/^nova-/, 'amazon'], [/^ernie(?:[-\d]|$)/, 'baidu'], [/^hunyuan(?:-|$)/, 'tencent'],
  [/^sonar(?:-|$)/, 'perplexity'], [/^nemotron(?:-|$)/, 'nvidia'], [/^step-/, 'stepfun'],
];

export function resolveModelManufacturer(identity: string, metadata?: ModelReference): ModelManufacturer {
  if (!identity) return UNKNOWN_MANUFACTURER;
  const author = (metadata?.id ?? identity).split('/').slice(0, -1).join('/').toLowerCase();
  const slug = identity.split('/').at(-1)?.toLowerCase() ?? '';
  const maker = MODEL_MANUFACTURERS[AUTHOR_ALIASES[author] ?? author] ?? MODEL_MANUFACTURERS[MODEL_FAMILY_RULES.find(([pattern]) => pattern.test(slug))?.[1] ?? ''];
  if (!maker) return metadata && author ? { id: author, name: author } : UNKNOWN_MANUFACTURER;
  if (maker.id === 'openai' && slug.includes('codex')) return { ...maker, modelIconId: 'Codex' };
  if (maker.id === 'google' && slug.startsWith('gemma')) return { ...maker, modelIconId: 'Gemma' };
  return maker;
}

/**
 * The context window the reference catalog lists for a call point, or undefined when it lists none.
 *
 * A call point can route to several upstream models; the smallest window among them is the one a
 * conversation is sure to fit, whichever route the gateway picks.
 */
export function referenceContextWindow(directory: ModelSquareDirectory | undefined, callPoint: string): number | undefined {
  if (!directory || !callPoint) return undefined;
  const identities = [callPoint, ...directory.routes.filter(route => route.call_point === callPoint).map(route => route.upstream_model)];
  const windows = identities
    .map(identity => directory.model_info[identity]?.limit.context)
    .filter((window): window is number => typeof window === 'number' && window > 0);
  return windows.length > 0 ? Math.min(...windows) : undefined;
}

export interface ModelSquareEntry {
  identity: string;
  manufacturer: ModelManufacturer;
  routes: ModelSquareRoute[];
  profiles: { identity: string; metadata?: ModelReference }[];
}

export function buildModelSquareEntries(directory: ModelSquareDirectory, search: string): ModelSquareEntry[] {
  const advertised = new Set(directory.models.map(model => model.id));
  const routesByIdentity = new Map<string, ModelSquareRoute[]>();
  for (const route of directory.routes) {
    if (!advertised.has(route.call_point)) continue;
    const routes = routesByIdentity.get(route.call_point) ?? [];
    if (!routes.some(item => item.provider_id === route.provider_id && item.upstream_model === route.upstream_model)) routes.push(route);
    routesByIdentity.set(route.call_point, routes);
  }
  const needle = search.trim().toLowerCase();
  return directory.models.map(model => {
    const routes = routesByIdentity.get(model.id) ?? [{ provider_id: '', upstream_model: '', call_point: model.id }];
    // A profile is a distinct model, not a distinct route: two connections reaching the same
    // source record under different upstream names describe one model once.
    const profiles: ModelSquareEntry['profiles'] = [];
    for (const identity of new Set(routes.map(route => route.upstream_model || route.call_point))) {
      const metadata = directory.model_info[identity];
      if (metadata && profiles.some(profile => profile.metadata?.id === metadata.id)) continue;
      profiles.push({ identity, metadata });
    }
    const makers = profiles.map(profile => resolveModelManufacturer(profile.identity, profile.metadata));
    const manufacturer = makers.every(maker => maker.id === makers[0].id) ? makers[0] : { id: 'multiple', name: '' };
    return { identity: model.id, manufacturer, routes, profiles };
  }).filter(entry => !needle || [entry.identity, entry.manufacturer.name, ...entry.profiles.flatMap(profile => [profile.identity, profile.metadata?.name ?? '', profile.metadata?.id ?? '', resolveModelManufacturer(profile.identity, profile.metadata).name, profile.metadata?.family ?? ''])].some(value => value.toLowerCase().includes(needle)))
    .sort((left, right) => manufacturerRank(left.manufacturer) - manufacturerRank(right.manufacturer)
      || manufacturerSortName(left.manufacturer).localeCompare(manufacturerSortName(right.manufacturer))
      || left.identity.localeCompare(right.identity));
}

// Named makers read alphabetically by the name the heading shows; the two groups that are not a
// maker follow them, so "Multiple" and "Unidentified" never interrupt the alphabet.
function manufacturerRank(manufacturer: ModelManufacturer): number {
  return manufacturer.id === 'unknown' ? 2 : manufacturer.id === 'multiple' ? 1 : 0;
}
function manufacturerSortName(manufacturer: ModelManufacturer): string {
  return (manufacturer.name || manufacturer.id).toLowerCase();
}

export function filterModelSquareEntries(entries: readonly ModelSquareEntry[], manufacturerId: string): ModelSquareEntry[] {
  return manufacturerId ? entries.filter(entry => entry.manufacturer.id === manufacturerId) : [...entries];
}

export interface ModelManufacturerCount {
  manufacturer: ModelManufacturer;
  count: number;
}

/** Makers in the order their sections appear, each with the number of client names it holds. */
export function countModelManufacturers(entries: readonly ModelSquareEntry[]): ModelManufacturerCount[] {
  const counts = new Map<string, ModelManufacturerCount>();
  for (const entry of entries) {
    const current = counts.get(entry.manufacturer.id);
    if (current) current.count += 1;
    else counts.set(entry.manufacturer.id, { manufacturer: entry.manufacturer, count: 1 });
  }
  return [...counts.values()];
}

/**
 * The reference a row may name.
 *
 * A client name that fans out to different models has no single reference, and naming one
 * target's would state it for the others.
 */
export function resolveEntryReference(entry: ModelSquareEntry): ModelReference | undefined {
  const [first, ...rest] = entry.profiles;
  if (!first?.metadata) return undefined;
  return rest.every(profile => profile.metadata?.id === first.metadata?.id) ? first.metadata : undefined;
}

export type ModelOpenness = 'closed' | 'open_weights' | 'open_source';

// Licences that grant use, modification and redistribution without field-of-use limits. A
// community, research or non-commercial licence publishes weights without making the model open source.
const OPEN_SOURCE_LICENSES = new Set(['mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause', 'mpl-2.0', 'isc', 'unlicense', 'gpl-3.0', 'lgpl-3.0', 'agpl-3.0']);

/**
 * How open a model is, from the two facts the source states separately.
 *
 * Published weights alone make a model open-weight; it is open source only when its licence is
 * one too. A model whose weights the source does not describe has no classification.
 */
export function classifyModelOpenness(metadata: Pick<ModelReference, 'open_weights' | 'license'>): ModelOpenness | undefined {
  if (metadata.open_weights === undefined) return undefined;
  if (!metadata.open_weights) return 'closed';
  const license = (metadata.license ?? '').trim().toLowerCase().replace(/\s+license$/, '').replace(/\s+/g, '-');
  return OPEN_SOURCE_LICENSES.has(license) ? 'open_source' : 'open_weights';
}

export function buildModelReferenceLinks(identity: string, metadata?: ModelReference): { label: string; url: string }[] {
  const canonical = metadata?.id ?? identity;
  const name = canonical.split('/').at(-1) || identity;
  return [
    { label: 'models.dev', url: metadata ? `https://models.dev/models/${canonical.split('/').map(encodeURIComponent).join('/')}` : 'https://models.dev/' },
    { label: 'OpenRouter', url: `https://openrouter.ai/models?q=${encodeURIComponent(name)}` },
    { label: 'pi.dev', url: `https://pi.dev/models?name=${encodeURIComponent(name)}` },
  ];
}

export function isSafeReferenceURL(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
