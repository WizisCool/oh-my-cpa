/**
 * What a changed frontend file can reach at runtime, for the UI scenario planner.
 *
 * Two questions the path rules in `check-ui-plan.mjs` cannot answer on their own:
 *
 *   - **Who imports this file at runtime?** A helper under `types/` or `utils/` has
 *     no scenario of its own, but the pages that import it do. The graph is built from
 *     TypeScript's own `transpileModule` output rather than from the source text,
 *     because the console mixes type and value imports without `import type`, and
 *     the compiler is the authority on which imports survive to runtime. An import
 *     used only in type positions is elided there and therefore cannot move what a
 *     browser observes; everything it keeps (including re-exports it cannot prove
 *     are types) stays an edge, which errs toward running more.
 *
 *   - **Did a translation catalog only gain entries?** Nearly every feature adds
 *     copy, and the catalogs sit in the shared layer, so treating any catalog edit as
 *     "run everything" made the fast lane run the whole catalog for most changes. An
 *     entry that did not exist before is only rendered by code that references it,
 *     and that code is a separate changed file the planner places on its own. So an
 *     edit that leaves every existing entry and every line outside the catalog
 *     objects byte-identical adds nothing a scenario can observe; anything else
 *     still widens.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_ROOT = 'web/src/';
const APP_ENTRY = 'web/src/App.tsx';
const ROUTE_REGISTRY = 'web/src/routePages.ts';
const RESOLVE_EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.json', '/index.ts', '/index.tsx'];

let typescript;
function loadTypeScript() {
  // Resolved from the web package, which is where the pinned compiler is installed.
  typescript ??= createRequire(path.join(root, 'web', 'package.json'))('typescript');
  return typescript;
}

// These proofs recognize the shipped router/loader recipe, not filename conventions.
// Other syntax remains an ordinary runtime edge and therefore widens at the registry.
function findRoutedExports(text, known) {
  const ts = loadTypeScript();
  const source = ts.createSourceFile(APP_ENTRY, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const registryNames = new Map();
  const routerNames = new Set();
  const routedExports = new Set();
  if (source.parseDiagnostics.length > 0) return routedExports;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause?.isTypeOnly || !clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    const specifier = statement.moduleSpecifier.text;
    for (const binding of clause.namedBindings.elements) {
      if (binding.isTypeOnly) continue;
      const importedName = (binding.propertyName ?? binding.name).text;
      if (resolveSpecifier(APP_ENTRY, specifier, known) === ROUTE_REGISTRY) registryNames.set(binding.name.text, importedName);
      if (specifier === 'react-router-dom' && importedName === 'createBrowserRouter') routerNames.add(binding.name.text);
    }
  }
  function visitRouteElement(node) {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName)) {
      const exportedName = registryNames.get(node.tagName.text);
      if (exportedName) routedExports.add(exportedName);
    }
    ts.forEachChild(node, visitRouteElement);
  }
  function visitRoutes(node) {
    if (!ts.isArrayLiteralExpression(node)) return;
    for (const route of node.elements) {
      if (!ts.isObjectLiteralExpression(route)) continue;
      for (const property of route.properties) {
        if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) continue;
        if (property.name.text === 'element') visitRouteElement(property.initializer);
        else if (property.name.text === 'children') visitRoutes(property.initializer);
      }
    }
  }
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && routerNames.has(node.expression.text)
      && node.arguments[0] && ts.isArrayLiteralExpression(node.arguments[0])) visitRoutes(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(source);
  return routedExports;
}

function findRoutePageSpecifiers(output, routedExports) {
  const ts = loadTypeScript();
  const source = ts.createSourceFile(ROUTE_REGISTRY, output, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const reactNames = new Set();
  const declarations = new Map();
  const routeImports = new Set();
  const routeSpecifiers = new Set();
  const otherSpecifiers = new Set();
  if (source.parseDiagnostics.length > 0) return routeSpecifiers;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'react') {
      const clause = statement.importClause;
      if (clause?.name) reactNames.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) reactNames.add(clause.namedBindings.name.text);
    }
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, { declaration, statement });
    }
  }
  for (const exportedName of routedExports) {
    const entry = declarations.get(exportedName);
    const initializer = entry?.declaration.initializer;
    if (!entry?.statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
      || !initializer || !ts.isCallExpression(initializer) || initializer.arguments.length !== 1) continue;
    const callee = initializer.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)
      || !reactNames.has(callee.expression.text) || callee.name.text !== 'lazy') continue;
    const loaderName = initializer.arguments[0];
    if (!ts.isIdentifier(loaderName)) continue;
    const loader = declarations.get(loaderName.text)?.declaration.initializer;
    if (!loader || !ts.isCallExpression(loader) || !ts.isIdentifier(loader.expression)
      || loader.expression.text !== 'createPageLoader' || loader.arguments.length !== 2
      || !ts.isStringLiteral(loader.arguments[1])) continue;
    const loadModule = loader.arguments[0];
    if (!ts.isArrowFunction(loadModule) || loadModule.parameters.length !== 0) continue;
    const importCall = loadModule.body;
    if (ts.isCallExpression(importCall) && importCall.expression.kind === ts.SyntaxKind.ImportKeyword
      && importCall.arguments.length === 1 && ts.isStringLiteral(importCall.arguments[0])) routeImports.add(importCall);
  }
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      (routeImports.has(node) ? routeSpecifiers : otherSpecifiers).add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const specifier of otherSpecifiers) routeSpecifiers.delete(specifier);
  return routeSpecifiers;
}

/** Module specifiers that survive to runtime, from transpiled JavaScript. */
const RUNTIME_SPECIFIER = /(?:\bimport|\bexport)\s*(?:[^'"()]*?\bfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const CSS_IMPORT = /@import\s+(?:url\()?['"]([^'"]+)['"]/g;

function runtimeSpecifiers(file, text, routedExports) {
  if (file.endsWith('.css')) return [...text.matchAll(CSS_IMPORT)].map((match) => ({ specifier: match[1], isDynamic: false }));
  const ts = loadTypeScript();
  const output = ts.transpileModule(text, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
      isolatedModules: true,
      verbatimModuleSyntax: false,
    },
  }).outputText;
  const routeSpecifiers = file === ROUTE_REGISTRY ? findRoutePageSpecifiers(output, routedExports) : undefined;
  return [...output.matchAll(RUNTIME_SPECIFIER)].map((match) => ({
    specifier: match[1] ?? match[2], isDynamic: match[2] !== undefined, isRoutePage: routeSpecifiers?.has(match[2]) ?? false,
  }));
}

