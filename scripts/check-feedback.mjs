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
 *
 * The same resolution guards the shared components that replace an antd one outright
 * (docs/design.md, Shared primitives):
 *
 * - `Switch` is refused everywhere, because `components/common/Switch` is drawn without it;
 * - `Empty` is refused everywhere, because `components/common/EmptyState` is;
 * - `Tag` is refused everywhere, because `components/common/Tag` is;
 * - `Drawer` is refused outside `components/common/AppDrawer` and the two sheets that are not side
 *   panels - the navigation sheet and the time-range sheet (`PRIMITIVE_OWNERS`);
 * - `Popconfirm` is refused outside `components/common/ConfirmAction`, which fixes the cancel
 *   label and colours a destructive confirmation;
 * - `Card` is refused outside `components/common/Panel`, which keeps the inset in the stylesheet
 *   where the phone rules can reach it;
 * - `Descriptions` is refused everywhere, because `components/common/FactList` is the console's
 *   label/value list;
 * - `Pagination` is refused outside `components/common/Pager`, which hides itself on one page and
 *   never offers a page-size menu;
 * - `Progress` is refused everywhere, because `components/common/Meter` draws a reading.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(path.join(DEFAULT_ROOT, 'web', 'package.json'))('typescript');
const FEEDBACK_MODULE = 'web/src/components/feedback/';
/** The files allowed to hold the raw antd component a shared primitive is built on. */
const PRIMITIVE_OWNERS = {
  'raw-drawer': [
    'web/src/components/common/AppDrawer.tsx',
    'web/src/components/common/AppLayout.tsx',
    'web/src/components/common/timeRange/TimeRangePicker.tsx',
  ],
  'raw-popconfirm': ['web/src/components/common/ConfirmAction.tsx'],
  'raw-card': ['web/src/components/common/Panel.tsx'],
  'raw-pagination': ['web/src/components/common/Pager.tsx'],
};

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
    } else if (kind === 'Switch') {
      violations.push({ line, rule: 'raw-switch', message: 'import `Switch` from components/common/Switch instead of antd' });
    } else if (kind === 'Empty') {
      violations.push({ line, rule: 'raw-empty', message: 'import `EmptyState` from components/common/EmptyState instead of antd `Empty`' });
    } else if (kind === 'Tag') {
      violations.push({ line, rule: 'raw-tag', message: 'import `Tag` from components/common/Tag instead of antd' });
    } else if (kind === 'Popconfirm') {
      violations.push({ line, rule: 'raw-popconfirm', message: 'import `ConfirmAction` from components/common/ConfirmAction instead of antd `Popconfirm`' });
    } else if (kind === 'Card') {
      violations.push({ line, rule: 'raw-card', message: 'import `Panel` from components/common/Panel instead of antd `Card`' });
    } else if (kind === 'Descriptions') {
      violations.push({ line, rule: 'raw-descriptions', message: 'import `FactList` from components/common/FactList instead of antd `Descriptions`' });
    } else if (kind === 'Pagination') {
      violations.push({ line, rule: 'raw-pagination', message: 'import `Pager` from components/common/Pager instead of antd `Pagination`' });
    } else if (kind === 'Progress') {
      violations.push({ line, rule: 'raw-progress', message: 'import `Meter` from components/common/Meter instead of antd `Progress`' });
    } else if (kind === 'Drawer') {
      violations.push({ line, rule: 'raw-drawer', message: 'import `AppDrawer` from components/common/AppDrawer instead of antd `Drawer`' });
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
    if (owner === 'antd' && ['Modal', 'App', 'Alert', 'Switch', 'Empty', 'Tag', 'Drawer', 'Popconfirm', 'Card', 'Descriptions', 'Pagination', 'Progress', 'message', 'notification'].includes(name)) return name;
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
      if (PRIMITIVE_OWNERS[violation.rule]?.includes(relative)) continue;
      failures.push({ file: relative, ...violation });
    }
  }
  if (failures.length > 0) {
    output.error('Feedback surfaces or shared primitives bypassed (docs/design.md, Feedback surfaces and Shared primitives):');
    for (const failure of failures) {
      output.error(`  ${failure.file}:${failure.line} [${failure.rule}] ${failure.message}`);
    }
  } else {
    output.log('Feedback surfaces: every toast and inline notice goes through components/feedback, and every switch, tag, empty state, panel, fact list, pager, meter, side panel and anchored confirmation through its shared component.');
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = runCheck();
  if (failures.length > 0) process.exitCode = 1;
}
