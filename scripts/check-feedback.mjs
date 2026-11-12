#!/usr/bin/env node
/**
 * check-feedback keeps every notification, failure, overlay and shared primitive on the console's
 * architecture boundaries (docs/design.md, Feedback and loading; Composition and shared controls):
 *
 * - retired packages (`antd`, `@ant-design/*`, `@rc-component/*`, `rc-*`, `dayjs`, `echarts`) are
 *   refused everywhere;
 * - headless Base UI primitives (`@base-ui/react/*`) are wrapped once in `web/src/components/ui/`;
 * - toasts go through `useToast` (`components/feedback`), never raw `@/components/ui/toast`;
 * - confirmation dialogs go through `ConfirmAction` or `components/feedback`, never raw `alert-dialog`;
 * - drawers and sheets go through `AppDrawer` or the designated mobile/navigation sheets;
 * - modal dialogs go through `AppModal` (plus the Agent full-screen canvas lightbox);
 * - tooltips go through `Tooltip`, `DelegatedTooltipLayer`, or the dedicated chart/list/heatmap layers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ts = createRequire(path.join(DEFAULT_ROOT, 'web', 'package.json'))('typescript');

const RETIRED_MODULE_PATTERN = /^(?:antd(?:\/.*)?|@ant-design\/.*|@rc-component\/.*|rc-[^/]+(?:\/.*)?|dayjs(?:\/.*)?|echarts(?:\/.*)?)$/;

const UI_LAYER = 'web/src/components/ui/';
const FEEDBACK_LAYER = 'web/src/components/feedback/';

const MODULE_OWNERS = {
  '@/components/ui/toast': [FEEDBACK_LAYER, UI_LAYER],
  '@/components/ui/alert-dialog': [FEEDBACK_LAYER, UI_LAYER],
  '@/components/ui/sheet': [
    'web/src/components/common/AppDrawer.tsx',
    'web/src/components/common/AppLayout.tsx',
    'web/src/components/common/SearchSelect.tsx',
    'web/src/components/common/timeRange/TimeRangePicker.tsx',
    UI_LAYER,
  ],
  '@/components/ui/dialog': [
    'web/src/components/common/AppModal.tsx',
    'web/src/pages/agent/AgentMessage.tsx',
    FEEDBACK_LAYER,
    UI_LAYER,
  ],
  '@/components/ui/tooltip': [
    'web/src/components/common/Tooltip.tsx',
    'web/src/components/usage/RequestTooltip.tsx',
    'web/src/components/dashboard/TokenHeatmap.tsx',
    'web/src/pages/insights/charts/InsightsFlowChart.tsx',
    UI_LAYER,
  ],
};

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function isAllowedOwner(relative, owners) {
  return owners.some((owner) => owner.endsWith('/') ? relative.startsWith(owner) : relative === owner);
}

export function findViolations(source, relative = 'web/src/unknown.tsx') {
  const violations = [];
  const file = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specNode = statement.moduleSpecifier;
    if (!specNode || !ts.isStringLiteral(specNode)) continue;
    const spec = specNode.text;
    const line = lineOf(source, statement.getStart(file));

    if (RETIRED_MODULE_PATTERN.test(spec)) {
      violations.push({
        line,
        rule: 'retired-dependency',
        message: `retired package \`${spec}\` must not be imported; use OMC primitives in components/ui or components/common`,
      });
      continue;
    }

    if ((spec === '@base-ui/react' || spec.startsWith('@base-ui/react/')) && !relative.startsWith(UI_LAYER)) {
      violations.push({
        line,
        rule: 'raw-base-ui',
        message: `import from components/ui or components/common instead of raw \`${spec}\` outside components/ui/`,
      });
      continue;
    }

    const owners = MODULE_OWNERS[spec];
    if (owners && !isAllowedOwner(relative, owners)) {
      violations.push({
        line,
        rule: 'shared-primitive-bypass',
        message: `use the shared wrapper in components/common or components/feedback instead of importing \`${spec}\` directly`,
      });
    }
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

export function runCheck({ projectRoot = DEFAULT_ROOT, output = console, files } = {}) {
  const sourceRoot = path.join(projectRoot, 'web', 'src');
  const failures = [];
  for (const file of files ? files.map((item) => path.join(projectRoot, item)).filter((item) => fs.existsSync(item)) : walkSourceFiles(sourceRoot)) {
    const relative = path.relative(projectRoot, file).split(path.sep).join('/');
    for (const violation of findViolations(fs.readFileSync(file, 'utf8'), relative)) {
      failures.push({ file: relative, ...violation });
    }
  }
  if (failures.length > 0) {
    output.error('Feedback surfaces or UI primitive boundaries bypassed (docs/design.md):');
    for (const failure of failures) {
      output.error(`  ${failure.file}:${failure.line} [${failure.rule}] ${failure.message}`);
    }
  } else {
    output.log(
      files
        ? `Feedback surfaces: ${files.length} changed source(s) checked.`
        : 'Feedback surfaces: zero retired UI imports, @base-ui/react isolated to components/ui, and all toast/dialog/sheet/tooltip surfaces routed through shared primitives.',
    );
  }
  return failures;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (runCheck().length > 0) process.exit(1);
}