/** Resolves a local specifier to a known file; `null` marks a local one that did not resolve. */
function resolveSpecifier(fromFile, specifier, known) {
  let base;
  if (specifier.startsWith('@/')) base = `${SOURCE_ROOT}${specifier.slice(2)}`;
  else if (specifier.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  else return undefined;
  const clean = base.replace(/\?.*$/, '');
  for (const extension of RESOLVE_EXTENSIONS) {
    if (known.has(`${clean}${extension}`)) return `${clean}${extension}`;
  }
  return null;
}

/**
 * The reverse runtime import graph of `web/src`: file -> the files that import it.
 * `files` and `readFile` are injectable so the graph can be tested on a fixture.
 * `routePages` contains only modules proven through App route elements and the
 * registry's literal createPageLoader -> React.lazy recipe, without another registry import.
 *
 * A local specifier that resolves to no known file is recorded in `unresolved`
 * rather than dropped: a missed edge would make an imported file look unused and
 * narrow the plan, so the planner widens whenever the list is not empty.
 */
export function buildImporterGraph({
  files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', SOURCE_ROOT], { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean),
  readFile = (file) => fs.readFileSync(path.join(root, file), 'utf8'),
} = {}) {
  const known = new Set(files);
  const importers = new Map([...known].map((file) => [file, new Set()]));
  const lazyImporters = new Map([...known].map((file) => [file, new Set()]));
  const eagerImporters = new Map([...known].map((file) => [file, new Set()]));
  const unresolved = [];
  const routePages = new Set();
  const nonRouteTargets = new Set();
  let appText;
  try {
    if (known.has(APP_ENTRY)) appText = readFile(APP_ENTRY);
  } catch {
    // The normal graph read below records the failure; there is no route proof meanwhile.
  }
  const routedExports = appText === undefined ? new Set() : findRoutedExports(appText, known);
  for (const file of known) {
    if (!/\.(?:ts|tsx|css)$/.test(file) || file.endsWith('.d.ts')) continue;
    let text;
    try {
      text = file === APP_ENTRY && appText !== undefined ? appText : readFile(file);
    } catch {
      unresolved.push(`${file} -> unreadable source`);
      continue;
    }
    for (const { specifier, isDynamic, isRoutePage } of runtimeSpecifiers(file, text, routedExports)) {
      const target = resolveSpecifier(file, specifier, known);
      if (target === null) unresolved.push(`${file} -> ${specifier}`);
      else if (target) {
        importers.get(target).add(file);
        (isDynamic ? lazyImporters : eagerImporters).get(target).add(file);
        if (file === ROUTE_REGISTRY) (isRoutePage ? routePages : nonRouteTargets).add(target);
      }
    }
  }
  // A page imported both lazily and eagerly still participates in registry initialization.
  // Classify by resolved file rather than spelling so aliases cannot hide the eager edge.
  for (const [file, owners] of eagerImporters) {
    for (const owner of owners) lazyImporters.get(file).delete(owner);
  }
  for (const target of nonRouteTargets) routePages.delete(target);
  return { importers, lazyImporters, routePages, unresolved };
}

/** Top-level `name -> { key -> entry text }` for every object-literal catalog. */
function catalogsOf(file, text) {
  const ts = loadTypeScript();
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const catalogs = new Map();
  const spans = [];
  const unwrap = (node) => {
    while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node) || ts.isParenthesizedExpression(node))) node = node.expression;
    return node;
  };
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const literal = unwrap(declaration.initializer);
      if (!literal || !ts.isObjectLiteralExpression(literal) || !ts.isIdentifier(declaration.name)) continue;
      const entries = new Map();
      let isCatalog = literal.properties.length > 0;
      for (const property of literal.properties) {
        if (!ts.isPropertyAssignment(property) || !(ts.isStringLiteral(property.name) || ts.isIdentifier(property.name))) {
          isCatalog = false;
          break;
        }
        entries.set(property.name.text, property.initializer.getText(source));
      }
      if (!isCatalog) continue;
      catalogs.set(declaration.name.text, entries);
      spans.push([literal.getStart(source), literal.getEnd()]);
    }
  }
  // Everything outside the catalogs, with each catalog replaced by its name, so a
  // change to code or comments in the file is visible to the comparison.
  let outside = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    outside += `${text.slice(cursor, start)}{catalog}`;
    cursor = end;
  }
  outside += text.slice(cursor);
  return { catalogs, outside };
}

