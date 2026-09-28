/**
 * Which probe scenarios a change to the probe code itself can affect.
 *
 * Writing or fixing one probe used to select the whole catalog, because any file
 * under `scripts/acceptance/probes/` or the registry counted as "the framework". Most
 * such changes touch one scenario's module or one registry entry, and a scenario's
 * result depends only on the code it runs. So the change is attributed:
 *
 *   - The **runner** (`probe.mjs`, the two entry scripts) owns the server, the browser
 *     and the contexts every scenario shares, so a change there still selects all.
 *   - The **planners** decide which scenarios run, not what a scenario observes, and
 *     each is pinned by its own self-test, so they select none.
 *   - A **probe module** selects the scenarios whose registry entries reference any
 *     binding imported from it, or from a module that imports it.
 *   - The **registry** selects the entries that changed or were added, plus every
 *     entry that references a top-level binding whose definition changed. An edit to
 *     any other top-level statement selects all.
 *
 * Anything that cannot be attributed this way selects all.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ACCEPTANCE = 'scripts/acceptance/';
const REGISTRY = 'scripts/acceptance/scenarios.mjs';

export const PROBE_RUNNERS = [
  'scripts/acceptance/probe.mjs',
  'scripts/browser-probes.mjs',
  'scripts/check-ui.mjs',
];

export const PROBE_PLANNERS = [
  'scripts/acceptance/check-ui-plan.mjs',
  'scripts/acceptance/ui-impact.mjs',
  'scripts/acceptance/probe-impact.mjs',
  'scripts/acceptance/probe-shards.mjs',
];

let typescript;
function loadTypeScript() {
  typescript ??= createRequire(path.join(root, 'web', 'package.json'))('typescript');
  return typescript;
}

function parse(file, text) {
  const ts = loadTypeScript();
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
}

function identifiersIn(node) {
  const ts = loadTypeScript();
  const names = new Set();
  const visit = (child) => {
    if (ts.isIdentifier(child)) names.add(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

function resolveLocal(fromFile, specifier) {
  if (!specifier.startsWith('.')) return undefined;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
}

/** The registry's shape: import bindings, top-level declarations, other statements, entries. */
function readRegistry(text) {
  const ts = loadTypeScript();
  const source = parse(REGISTRY, text);
  const imports = new Map();
  const declarations = new Map();
  const other = [];
  let entries;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const from = resolveLocal(REGISTRY, statement.moduleSpecifier.text);
      const bindings = statement.importClause?.namedBindings;
      if (statement.importClause?.name) imports.set(statement.importClause.name.text, `${from}#default`);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          imports.set(element.name.text, `${from}#${(element.propertyName ?? element.name).text}`);
        }
      } else if (bindings) {
        imports.set(bindings.name.text, `${from}#*`);
      }
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) {
          other.push(statement.getText(source));
          continue;
        }
        if (declaration.name.text === 'SCENARIOS' && declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer)) {
          entries = new Map();
          for (const element of declaration.initializer.elements) {
            const idProperty = ts.isObjectLiteralExpression(element)
              && element.properties.find((property) => ts.isPropertyAssignment(property)
                && ts.isIdentifier(property.name) && property.name.text === 'id'
                && ts.isStringLiteral(property.initializer));
            if (!idProperty) return undefined;
            entries.set(idProperty.initializer.text, { text: element.getText(source), names: identifiersIn(element) });
          }
          continue;
        }
        declarations.set(declaration.name.text, { text: declaration.getText(source), names: identifiersIn(declaration) });
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.set(statement.name.text, { text: statement.getText(source), names: identifiersIn(statement) });
      continue;
    }
    other.push(statement.getText(source));
  }
  return entries ? { imports, declarations, other, entries } : undefined;
}

/** Scenarios whose entries reference `changed`, following top-level declarations. */
function entriesReferencing(registry, changed) {
  const names = new Set(changed);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, declaration] of registry.declarations) {
      if (names.has(name)) continue;
      if ([...declaration.names].some((used) => names.has(used))) {
        names.add(name);
        grew = true;
      }
    }
  }
  return [...registry.entries].filter(([, entry]) => [...entry.names].some((used) => names.has(used))).map(([id]) => id);
}

