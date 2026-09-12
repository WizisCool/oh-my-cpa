#!/usr/bin/env node
/**
 * check-docs verifies that the context documentation still points at things
 * that exist.
 *
 * Documentation drift in this repository has one dominant shape: prose keeps
 * referencing a file, page, endpoint or identifier that a later change removed
 * or renamed. Reviewers cannot catch that reliably by reading a diff, and the
 * per-file grep discipline in AGENTS.md only works if someone remembers to run
 * it. This script makes the mechanical half of that discipline cheap:
 *
 *   1. every backticked repo path in a context document must resolve;
 *   2. non-archival documents must not cite absolute line numbers, because a
 *      reference like `handler.go:53-128` is wrong the moment the file grows;
 *   3. a known-retired-artifact list catches the specific references that have
 *      already gone stale once.
 *
 * It deliberately does not try to judge prose. A path that exists proves
 * nothing about what the sentence around it claims.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Context documents under maintenance. `archival` documents are frozen
 * records: they may cite line numbers and plan-time figures. */
export const DOCUMENTS = [
  { file: 'AGENTS.md' },
  { file: 'CONTEXT.md' },
  { file: 'README.md' },
  { file: 'PRODUCT.md' },
  { file: 'DESIGN.md' },
  { file: 'docs/architecture.md' },
  { file: 'docs/design.md' },
  { file: 'docs/cpamc-parity.md' },
  { file: 'docs/ops/sqlite-operations.md' },
  { file: 'docs/plans/model-prices.md' },
  { file: 'docs/adr/0001-go-react-sqlite-modular-monolith.md', archival: true },
  { file: 'docs/adr/0002-cpa-binding-and-identity-hierarchy.md', archival: true },
  { file: 'docs/adr/0003-request-time-price-snapshots.md', archival: true },
];

/** References that have already gone stale at least once. Each entry is
 * evidence for a future reviewer: the reason explains what replaced it. */
export const RETIRED_REFERENCES = [
  { pattern: /docs\/DESIGN\.md/, reason: 'the visual-system source of truth is docs/design.md (lowercase)' },
  { pattern: /cli-proxy-api-management-center\.html/, reason: 'the prototype HTML is not part of this repository' },
  { pattern: /AllResourcesPage/, reason: 'the triage console page was removed when navigation aligned with gateway surfaces' },
  { pattern: /InstanceStatusPage/, reason: 'the instance status page was removed with the triage console' },
  { pattern: /ResourceEditDrawer/, reason: 'the resource edit drawer was removed with the triage console' },
  { pattern: /web\/src\/pages\/TriagePage\.tsx/, reason: 'the triage page was removed when navigation aligned with gateway surfaces' },
  { pattern: /goal\.md/, reason: 'the overhaul plan was retired once every stage shipped; AGENTS.md holds the Agent contract' },
  { pattern: /docs\/performance-usage-audit\.md/, reason: 'the one-off performance audit was retired; its numbers described a single local machine' },
];

/**
 * Paths that legitimately do not exist in a fresh clone: gitignored runtime
 * data, user-supplied binaries, and build output. Each entry records why, so the
 * allowlist cannot quietly absorb a genuine stale reference.
 */
export const EXPECTED_ABSENT_PATHS = [
  { path: 'cpa/', reason: 'the CLIProxyAPI directory is user-supplied and gitignored' },
  { path: 'cpa/cli-proxy-api', reason: 'the CLIProxyAPI binary is user-supplied and gitignored' },
  { path: 'cpa/cli-proxy-api.exe', reason: 'the CLIProxyAPI binary is user-supplied and gitignored' },
  { path: 'cpa/config.yaml', reason: "the operator's CPA config is user-supplied and gitignored" },
  { path: 'data/', reason: 'runtime data directory, gitignored' },
  { path: 'tmp/', reason: 'local scratch directory, gitignored' },
  { path: 'oh-my-cpa-data/', reason: 'runtime data directory, gitignored' },
  { path: 'internal/web/dist/index.html', reason: 'committed build stub; the rest of dist/ is gitignored' },
  { path: 'web/dist/', reason: 'build output, gitignored' },
  { path: 'bin/', reason: 'build output, gitignored' },
  { path: 'node_modules/', reason: 'installed dependencies, gitignored' },
  { path: '.pi/', reason: 'local agent artifacts, gitignored' },
];

const ROOT_FILES = new Set([
  'AGENTS.md', 'CONTEXT.md', 'DESIGN.md', 'PRODUCT.md', 'README.md',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'go.mod', 'go.sum',
  'Dockerfile', '.env', '.env.example', '.air.toml', '.editorconfig', '.gitattributes',
  '.gitignore', '.dockerignore', '.node-version', '.nvmrc', 'gitleaks.toml', 'LICENSE',
]);

const REPO_DIRS = [
  'cmd', 'internal', 'web', 'docs', 'scripts', 'migrations', 'deploy', 'data', 'cpa',
  '.github', '.pi', '.tools', '.impeccable',
];

/** Tokens that cannot be a repo path even though they look path-like: globs,
 * shell placeholders, URLs, and anything with whitespace. */
const NOT_A_PATH = /[*<>{}[\]|]|\s|^[a-z][a-z0-9+.-]*:\/\//;

const LINE_REF = /:\d+(?:[-,]\d+)*$/;

/** A trailing `.Name` is a symbol reference (e.g. `pgk.Type`), not part of the
 * path, so it is stripped before the existence check. */
