import ts from 'typescript';
import { SHARED_INPUTS, scopeOf } from '../ci-scope.mjs';
import { createImpactGraph } from '../affected-files.mjs';

function parse(graph, file) {
  return ts.createSourceFile(file, graph.read(file), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
}
function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
}

function scenarioSources(graph) {
  const registry = parse(graph, 'scripts/acceptance/scenarios.mjs');
  const imports = new Map();
  for (const statement of registry.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const source = graph.resolve('scripts/acceptance/scenarios.mjs', statement.moduleSpecifier.text);
    const bindings = statement.importClause?.namedBindings;
    if (source && bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) imports.set(binding.name.text, source);
  }
  const scenarioGraphs = new Map();
  visit(registry, node => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const id = node.properties.find(property => property.name?.getText() === 'id');
    if (!id || !ts.isPropertyAssignment(id) || !ts.isStringLiteral(id.initializer)) return;
    const roots = new Set();
    visit(node, child => { if (ts.isIdentifier(child) && imports.has(child.text)) roots.add(imports.get(child.text)); });
    scenarioGraphs.set(id.initializer.text, graph.closure([...roots]));
  });
  return scenarioGraphs;
}

export function probeWorkspaces(ids) {
  const graph = createImpactGraph();
  const scenarios = scenarioSources(graph);
  const sources = [...new Set(ids.flatMap(id => [...(scenarios.get(id) ?? [])]))];
  const source = sources.map(file => graph.read(file)).join('\n');
  return ['agent', 'playground'].filter(name => source.includes(`/${name}`));
}

// Routes and probe imports already declare who owns a scenario. Do not maintain a
// second list of page/component prefixes that drifts whenever a feature is added.
export function planScenarios(files, allIds) {
  const graph = createImpactGraph(files);
  const scenarioGraphs = scenarioSources(graph);
  const pageModules = new Map();
  for (const statement of parse(graph, 'web/src/routePages.ts').statements) {
    let source;
    visit(statement, node => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) source = graph.resolve('web/src/routePages.ts', node.arguments[0].text);
    });
    if (source && ts.isVariableStatement(statement)) {
      const loader = statement.declarationList.declarations[0].name.getText();
      pageModules.set(loader.replace(/^load/, ''), source);
    }
  }
  const pages = [];
  visit(parse(graph, 'web/src/App.tsx'), node => {
    if (!ts.isObjectLiteralExpression(node)) return;
    const route = node.properties.find(property => property.name?.getText() === 'path');
    const element = node.properties.find(property => property.name?.getText() === 'element');
    if (!route || !element || !ts.isPropertyAssignment(route) || !ts.isStringLiteral(route.initializer) || !ts.isPropertyAssignment(element)) return;
    const source = pageModules.get(element.initializer.tagName?.getText());
    if (source) pages.push({ route: `/${route.initializer.text}`, dependencies: graph.closure([source]) });
  });
  const shell = graph.closure(['web/src/main.tsx'], new Set(['web/src/routePages.ts']));
  const selected = new Set();
  const reasons = new Set();
  function all(reason) { return { ids: allIds, reason }; }
  for (const file of files) {
    if (SHARED_INPUTS.test(file)) return all(`${file}: shared configuration`);
    if (file.startsWith('web/tests/') || /^web\/src\/i18n\/locales\//.test(file)) continue;
    const isWeb = file.startsWith('web/');
    const isProbe = /^scripts\/(?:acceptance\/|testing\/(?:probe|vite)|check-ui|affected-files)/.test(file);
    if (!isWeb && !isProbe) {
      if (!/^scripts\/test-[^/]+\.(?:ts|mjs)$/.test(file) && !file.startsWith('deploy/') && scopeOf([file]).web) return all(`${file}: unknown browser impact`);
      continue;
    }
    if (shell.has(file)) {
      if (!file.startsWith('web/src/components/common/') || file.includes('/AuthGate.')) return all(`${file}: shared application/runtime dependency`);
      const representatives = ['route-render-error', 'route-lazy-error', 'mobile-console', 'omc-settings'];
      if (representatives.some(id => !allIds.includes(id))) return all(`${file}: shell representative missing`);
      for (const id of representatives) selected.add(id);
      reasons.add(`${file}: shell representatives (the full catalog runs on main and nightly)`);
      continue;
    }
    const affectedPages = pages.filter(page => page.dependencies.has(file));
    if (isWeb && !affectedPages.length) return all(`${file}: unknown frontend impact`);
    let hasOwner = false;
    for (const id of allIds) {
      const dependencies = scenarioGraphs.get(id);
      if (!dependencies?.size) return all(`${id}: scenario ownership could not be resolved`);
      const probeText = [...dependencies].map(source => graph.read(source)).join('\n');
      // A parameterised navigation may have no literal route. Keep it conservative:
      // the scenario owns every page until its code makes a narrower visit visible.
      const visited = pages.filter(page => probeText.includes(page.route));
      const isAffected = isProbe ? dependencies.has(file) : !visited.length || affectedPages.some(page => visited.includes(page));
      if (isAffected) { selected.add(id); hasOwner = true; }
    }
    if (isProbe && !hasOwner) return all(`${file}: shared or unknown probe infrastructure`);
    reasons.add(`${file}: ${isProbe ? 'probe imports' : affectedPages.map(page => page.route).join(', ')}`);
  }
  return { ids: allIds.filter(id => selected.has(id)), reason: [...reasons].join('; ') || 'no browser-relevant change' };
}
