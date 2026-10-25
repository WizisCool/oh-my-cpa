import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '.css', '.json', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'];

// Imports, including literal dynamic imports, define ownership. TypeScript's parser
// keeps comments and multiline syntax out of the graph; dependencies stay external.
export function createImpactGraph(changed = [], root = ROOT) {
  const known = new Set(changed);
  const sources = new Map();
  const edges = new Map();
  const read = file => {
    if (!sources.has(file)) {
      const absolute = path.join(root, file);
      sources.set(file, /\.(?:[cm]?[jt]sx?|css|json)$/.test(file) && fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '');
    }
    return sources.get(file);
  };
  function resolve(file, specifier) {
    if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return undefined;
    const base = specifier.startsWith('@/') ? `web/src/${specifier.slice(2)}` : path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
    const bases = /\.[cm]?js$/.test(base) ? [base.replace(/\.[cm]?js$/, ''), base] : [base];
    return bases.flatMap(base => EXTENSIONS.map(ext => base + ext)).find(candidate =>
      known.has(candidate) || (fs.existsSync(path.join(root, candidate)) && fs.statSync(path.join(root, candidate)).isFile()));
  }
  function dependencies(file) {
    if (!edges.has(file)) {
      const text = read(file);
      const specifiers = ts.preProcessFile(text, true, true).importedFiles.map(entry => entry.fileName);
      // Stylesheets and URL-backed assets do not appear in TypeScript imports.
      for (const match of text.matchAll(/(?:@import\s*|new URL\(\s*|url\(\s*)['"]([^'"]+)['"]/g)) specifiers.push(match[1]);
      // Some pure suites read repository assets as fixture inputs rather than importing them.
      for (const match of text.matchAll(/['"]((?:web|scripts|deploy)\/[^'"]+\.(?:[cm]?[jt]sx?|css|json))['"]/g)) specifiers.push(`./${path.posix.relative(path.posix.dirname(file), match[1])}`);
      edges.set(file, new Set(specifiers.map(specifier => resolve(file, specifier)).filter(Boolean)));
    }
    return edges.get(file);
  }
  function closure(entries, stop = new Set()) {
    const visited = new Set();
    function visit(file) {
      if (visited.has(file)) return;
      visited.add(file);
      if (!stop.has(file)) for (const dependency of dependencies(file)) visit(dependency);
    }
    entries.forEach(visit);
    return visited;
  }
  function affected(entries) {
    return entries.filter(file => [...closure([file])].some(dependency => known.has(dependency)));
  }
  return { read, resolve, closure, affected };
}
