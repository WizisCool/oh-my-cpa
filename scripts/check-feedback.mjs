#!/usr/bin/env node
/**
 * check-feedback keeps every notification, failure and error report on the console's two feedback
 * surfaces (docs/design.md, Feedback surfaces):
 *
 * - the outcome of an action is a toast, through `useToast`;
 * - a condition of a region - a failed read, stale data, a feature switched off - is inline, through
 *   `Notice` or `LoadFailure`.
 *
 * Both are built on Ant Design, whose raw APIs would each work on their own, which is exactly how the
 * console drifted into banners that reported clicks, toasts that duplicated banners, and modal
 * dialogs that only announced a result. So outside `web/src/components/feedback/` this refuses:
 *
 * - `Alert` imported from `antd` (use `Notice` or `LoadFailure`);
 * - `message` or `notification`, imported from `antd` or taken from `App.useApp()` (use `useToast`);
 * - an information-only dialog, `modal.warning/error/info/success` or `Modal.*` of the same
 *   (a confirmation is still `modal.confirm`; a result is a toast).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(path.join(DEFAULT_ROOT, 'web', 'package.json'))('typescript');
const FEEDBACK_MODULE = 'web/src/components/feedback/';

/** Named imports from `antd`, each with the index of the import statement that names it. */
function antdSpecifiers(source) {
  const names = [];
  for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]antd['"]/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '');
      if (name) names.push({ name, index: match.index });
    }
  }
  return names;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** Resolve local symbols so aliases work and shadowed names stay unrelated. */
function findModalCalls(source) {
  const file = ts.createSourceFile('feedback.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const options = { noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === file.fileName ? file : undefined;
  const checker = ts.createProgram([file.fileName], options, host).getTypeChecker();
  const imports = new Map();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'antd') continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        if (!specifier.isTypeOnly) {
          imports.set(checker.getSymbolAtLocation(specifier.name), (specifier.propertyName ?? specifier.name).text);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      imports.set(checker.getSymbolAtLocation(bindings.name), 'antd');
    }
  }

  function memberKind(owner, name) {
    if (owner === 'antd' && (name === 'Modal' || name === 'App')) return name;
    if (owner === 'app' && name === 'modal') return 'Modal';
    return undefined;
  }

  function bindingKind(node, seen = new Set()) {
    if (!node) return undefined;
    if (ts.isParenthesizedExpression(node)) return bindingKind(node.expression, seen);
    if (ts.isPropertyAccessExpression(node)) {
      return memberKind(bindingKind(node.expression, seen), node.name.text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const owner = bindingKind(node.expression.expression, seen);
      if (owner === 'App' && node.expression.name.text === 'useApp') return 'app';
      if (owner === 'Modal' && node.expression.name.text === 'useModal') return 'modalTuple';
    }
    if (!ts.isIdentifier(node)) return undefined;
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol || seen.has(symbol)) return undefined;
    if (imports.has(symbol)) return imports.get(symbol);
    seen.add(symbol);
    const declaration = symbol.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration)) {
      return bindingKind(declaration.initializer, seen);
    }
    if (declaration && ts.isBindingElement(declaration) && !declaration.dotDotDotToken) {
      const pattern = declaration.parent;
      const variable = pattern.parent;
      if (!ts.isVariableDeclaration(variable)) return undefined;
      const owner = bindingKind(variable.initializer, seen);
      if (ts.isObjectBindingPattern(pattern)) {
        return memberKind(owner, (declaration.propertyName ?? declaration.name).text);
      }
      if (owner === 'modalTuple' && pattern.elements[0] === declaration) return 'Modal';
    }
    return undefined;
  }

  const calls = [];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['warning', 'error', 'info', 'success'].includes(node.expression.name.text)
      && bindingKind(node.expression.expression) === 'Modal') {
      calls.push({ index: node.getStart(file), name: node.expression.getText(file) });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return calls;
}

/** The feedback violations in one source file, as `{ line, rule, message }`. */
export function findViolations(source) {
  const violations = [];
  for (const { name, index } of antdSpecifiers(source)) {
    if (name === 'Alert') {
      violations.push({ line: lineOf(source, index), rule: 'raw-alert', message: 'import `Notice` or `LoadFailure` from components/feedback instead of antd `Alert`' });
    } else if (name === 'message' || name === 'notification') {
      violations.push({ line: lineOf(source, index), rule: 'raw-toast', message: `use \`useToast\` instead of antd \`${name}\`` });
    }
  }
  for (const match of source.matchAll(/const\s*\{([^}]*)\}\s*=\s*\w+\.useApp\(\)/g)) {
    const names = match[1].split(',').map((part) => part.trim().split(':')[0].trim());
    for (const name of ['message', 'notification']) {
      if (names.includes(name)) {
        violations.push({ line: lineOf(source, match.index), rule: 'raw-toast', message: `use \`useToast\` instead of \`${name}\` from App.useApp()` });
      }
    }
  }
  for (const { index, name } of findModalCalls(source)) {
    violations.push({ line: lineOf(source, index), rule: 'notice-dialog', message: `a result is a toast, not an information dialog (\`${name}\`)` });
  }
  return violations;
}

function walkSourceFiles(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walkSourceFiles(absolute, found);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) found.push(absolute);
  }
  return found;
}

export function runCheck({ projectRoot = DEFAULT_ROOT, output = console } = {}) {
  const sourceRoot = path.join(projectRoot, 'web', 'src');
  const failures = [];
  for (const file of walkSourceFiles(sourceRoot)) {
    const relative = path.relative(projectRoot, file).split(path.sep).join('/');
    if (relative.startsWith(FEEDBACK_MODULE)) continue;
    for (const violation of findViolations(fs.readFileSync(file, 'utf8'))) {
      failures.push({ file: relative, ...violation });
    }
  }
  if (failures.length > 0) {
    output.error('Feedback surfaces bypassed (docs/design.md, Feedback surfaces):');
    for (const failure of failures) {
      output.error(`  ${failure.file}:${failure.line} [${failure.rule}] ${failure.message}`);
    }
  } else {
    output.log('Feedback surfaces: every toast and inline notice goes through components/feedback.');
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = runCheck();
  if (failures.length > 0) process.exitCode = 1;
}
