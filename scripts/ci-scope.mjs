/**
 * Decides which CI lanes a run needs from the changed files.
 *
 * A pull request runs only the lanes its paths reach; main pushes, merge queues,
 * scheduled runs, manual dispatches, and `full-ci` PRs run full verification.
 * Anything unrecognized widens to every lane so an unfamiliar path never skips a check.
 *
 * Prints `go=`, `frontend=`, `browser=`, `docker=`, and `full=` lines for `$GITHUB_OUTPUT`.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARED_INPUTS = /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.node-version|\.nvmrc|tsconfig\.tooling\.json|scripts\/tools-versions\.json|\.github\/workflows\/ci\.yml|\.github\/actions\/.*|scripts\/ci-scope\.(?:mjs|test\.mjs))$/;

const DOCKER_INPUTS = /^(?:Dockerfile|\.dockerignore|deploy\/(?:base-path|healthcheck)\.sh)$/;
const GO_ONLY = /(?:\.go$|^go\.(?:mod|sum)$|^\.golangci\.yml$|^\.swaggo$|^(?:cmd|internal|migrations)\/|^scripts\/fixture\/)/;
const GO_CROSS_FRONTEND = /^(?:internal\/(?:api|demo|domain|web)\/|migrations\/|^\.swaggo$|go\.(?:mod|sum)$)/;
const OPENAPI_SPEC = /^docs\/openapi\/swagger\.json$/;
const GO_READS_WEB = /^(?:scripts\/acceptance\/contracts\/|web\/public\/|web\/index\.html$)/;
const WEB = /^(?:web\/|vitest\.config\.[cm]?[jt]s$|deploy\/(?:cloudflare|site)\/|scripts\/acceptance\/|scripts\/(?:api-target|browser-acceptance|build-demo|build-site|compact-locales|dev-base-redirect|fake-cpa|generate-demo-data|install-chromium|check-bundle-budget|sync-web-dist|sync-lobe-icons|bundle-[^/]+|generate-lucide-icons|sync-lobe-icon-catalog|sync-brand)\.(?:mjs|ts|json)$)/;
const DEPLOY_OR_WORKFLOW = /^(?:deploy\/[^/]+\.ya?ml$|deploy\/native\.env\.example$|\.env\.example$|\.github\/workflows\/.+\.ya?ml$)/;
const SCRIPTS_OTHER = /^scripts\/.+/;
// Always verified by the unconditional `static-repo` lane (workflow lint, docs links, secret scan).
const REPO_HYGIENE = /(?:^[^/]+\.md$|^docs\/|^\.coderabbit\.yaml$|^lychee\.toml$|^gitleaks\.toml$|^LICENSE$|^\.(?:editorconfig|gitignore|gitattributes)$|^\.github\/(?:CODEOWNERS|ISSUE_TEMPLATE\/.*|PULL_REQUEST_TEMPLATE(?:\.md|\/.*))$)/;

export function scopeOf(files) {
  let go = false;
  let frontend = false;
  let browser = false;
  let docker = false;

  for (const file of files) {
    if (SHARED_INPUTS.test(file)) {
      return { go: true, frontend: true, browser: true, docker: true };
    }
    let matched = false;
    if (DOCKER_INPUTS.test(file)) {
      docker = true;
      matched = true;
    }
    if (GO_ONLY.test(file)) {
      go = true;
      browser = true;
      if (GO_CROSS_FRONTEND.test(file)) frontend = true;
      matched = true;
    }
    if (GO_READS_WEB.test(file)) {
      go = true;
      frontend = true;
      browser = true;
      matched = true;
    }
    if (WEB.test(file)) {
      frontend = true;
      browser = true;
      matched = true;
    }
    if (DEPLOY_OR_WORKFLOW.test(file)) {
      frontend = true;
      matched = true;
    }
    if (SCRIPTS_OTHER.test(file)) {
      frontend = true;
      if (file === 'scripts/docker-smoke.mjs') docker = true;
      matched = true;
    }
    if (OPENAPI_SPEC.test(file)) {
      go = true;
      frontend = true;
      matched = true;
    }
    if (!matched && REPO_HYGIENE.test(file)) {
      matched = true;
    }
    if (!matched) {
      return { go: true, frontend: true, browser: true, docker: true };
    }
  }

  return { go, frontend, browser, docker };
}

function changedFiles(base, execute = execFileSync) {
  if (!base || /^0+$/.test(base)) return undefined;
  try {
    return execute('git', ['diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`], { encoding: 'utf8' })
      .split('\0').filter(Boolean);
  } catch {
    return undefined;
  }
}

export function decideRunScope(env, execute = execFileSync) {
  const labels = (() => {
    try {
      const parsed = JSON.parse(env.LABELS || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();

  const isMainPush = env.EVENT === 'push' && env.REF === 'refs/heads/main';
  const isPullRequest = env.EVENT === 'pull_request';
  const hasFullLabel = isPullRequest && labels.includes('full-ci');
  const isFull = !isPullRequest || hasFullLabel;

  if (hasFullLabel || env.EVENT === 'schedule' || env.EVENT === 'workflow_dispatch') {
    return { go: true, frontend: true, browser: true, docker: true, full: true, fileCount: null };
  }

  const files = changedFiles(env.BASE, execute);
  if (!files) {
    return { go: true, frontend: true, browser: true, docker: true, full: true, fileCount: null };
  }

  const scope = scopeOf(files);
  if (isMainPush || isFull) {
    return { go: true, frontend: true, browser: true, docker: scope.docker, full: true, fileCount: files.length };
  }
  return { ...scope, full: false, fileCount: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = decideRunScope(process.env);
  for (const key of ['go', 'frontend', 'browser', 'docker', 'full']) {
    console.log(`${key}=${result[key]}`);
  }
  const origin = result.fileCount === null ? 'full run' : `${result.fileCount} changed files`;
  console.error(`[ci-scope] ${origin}: go=${result.go} frontend=${result.frontend} browser=${result.browser} docker=${result.docker} full=${result.full}`);
}