const SYMBOL_SUFFIX = /\.[A-Z][A-Za-z0-9_]*$/;

export function createPathResolver(projectRoot) {
  const cache = new Map();
  return (relativePath) => {
    if (cache.has(relativePath)) return cache.get(relativePath);
    const resolved = path.resolve(projectRoot, relativePath);
    const insideRoot = resolved === projectRoot || resolved.startsWith(projectRoot + path.sep);
    const ok = insideRoot && fs.existsSync(resolved);
    cache.set(relativePath, ok);
    return ok;
  };
}

/**
 * classifyPath narrows a backticked span to a repo path plus whether the span
 * also cited a line. Anything ambiguous returns null so the check never guesses.
 */
export function classifyPath(span) {
  if (!span || NOT_A_PATH.test(span)) return null;
  const hasLineRef = LINE_REF.test(span);
  const withoutLineRef = span.replace(LINE_REF, '');
  // Only a path that names a file can carry a line number; `cpa:8317` is a
  // host and port, and `docs/architecture` is a directory.
  const lineRef = hasLineRef && /\.[A-Za-z0-9]+$/.test(withoutLineRef);
  if (!withoutLineRef || NOT_A_PATH.test(withoutLineRef)) return null;

  let cleaned = withoutLineRef.replace(/^\.\//, '').replace(/[.,;:]$/, '');
  if (!cleaned) return null;
  // `internal/usage/ingest.Runner` references a symbol inside a path, so the
  // trailing `.Name` is not part of the path to resolve.
  const withoutSymbol = cleaned.replace(SYMBOL_SUFFIX, '');
  if (withoutSymbol && !ROOT_FILES.has(cleaned)) cleaned = withoutSymbol;
  if (ROOT_FILES.has(cleaned)) return { path: cleaned, lineRef };

  // Anything outside the known top-level directories is too ambiguous to check.
  if (!REPO_DIRS.includes(cleaned.split('/')[0])) return null;
  const trimmed = cleaned.endsWith('/') ? cleaned.slice(0, -1) : cleaned;
  if (!trimmed) return null;
  return { path: trimmed, lineRef };
}

function isExpectedAbsent(relativePath) {
  return EXPECTED_ABSENT_PATHS.some(
    (entry) => relativePath === entry.path.replace(/\/$/, '') || relativePath.startsWith(entry.path),
  );
}

function backtickedSpans(content) {
  const spans = [];
  for (const match of content.matchAll(/`([^`\n]+)`/g)) spans.push(match[1].trim());
  return spans;
}

export function checkDocument({ file, archival = false }, { projectRoot = DEFAULT_ROOT } = {}) {
  const absolute = path.join(projectRoot, file);
  if (!fs.existsSync(absolute)) {
    return [{ kind: 'missing-document', file, detail: 'listed for maintenance but does not exist' }];
  }
  const resolvePath = createPathResolver(projectRoot);
  const findings = [];
  const alreadyReported = new Set();

  for (const span of backtickedSpans(fs.readFileSync(absolute, 'utf8'))) {
    if (!archival) {
      for (const retired of RETIRED_REFERENCES) {
        if (!retired.pattern.test(span)) continue;
        const key = `retired:${span}`;
        if (alreadyReported.has(key)) continue;
        alreadyReported.add(key);
        findings.push({ kind: 'retired-reference', file, detail: `${span} — ${retired.reason}` });
      }
    }

    const classified = classifyPath(span);
    if (!classified) continue;
    if (!resolvePath(classified.path)) {
      if (isExpectedAbsent(classified.path)) continue;
      const key = `missing:${classified.path}`;
      if (alreadyReported.has(key)) continue;
      alreadyReported.add(key);
      findings.push({ kind: 'missing-path', file, detail: `${classified.path} does not exist` });
      continue;
    }
    if (classified.lineRef && !archival) {
      findings.push({
        kind: 'line-reference',
        file,
        detail: `${span} — cite the file or symbol instead; line numbers go stale (AGENTS.md §2)`,
      });
    }
  }
  return findings;
}

export function runCheck({ documents = DOCUMENTS, projectRoot = DEFAULT_ROOT, output = console } = {}) {
  const findings = documents.flatMap((document) => checkDocument(document, { projectRoot }));
  const countOf = (kind) => findings.filter((finding) => finding.kind === kind).length;

  output.log(`Context documents checked: ${documents.length}`);
  for (const finding of findings) {
    output.error(`${finding.kind.toUpperCase()}: ${finding.file} — ${finding.detail}`);
  }
  if (findings.length === 0) {
    output.log('All backticked repo paths resolve; no retired references or stale line numbers.');
  }
  output.log(
    `missing-path=${countOf('missing-path')} retired-reference=${countOf('retired-reference')} ` +
      `line-reference=${countOf('line-reference')} missing-document=${countOf('missing-document')}`,
  );
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // --root points the same rules at a fixture repository; --file overrides the
  // document list. Both exist so the test suite exercises the real CLI path.
  const valueOf = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const projectRoot = valueOf('--root') ? path.resolve(valueOf('--root')) : DEFAULT_ROOT;
  const files = process.argv.flatMap((argument, index) =>
    argument === '--file' && process.argv[index + 1] ? [{ file: process.argv[index + 1] }] : [],
  );
  const findings = runCheck({ projectRoot, ...(files.length > 0 ? { documents: files } : {}) });
  // The exit code belongs to the command, not to the check, so the check stays
  // callable from tests without poisoning their result.
  if (findings.length > 0) process.exitCode = 1;
}