/** The acceptance modules that import `file`, directly or through each other. */
function dependents(file, acceptanceImports) {
  const found = new Set([file]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [module, imported] of acceptanceImports) {
      if (found.has(module)) continue;
      if ([...imported].some((target) => found.has(target))) {
        found.add(module);
        grew = true;
      }
    }
  }
  return found;
}

const MODULE_IMPORT = /\bimport\s*(?:[^'"()]*?\bfrom\s*)?['"]([^'"]+)['"]/g;

/** module -> local acceptance modules it imports, from `readCurrent`. */
function acceptanceGraph(files, readCurrent) {
  const graph = new Map();
  for (const file of files) {
    const text = readCurrent(file);
    if (text === undefined) continue;
    const targets = new Set();
    for (const [, specifier] of text.matchAll(MODULE_IMPORT)) {
      const target = resolveLocal(file, specifier);
      if (target) targets.add(target);
    }
    graph.set(file, targets);
  }
  return graph;
}

/**
 * Attributes changed probe code to scenarios.
 *
 * `readBase(file)` and `readCurrent(file)` return a file's text at the base and now
 * (undefined when absent); `acceptanceFiles` lists the `.mjs` modules under
 * `scripts/acceptance/`. Returns `{ all: reason }` or `{ ids, reasons }`.
 */
export function planProbeChange(files, { readBase, readCurrent, acceptanceFiles }) {
  const probeFiles = files.filter((file) => PROBE_RUNNERS.includes(file) || file.startsWith(ACCEPTANCE));
  const ids = new Set();
  const reasons = [];
  if (probeFiles.length === 0) return { ids, reasons };

  const runners = probeFiles.filter((file) => PROBE_RUNNERS.includes(file));
  if (runners.length > 0) return { all: `the probe runner changed (${runners.join(', ')})` };

  const current = readRegistry(readCurrent(REGISTRY) ?? '');
  if (!current) return { all: 'the scenario registry could not be read' };

  const graph = acceptanceGraph(acceptanceFiles, readCurrent);
  for (const file of probeFiles) {
    if (PROBE_PLANNERS.includes(file)) {
      reasons.push({ kind: 'skip', detail: `${file}: selects scenarios rather than running them, pinned by its self-test` });
      continue;
    }
    if (file === REGISTRY) {
      const base = readBase(REGISTRY);
      const before = base === undefined ? undefined : readRegistry(base);
      if (!before) return { all: 'the scenario registry is new or unreadable at the base' };
      if (before.other.join('\n') !== current.other.join('\n')) {
        return { all: 'a top-level statement in the scenario registry changed' };
      }
      const changed = new Set();
      for (const [name, binding] of before.imports) {
        if (current.imports.get(name) !== binding) changed.add(name);
      }
      for (const [name, declaration] of before.declarations) {
        if (current.declarations.get(name)?.text !== declaration.text) changed.add(name);
      }
      for (const name of current.declarations.keys()) {
        if (!before.declarations.has(name)) changed.add(name);
      }
      const selected = new Set(entriesReferencing(current, changed));
      for (const [id, entry] of current.entries) {
        if (before.entries.get(id)?.text !== entry.text) selected.add(id);
      }
      selected.forEach((id) => ids.add(id));
      reasons.push({ kind: 'map', detail: `${file} -> changed entries: ${[...selected].join(', ') || '(none)'}` });
      continue;
    }
    const affected = dependents(file, graph);
    if ([...affected].some((module) => PROBE_RUNNERS.includes(module))) {
      return { all: `${file} is imported by the probe runner` };
    }
    // Only modules the registry imports can bind a scenario; one it never reaches is
    // cross-stack acceptance code, which no probe scenario runs.
    const bindings = [...current.imports]
      .filter(([, binding]) => affected.has(binding.split('#')[0]))
      .map(([name]) => name);
    const selected = entriesReferencing(current, bindings);
    selected.forEach((id) => ids.add(id));
    reasons.push({ kind: 'map', detail: `${file} -> ${selected.join(', ') || '(no probe scenario uses it)'}` });
  }
  return { ids, reasons };
}
