import fs from 'node:fs';
import path from 'node:path';
import { createRequire, isBuiltin } from 'node:module';
import ts from '../web/node_modules/typescript/lib/typescript.js';

const EXTENSIONS = ['', '.ts', '.tsx', '.mjs', '.js', '.json', '/index.ts', '/index.tsx', '/index.mjs'];

/** Development-only selection. Opaque suites always run; unowned changes widen to all. */
export function planLogicSuites(files, suites, root) {
  if (!files || files.some(file => /^(?:package\.json|pnpm-|web\/(?:package\.json|tsconfig|vite\.config)|scripts\/(?:ts-resolve|test-logic|logic-plan|verify-fast))/.test(file))) return suites;
  const relevant = files.filter(file => /\.(?:ts|tsx|js|mjs|json)$/.test(file));
  if (relevant.length === 0) return suites;
  const selected = new Set();
  const owned = new Set();
  const opaqueSuites = new Set();
  const parsed = new Map();
  function readImports(file) {
    if (parsed.has(file)) return parsed.get(file);
    const entry = { imports: [], isOpaque: false };
    parsed.set(file, entry);
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) { entry.isOpaque = true; return entry; }
    const text = fs.readFileSync(absolute, 'utf8');
    if (/\b(?:readFile(?:Sync)?|readdir(?:Sync)?|glob|createRequire)\s*\(/.test(text)) entry.isOpaque = true;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function visit(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
        if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) entry.isOpaque = true;
        else specifier = node.arguments[0];
      }
      if (specifier) {
        if (!ts.isStringLiteral(specifier)) entry.isOpaque = true;
        else {
          const name = specifier.text;
          if (name.startsWith('.')) {
            const location = path.resolve(path.dirname(absolute), name);
            const target = EXTENSIONS.map(extension => location + extension).find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
            if (!target) entry.isOpaque = true;
            else entry.imports.push(path.relative(root, target).split(path.sep).join('/'));
          } else if (isBuiltin(name)) {
            // A filesystem/process reader can depend on files outside its import graph.
            if (/^(?:node:)?(?:fs(?:\/promises)?|child_process)$/.test(name)) entry.isOpaque = true;
          } else {
            // Only installed package imports are safe to stop at. Unresolved aliases widen.
            try {
              const resolved = createRequire(absolute).resolve(name);
              if (!resolved.split(path.sep).includes('node_modules')) entry.isOpaque = true;
            } catch { entry.isOpaque = true; }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    return entry;
  }
  for (const suite of suites) {
    const visited = new Set();
    function visit(file) {
      if (visited.has(file)) return;
      visited.add(file);
      const entry = readImports(file);
      if (entry.isOpaque) opaqueSuites.add(suite.script);
      for (const dependency of entry.imports) visit(dependency);
    }
    visit(suite.script);
    for (const file of relevant) {
      if (visited.has(file)) { owned.add(file); selected.add(suite.script); }
    }
  }
  if (relevant.some(file => !owned.has(file))) return suites;
  return suites.filter(suite => selected.has(suite.script) || opaqueSuites.has(suite.script));
}
