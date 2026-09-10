#!/usr/bin/env node
/**
 * check-css-modules verifies that every `styles.<class>` reference resolves to a
 * class actually exported by the imported CSS module.
 *
 * Why this needs its own checker: `vite/client` types every `*.module.css`
 * import as `Record<string, string>`, so `tsc --noEmit` accepts
 * `styles.doesNotExist` without complaint. A renamed or deleted class therefore
 * fails silently at runtime — the element simply loses its styling, and no build
 * or type gate notices. Design tokens live in `web/src/index.css`, but layout
 * lives here, so a silent miss shows up as a broken page rather than an error.
 *
 * Class names are kebab-case (AGENTS.md §5); CSS Modules are consumed through
 * `styles['kebab-case']`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Class selectors a CSS module defines, including `:global()` wrappers and
 * nested selectors. Only line-initial class selectors count, which is how every
 * module in this repository is written. */
export function definedClasses(cssSource) {
  const classes = new Set();
  for (const match of cssSource.matchAll(/^\s*\.([a-zA-Z_][a-zA-Z0-9_-]*)/gm)) {
    classes.add(match[1]);
  }
  return classes;
}

/** Class keys a module consumer references, via `styles.name` or `styles['name']`. */
export function referencedClasses(source) {
  const keys = new Set();
  for (const match of source.matchAll(/\bstyles\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) keys.add(match[1]);
  for (const match of source.matchAll(/\bstyles\[\s*['"]([^'"]+)['"]\s*\]/g)) keys.add(match[1]);
  return keys;
}

/** CSS module imports, as `{ localName: modulePath }` relative to the consumer. */
export function moduleImports(source, consumerPath) {
  const imports = new Map();
  const expression = /import\s+(\w+)\s+from\s+['"]([^'"]+\.module\.css)['"]/g;
  for (const match of source.matchAll(expression)) {
    imports.set(match[1], path.resolve(path.dirname(consumerPath), match[2]));
  }
  return imports;
}

function walkSourceFiles(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(absolute, found);
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) found.push(absolute);
  }
  return found;
}

export function checkSourceFile(absolutePath) {
  const source = fs.readFileSync(absolutePath, 'utf8');
  const imports = moduleImports(source, absolutePath);
  if (imports.size === 0) return [];

  const findings = [];
  for (const [localName, modulePath] of imports) {
    // Only the import's local name is a CSS module; `styles.x` on any other
    // object is a different concern.
    const own = new RegExp(`\\b${localName}\\.([a-zA-Z_][a-zA-Z0-9_]*)|\\b${localName}\\[\\s*['"]([^'"]+)['"]\\s*\\]`, 'g');
    if (!/styles/.test(localName) && !own.test(source)) continue;
    if (!fs.existsSync(modulePath)) {
      findings.push({ kind: 'missing-module', file: absolutePath, detail: `${path.basename(modulePath)} does not exist` });
      continue;
    }
    const defined = definedClasses(fs.readFileSync(modulePath, 'utf8'));
    const referenced = new Set();
    for (const match of source.matchAll(own)) referenced.add(match[1] ?? match[2]);
    for (const key of referenced) {
      if (defined.has(key)) continue;
      findings.push({
        kind: 'undefined-class',
        file: absolutePath,
        detail: `${localName}.${key} — not exported by ${path.relative(DEFAULT_ROOT, modulePath)}`,
      });
    }
  }
  return findings;
}

export function runCheck({ projectRoot = DEFAULT_ROOT, output = console } = {}) {
  const sourceDirectory = path.join(projectRoot, 'web', 'src');
  const files = fs.existsSync(sourceDirectory) ? walkSourceFiles(sourceDirectory) : [];
  const findings = files.flatMap((file) => checkSourceFile(file));

  output.log(`CSS module consumers checked: ${files.length}`);
  for (const finding of findings) {
    output.error(`${finding.kind.toUpperCase()}: ${path.relative(projectRoot, finding.file)} — ${finding.detail}`);
  }
  if (findings.length === 0) {
    output.log('Every styles.<class> reference resolves to a class the module exports.');
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf('--root');
  const findings = runCheck({
    projectRoot: rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1]) : DEFAULT_ROOT,
  });
  // The exit code belongs to the command, not to the check, so the check stays
  // callable from tests without poisoning their result.
  if (findings.length > 0) process.exitCode = 1;
}
