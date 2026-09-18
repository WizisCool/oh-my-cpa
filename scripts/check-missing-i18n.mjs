import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function collectDefinedKeys(dictionaryFile) {
  const content = fs.readFileSync(dictionaryFile, 'utf8');
  const keys = new Set();
  const expression = /'([a-zA-Z0-9_.]+)':\s*\[/g;
  for (const match of content.matchAll(expression)) keys.add(match[1]);
  return keys;
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

function collectBasePlaceholders(dictionaryFile) {
  const content = fs.readFileSync(dictionaryFile, 'utf8');
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
    if (entry.name === 'index.tsx' && path.basename(directory) === 'i18n') continue;
    files.push(fullPath);
  }
  return files;
}

export function findMissingKeys({ dictionaryFile, sourceDirectory }) {
  const definedKeys = collectDefinedKeys(dictionaryFile);
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

  return { definedKeys, missing };
}

export function findCatalogGaps({ dictionaryFile, catalogFiles }) {
  const definedKeys = collectDefinedKeys(dictionaryFile);
  const basePlaceholders = collectBasePlaceholders(dictionaryFile);
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

export function runCheck({
  dictionaryFile = path.join(root, 'web', 'src', 'i18n', 'index.tsx'),
  sourceDirectory = path.join(root, 'web', 'src'),
  catalogFiles = [
    { id: 'zh-Hant', file: path.join(root, 'web', 'src', 'i18n', 'locales', 'zh-Hant.ts') },
    { id: 'ms', file: path.join(root, 'web', 'src', 'i18n', 'locales', 'ms.ts') },
  ],
  output = console,
} = {}) {
  const { definedKeys, missing } = findMissingKeys({ dictionaryFile, sourceDirectory });
  output.log(`Total defined keys in DICT: ${definedKeys.size}`);
  for (const item of missing) {
    output.error(`MISSING KEY: "${item.key}" in ${path.relative(root, item.file)}`);
  }
  const catalogGaps = findCatalogGaps({ dictionaryFile, catalogFiles });
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
  if (
    missing.length > 0
    || catalogGaps.some((gap) => gap.missing.length > 0 || gap.extra.length > 0 || gap.placeholderMismatches.length > 0)
  ) {
    process.exitCode = 1;
  }
  return { definedKeys, missing, catalogGaps };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? path.resolve(process.argv[index + 1]) : fallback;
  };
  runCheck({
    dictionaryFile: option('--dictionary', path.join(root, 'web', 'src', 'i18n', 'index.tsx')),
    sourceDirectory: option('--source', path.join(root, 'web', 'src')),
    // A fixture dictionary has no matching catalogs; the catalog contract is
    // checked against the repository dictionary, where the files actually live.
    catalogFiles: process.argv.includes('--dictionary') ? [] : undefined,
  });
}
