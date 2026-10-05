import { writeFile } from 'node:fs/promises';

const MODEL_FIELDS = ['id', 'name', 'description', 'family', 'attachment', 'reasoning', 'tool_call', 'structured_output', 'temperature', 'knowledge', 'release_date', 'last_updated', 'modalities', 'open_weights', 'limit', 'license', 'weights', 'links'];

export function projectModelMetadata(models, providers) {
  const projected = {};
  const candidates = new Map();
  const addAlias = (alias, canonical) => {
    if (!alias || alias === canonical) return;
    const targets = candidates.get(alias) ?? new Set();
    targets.add(canonical);
    candidates.set(alias, targets);
  };
  for (const [id, model] of Object.entries(models).sort(([left], [right]) => left.localeCompare(right))) {
    if (id !== model.id || !id.includes('/')) throw new Error(`Invalid canonical model identity: ${id}`);
    projected[id] = Object.fromEntries(MODEL_FIELDS.filter(field => model[field] !== undefined).map(field => [field, model[field]]));
    addAlias(id.slice(id.indexOf('/') + 1), id);
  }
  for (const [providerId, provider] of Object.entries(providers)) {
    for (const [id, model] of Object.entries(provider.models ?? {})) {
      const canonical = model.canonical_model_id;
      if (!projected[canonical]) continue;
      addAlias(id, canonical);
      addAlias(`${providerId}/${id}`, canonical);
    }
  }
  const aliases = Object.fromEntries([...candidates].sort(([left], [right]) => left.localeCompare(right)).filter(([, targets]) => targets.size === 1).map(([alias, targets]) => [alias, [...targets][0]]));
  return { source: 'https://models.dev/models.json', models: projected, aliases };
}

if (process.argv[1]?.endsWith('sync-model-metadata.mjs')) {
  const readSource = async path => {
    const response = await fetch(`https://models.dev/${path}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`models.dev ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const [models, providers] = await Promise.all([readSource('models.json'), readSource('api.json')]);
  const snapshot = { ...projectModelMetadata(models, providers), updated_at: new Date().toISOString().slice(0, 10) };
  await writeFile(new URL('../internal/modelcatalog/snapshot.json', import.meta.url), `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`models.dev: ${Object.keys(snapshot.models).length} canonical models, ${Object.keys(snapshot.aliases).length} exact aliases`);
}
