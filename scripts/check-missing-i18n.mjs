import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The base dictionary's message files: every module under `messages/` but the aggregator and its type. */
function dictionaryFiles(directory) {
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith('.ts') && name !== 'index.ts' && name !== 'types.ts')
    .sort()
    .map((name) => path.join(directory, name));
}

/**
 * Every key the dictionary defines, and each key defined more than once. The files are
 * spread into one object, so a key repeated in a second file would replace the first
 * file's copy without an error from the compiler.
 */
export function collectDefinedKeys(files) {
  const owners = new Map();
  const expression = /'([a-zA-Z0-9_.]+)':\s*\[/g;
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(expression)) {
      owners.set(match[1], [...(owners.get(match[1]) ?? []), file]);
    }
  }
  const duplicates = [...owners].filter(([, where]) => where.length > 1);
  return { keys: new Set(owners.keys()), duplicates };
}

export function collectCatalogKeys(catalogFile) {
  const content = fs.readFileSync(catalogFile, 'utf8');
  const keys = new Set();
  const expression = /^\s*['"]([a-zA-Z0-9_.]+)['"]:\s*['"]/gm;
  for (const match of content.matchAll(expression)) keys.add(match[1]);
  return keys;
}

export function collectCatalogEntries(catalogFile) {
  const content = fs.readFileSync(catalogFile, 'utf8');
  const entries = new Map();
  const expression = /^\s*"([a-zA-Z0-9_.]+)":\s*("(?:[^"\\]|\\.)*")/gm;
  for (const match of content.matchAll(expression)) entries.set(match[1], JSON.parse(match[2]));
  return entries;
}

function collectBasePlaceholders(files) {
  const content = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const placeholders = new Map();
  const expression = /'([a-zA-Z0-9_.]+)':\s*\[\s*'(?:[^'\\]|\\.)*'\s*,\s*'((?:[^'\\]|\\.)*)'\s*,?\s*\]/gs;
  const placeholderExpression = /\{[A-Za-z0-9_]+\}/g;
  for (const match of content.matchAll(expression)) {
    placeholders.set(match[1], match[2].match(placeholderExpression) ?? []);
  }
  return placeholders;
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(fullPath));
      continue;
    }
    if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
    if (entry.name.includes('.test.')) continue;
    if (path.basename(directory) === 'messages' && path.basename(path.dirname(directory)) === 'i18n') continue;
    files.push(fullPath);
  }
  return files;
}

export function findMissingKeys({ definedKeys, sourceDirectory }) {
  const missing = [];
  const expression = /\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g;

  for (const file of sourceFiles(sourceDirectory)) {
    const content = fs.readFileSync(file, 'utf8');
    for (const match of content.matchAll(expression)) {
      if (!definedKeys.has(match[1])) {
        missing.push({ key: match[1], file });
      }
    }
  }

  return missing;
}

export function findCatalogGaps({ definedKeys, files, catalogFiles }) {
  const basePlaceholders = collectBasePlaceholders(files);
  return catalogFiles.map(({ id, file }) => {
    const catalogEntries = collectCatalogEntries(file);
    const catalogKeys = new Set(catalogEntries.keys());
    const missing = [...definedKeys].filter((key) => !catalogKeys.has(key)).sort();
    const extra = [...catalogKeys].filter((key) => !definedKeys.has(key)).sort();
    const placeholderMismatches = [...catalogEntries]
      .filter(([key, value]) => {
        const expected = basePlaceholders.get(key);
        if (!expected) return false;
        const actual = value.match(/\{[A-Za-z0-9_]+\}/g) ?? [];
        return expected.join('\u0000') !== actual.join('\u0000');
      })
      .map(([key, value]) => ({
        key,
        expected: basePlaceholders.get(key),
        actual: value.match(/\{[A-Za-z0-9_]+\}/g) ?? [],
      }));
    return { id, file, missing, extra, placeholderMismatches };
  });
}

const CAPABILITY_PREFIX = 'agent.capability.';

/**
 * Capability copy is looked up by a computed key, so the reference scan above cannot see it.
 * The console falls back to the registry's identifier when copy is missing, which would let a
 * new capability ship untranslated unnoticed. The registry is read from the demonstration
 * dataset, which the real handlers generate and TestExportDemoDataset keeps fresh.
 */
function findCapabilityGaps(definedKeys) {
  const dataset = JSON.parse(fs.readFileSync(path.join(root, 'deploy', 'cloudflare', 'data', 'responses.json'), 'utf8'));
  const names = new Set(JSON.parse(dataset.responses.capabilities.body).capabilities.map((capability) => capability.name));
  const missing = [...names].flatMap((name) => [`${CAPABILITY_PREFIX}${name}`, `${CAPABILITY_PREFIX}${name}.description`])
    .filter((key) => !definedKeys.has(key));
  const stale = [...definedKeys]
    .filter((key) => key.startsWith(CAPABILITY_PREFIX) && !names.has(key.slice(CAPABILITY_PREFIX.length).replace(/\.description$/, '')));
  return { missing, stale };
}

export function runCheck({
  dictionaryDirectory = path.join(root, 'web', 'src', 'i18n', 'messages'),
  sourceDirectory = path.join(root, 'web', 'src'),
  catalogFiles = [
    { id: 'zh-Hant', file: path.join(root, 'web', 'src', 'i18n', 'locales', 'zh-Hant.ts') },
    { id: 'ms', file: path.join(root, 'web', 'src', 'i18n', 'locales', 'ms.ts') },
  ],
  output = console,
} = {}) {
  const files = dictionaryFiles(dictionaryDirectory);
  const { keys: definedKeys, duplicates } = collectDefinedKeys(files);
  const missing = findMissingKeys({ definedKeys, sourceDirectory });
  output.log(`Total defined keys in the base dictionary: ${definedKeys.size}`);
  for (const [key, where] of duplicates) {
    output.error(`DUPLICATE KEY: "${key}" in ${where.map((file) => path.relative(root, file)).join(', ')}`);
  }
  for (const item of missing) {
    output.error(`MISSING KEY: "${item.key}" in ${path.relative(root, item.file)}`);
  }
  const catalogGaps = findCatalogGaps({ definedKeys, files, catalogFiles });
  for (const gap of catalogGaps) {
    for (const key of gap.missing) {
      output.error(`MISSING ${gap.id} TRANSLATION: "${key}" in ${path.relative(root, gap.file)}`);
    }
    for (const key of gap.extra) {
      output.error(`STALE ${gap.id} TRANSLATION: "${key}" in ${path.relative(root, gap.file)}`);
    }
    for (const mismatch of gap.placeholderMismatches) {
      output.error(
        `PLACEHOLDER MISMATCH ${gap.id} TRANSLATION: "${mismatch.key}" expected ${mismatch.expected.join(', ') || '(none)'} but got ${mismatch.actual.join(', ') || '(none)'}`,
      );
    }
  }
  const capabilityGaps = findCapabilityGaps(definedKeys);
  for (const key of capabilityGaps.missing) output.error(`MISSING CAPABILITY COPY: "${key}"`);
  for (const key of capabilityGaps.stale) output.error(`STALE CAPABILITY COPY: "${key}" names no registered capability`);
  if (
    missing.length > 0
    || duplicates.length > 0
    || capabilityGaps.missing.length > 0
    || capabilityGaps.stale.length > 0
    || catalogGaps.some((gap) => gap.missing.length > 0 || gap.extra.length > 0 || gap.placeholderMismatches.length > 0)
  ) {
    process.exitCode = 1;
  }
  return { definedKeys, missing, catalogGaps };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCheck();
}
