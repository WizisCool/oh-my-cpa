/**
 * Decides which CI lanes a run needs, from the files it changes.
 *
 * A pull request runs the lanes its paths reach; a push to master, the nightly run, a
 * manual run, and the integration pull request from `next` run everything. Anything this
 * file does not recognise reaches both the Go and the web lanes, so an unfamiliar path
 * costs a slower run rather than an unchecked one.
 *
 * Prints `go=`, `web=` and `full=` lines for `$GITHUB_OUTPUT`.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SHARED = /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|tsconfig\.tooling\.json|scripts\/tools-versions\.json|\.github\/workflows\/ci\.yml|scripts\/ci-scope\.mjs)$/;
// Go tests also read a few files outside the module: the console's public assets, the
// committed demonstration dataset and the shared API contract fixtures.
const GO = /(?:\.go$|^go\.(?:mod|sum)$|^\.golangci\.yml$|^(?:internal|cmd|migrations)\/|^scripts\/fixture\/|^scripts\/fake-cpa\.mjs$|^scripts\/browser-acceptance\.mjs$|^web\/public\/|^web\/index\.html$|^deploy\/cloudflare\/data\/|^scripts\/acceptance\/contracts\/)/;
const WEB = /^(?:web\/|scripts\/acceptance\/|scripts\/testing\/|scripts\/test-[^/]+\.(?:ts|mjs)$|scripts\/check-ui|scripts\/browser-acceptance\.mjs$|deploy\/cloudflare\/)/;
// Paths only the repository lane reads: prose, the plugin registry (validated there by its
// own Go test), workflow and repository scripts. The repository lane runs on every event, so naming them here is what keeps a
// documentation change from paying for a browser.
const REPOSITORY = /(?:\.md$|^docs\/|^plugins\/|^\.github\/|^scripts\/[^/]+\.(?:mjs|ts|json)$|^deploy\/[^/]+\.ya?ml$|^LICENSE|^\.coderabbit\.yaml$|^\.gitignore$|^\.gitattributes$)/;

export function scopeOf(files) {
  let isGo = false;
  let isWeb = false;
  for (const file of files) {
    if (SHARED.test(file)) return { go: true, web: true };
    const isGoFile = GO.test(file);
    const isWebFile = WEB.test(file);
    if (isGoFile) isGo = true;
    if (isWebFile) isWeb = true;
    if (!isGoFile && !isWebFile && !REPOSITORY.test(file)) return { go: true, web: true };
  }
  return { go: isGo, web: isWeb };
}

function isFullRun(env) {
  if (env.EVENT !== 'pull_request' && env.EVENT !== 'push') return true;
  if (env.EVENT === 'push' && env.REF === 'refs/heads/master') return true;
  if (env.EVENT === 'pull_request' && env.HEAD_REF === 'next') return true;
  return JSON.parse(env.LABELS || '[]').includes('full-ci');
}

function changedFiles(base) {
  if (!base || /^0+$/.test(base)) return undefined;
  try {
    return execFileSync('git', ['diff', '--name-only', '--no-renames', `${base}...HEAD`], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch {
    return undefined;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const isFull = isFullRun(process.env);
  const files = isFull ? undefined : changedFiles(process.env.BASE);
  // A base that cannot be diffed (a new branch, a force push) is treated as a full run.
  const scope = files ? scopeOf(files) : { go: true, web: true };
  const full = isFull || !files;
  console.log(`go=${scope.go || full}`);
  console.log(`web=${scope.web || full}`);
  console.log(`full=${full}`);
  console.error(`[ci-scope] ${files ? `${files.length} changed files` : 'full run'}: go=${scope.go || full} web=${scope.web || full} full=${full}`);
}
