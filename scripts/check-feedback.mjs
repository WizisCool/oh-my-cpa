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

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** Resolve local symbols so aliases work and shadowed names stay unrelated. */
export function findViolations(source) {
  const violations = [];
  const file = ts.createSourceFile('feedback.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const options = { noLib: true, noResolve: true };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === file.fileName ? file : undefined;
  const checker = ts.createProgram([file.fileName], options, host).getTypeChecker();
  const imports = new Map();
  function reportRawFeedback(kind, node, origin) {
    const line = lineOf(source, node.getStart(file));
    if (kind === 'Alert') {
      violations.push({ line, rule: 'raw-alert', message: 'import `Notice` or `LoadFailure` from components/feedback instead of antd `Alert`' });
    } else if (kind === 'message' || kind === 'notification') {
      violations.push({ line, rule: 'raw-toast', message: `use \`useToast\` instead of \`${kind}\` from ${origin}` });
    }
  }

  function memberName(node) {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
      return node.argumentExpression.text;
    }
    return undefined;
  }
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== 'antd') continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const specifier of bindings.elements) {
        if (!specifier.isTypeOnly) {
          const kind = (specifier.propertyName ?? specifier.name).text;
          imports.set(checker.getSymbolAtLocation(specifier.name), kind);
          reportRawFeedback(kind, statement, 'antd');
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      imports.set(checker.getSymbolAtLocation(bindings.name), 'antd');
    }
  }

  function memberKind(owner, name) {
    if (owner === 'antd' && ['Modal', 'App', 'Alert', 'message', 'notification'].includes(name)) return name;
    if (owner === 'app') {
      if (name === 'modal') return 'Modal';
      if (name === 'message' || name === 'notification') return name;
    }
    return undefined;
  }

  function bindingKind(node, seen = new Set()) {
    if (!node) return undefined;
    if (ts.isParenthesizedExpression(node)) return bindingKind(node.expression, seen);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return memberKind(bindingKind(node.expression, seen), memberName(node));
    }
    if (ts.isCallExpression(node) && memberName(node.expression)) {
      const owner = bindingKind(node.expression.expression, seen);
      if (owner === 'App' && memberName(node.expression) === 'useApp') return 'app';
      if (owner === 'Modal' && memberName(node.expression) === 'useModal') return 'modalTuple';
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

  function visit(node) {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      reportRawFeedback(bindingKind(node), node, bindingKind(node.expression) === 'app' ? 'App.useApp()' : 'antd');
    } else if (ts.isBindingElement(node)) {
      reportRawFeedback(bindingKind(node.name), node.parent.parent, 'Ant Design binding');
    }
    if (ts.isCallExpression(node) && ['warning', 'error', 'info', 'success'].includes(memberName(node.expression))
      && bindingKind(node.expression.expression) === 'Modal') {
      const name = node.expression.getText(file);
      violations.push({ line: lineOf(source, node.getStart(file)), rule: 'notice-dialog', message: `a result is a toast, not an information dialog (\`${name}\`)` });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
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