/**
 * Whether `current` differs from `base` only by entries added to existing catalogs.
 * Any other difference - a changed or removed entry, a new catalog, or any edit
 * outside the catalogs - is not additions-only.
 */
export function isCatalogAdditionOnly(file, base, current) {
  if (base === undefined || current === undefined) return false;
  const before = catalogsOf(file, base);
  const after = catalogsOf(file, current);
  if (before.catalogs.size === 0) return false;
  if (before.outside !== after.outside) return false;
  if (before.catalogs.size !== after.catalogs.size) return false;
  for (const [name, entries] of before.catalogs) {
    const next = after.catalogs.get(name);
    if (!next) return false;
    for (const [key, value] of entries) {
      if (next.get(key) !== value) return false;
    }
  }
  return true;
}

/** Reads `file` at `ref`, or undefined when it did not exist there. */
export function readAtRef(ref, file) {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

const MANIFESTS = new Set(['package.json', 'web/package.json']);

/**
 * Whether a package manifest changed only in `scripts`. Command aliases do not change
 * what the dev server serves or what the probe browser runs; dependencies, overrides
 * and engines do, and any change to them still widens the plan.
 */
export function isManifestScriptsOnly(file, base, current) {
  if (!MANIFESTS.has(file) || base === undefined || current === undefined) return false;
  try {
    const strip = (text) => {
      const manifest = JSON.parse(text);
      delete manifest.scripts;
      return JSON.stringify(manifest);
    };
    return strip(base) === strip(current);
  } catch {
    return false;
  }
}
