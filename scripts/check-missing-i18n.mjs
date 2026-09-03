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

export function runCheck({
  dictionaryFile = path.join(root, 'web', 'src', 'i18n', 'index.tsx'),
  sourceDirectory = path.join(root, 'web', 'src'),
  output = console,
} = {}) {
  const { definedKeys, missing } = findMissingKeys({ dictionaryFile, sourceDirectory });
  output.log(`Total defined keys in DICT: ${definedKeys.size}`);
  for (const item of missing) {
    output.error(`MISSING KEY: "${item.key}" in ${path.relative(root, item.file)}`);
  }
  if (missing.length > 0) process.exitCode = 1;
  return missing;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name, fallback) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? path.resolve(process.argv[index + 1]) : fallback;
  };
  runCheck({
    dictionaryFile: option('--dictionary', path.join(root, 'web', 'src', 'i18n', 'index.tsx')),
    sourceDirectory: option('--source', path.join(root, 'web', 'src')),
  });
}