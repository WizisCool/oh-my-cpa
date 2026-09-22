import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * Reclaims Vercel Container Registry images that no deployment can use any more.
 *
 * Why this exists rather than a setting: Vercel pushes one registry image per deployment, the
 * registry deduplicates nothing, and its deployment retention policy does not cover the
 * registry - the two are metered separately, and a registry image outlives the deployment that
 * produced it. A Hobby project may hold 50 images per repository, so a repository that deploys
 * on every push reaches that ceiling and every later build then fails at its last step with
 * `repository has reached the maximum allowed number of images`. No amount of build
 * configuration can fix that; the quota has to be reclaimed, and the platform offers no
 * garbage collection for it. This script is that collection.
 *
 * What it keeps, and how it decides:
 *
 *   1. The image behind the deployment that is currently production - found as the newest
 *      *successful* production deployment, which is the one the production domain serves. This
 *      is the deletion that would take the demonstration offline, so it is excluded by
 *      construction rather than by a threshold.
 *   2. `--keep-aliased` also keeps the image behind every deployment a live alias points at.
 *      Off by default: those aliases belong to branch previews, and a repository that has
 *      stopped deploying previews accumulates them as dead links whose images are pure residue.
 *   3. `--keep N` also keeps the newest N images, so a rollback has a target.
 *
 * Everything else is a superseded build whose only remaining use is the disk it occupies.
 *
 * The consequence of the default is worth stating plainly, because it is a real trade-off and
 * not an oversight: with only the production image kept, the previous production deployment
 * cannot be rolled back to without a rebuild. `--keep 10` buys that ability back for about
 * 120MB of a 50-image budget.
 *
 * The link from a deployment to its image is the commit: each deployment records
 * `meta.githubCommitSha`, and the registry tags its image with that same short SHA. Aliases are
 * therefore resolved to deployments, deployments to SHAs, and SHAs to image tags.
 *
 * The default is a dry run. Deleting a registry image is irreversible - the deployment that
 * used it cannot be redeployed without rebuilding - so the plan is printed and `--apply` is
 * required to carry it out.
 */

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERCEL_TIMEOUT_MS = 120_000;

/**
 * The CLI version this script is written against.
 *
 * This script reads the CLI's JSON, so an unpinned `npx vercel` would mean the shapes it parses
 * are whatever the registry served that day - and the failure mode of a shape change is a wrong
 * deletion rather than an error. The rest of the repository pins its tools exactly for the same
 * reason.
 */
const VERCEL_CLI = 'vercel@59.25.0';

/**
 * Runs the Vercel CLI and parses its JSON output.
 *
 * `--project` is always passed: the CLI's registry subcommands refuse to run without a linked
 * project, the link lives in `.vercel/` which is gitignored, and a clean checkout therefore has
 * none. Naming the project explicitly keeps the script working from a fresh clone and in CI, and
 * makes it immune to whatever a developer happens to have linked locally.
 */
async function vercelJson(args) {
  const { stdout } = await run('npx', ['--yes', VERCEL_CLI, ...args, '--format', 'json'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    timeout: VERCEL_TIMEOUT_MS,
    env: process.env,
  });
  // Some subcommands print progress before the payload, so the JSON is located by its first
  // bracket rather than assumed to begin at byte zero.
  const start = stdout.search(/[[{]/);
  if (start < 0) throw new Error(`no JSON in the output of: vercel ${args.join(' ')}`);
  return JSON.parse(stdout.slice(start));
}

/** Runs the Vercel CLI for its effect. */
async function vercel(args) {
  await run('npx', ['--yes', VERCEL_CLI, ...args], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    timeout: VERCEL_TIMEOUT_MS,
    env: process.env,
  });
}

function parseArgs(argv) {
  const options = { apply: false, keep: 0, repository: 'demo', project: 'oh-my-cpa-demo', json: false, keepAliased: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--keep-aliased') options.keepAliased = true;
    else if (arg === '--keep') {
      const value = Number.parseInt(argv[index + 1] ?? '', 10);
      if (!Number.isInteger(value) || value < 0) throw new Error('--keep requires a non-negative integer');
      options.keep = value;
      index += 1;
    } else if (arg === '--project') {
      options.project = argv[index + 1] ?? '';
      if (!options.project) throw new Error('--project requires a name');
      index += 1;
    } else if (arg === '--repository') {
      options.repository = argv[index + 1] ?? '';
      if (!options.repository) throw new Error('--repository requires a name');
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** Every recent deployment, newest first, as `{ url, sha, state, target }`. */
async function listDeployments() {
  const payload = await vercelJson(['list', '--all']);
  const rows = Array.isArray(payload) ? payload : (payload.deployments ?? []);
  return rows.map((row) => ({
    url: row.url ?? '',
    sha: row.meta?.githubCommitSha ?? '',
    state: row.state ?? '',
    target: row.target ?? '',
  })).filter((row) => row.url);
}

/**
 * The deployment each live alias points at.
 *
 * An alias is what makes a deployment reachable, so it - not the deployment's own state - is
 * the evidence that an image still matters.
 */
async function liveAliasDeployments() {
  const payload = await vercelJson(['alias', 'ls']);
  const rows = Array.isArray(payload) ? payload : (payload.aliases ?? []);
  const urls = new Set();
  for (const row of rows) {
    const url = typeof row.url === 'string' ? row.url : row.deployment?.url;
    if (url) urls.add(url);
  }
  return urls;
}

/** Images in the registry, newest first, as `{ id, shortTags, sizeBytes, created }`. */
async function listImages(repository, project) {
  const payload = await vercelJson(['vcr', 'image', 'ls', repository, '--project', project]);
  const rows = Array.isArray(payload) ? payload : (payload.images ?? []);
  return rows.map((row) => ({
    id: row.id ?? row.imageId,
    tags: row.tags ?? [],
    // The registry tags an image with the short commit SHA, which is what links it to a
    // deployment.
    shaTags: (row.tags ?? []).map((tag) => String(tag).slice(0, 12)),
    sizeBytes: row.sizeInBytes ?? 0,
    created: row.createdAt ?? '',
  })).filter((image) => image.id);
}

function formatBytes(bytes) {
  if (!bytes) return '';
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  const [images, deployments, aliasedUrls] = await Promise.all([
    listImages(options.repository, options.project),
    listDeployments(),
    liveAliasDeployments(),
  ]);

  const liveShas = new Set();
  const liveReason = new Map();

  // Production is the newest deployment with `target: production` that actually built. A failed
  // one stays listed with that target and never produces an image, so taking the newest without
  // checking its state would name an image that does not exist while missing the one serving
  // traffic.
  const productionDeployment = deployments.find(
    (deployment) => deployment.target === 'production' && deployment.state === 'READY' && deployment.sha,
  );
  if (!productionDeployment) {
    throw new Error('no successful production deployment found; refusing to guess which image is live');
  }
  const productionSha = productionDeployment.sha.slice(0, 12);
  liveShas.add(productionSha);
  liveReason.set(productionSha, `production (${productionDeployment.url})`);

  if (options.keepAliased) {
    for (const deployment of deployments) {
      if (!deployment.sha || !aliasedUrls.has(deployment.url)) continue;
      const short = deployment.sha.slice(0, 12);
      liveShas.add(short);
      if (!liveReason.has(short)) liveReason.set(short, 'serves a live alias');
    }
  }

  const decisions = images.map((image, index) => {
    const reasons = [];
    for (const sha of image.shaTags) {
      if (liveShas.has(sha)) {
        reasons.push(liveReason.get(sha) ?? 'still reachable');
        break;
      }
    }
    if (!reasons.length && index < options.keep) reasons.push(`within the newest ${options.keep}`);
    return { image, keep: reasons.length > 0, reasons };
  });

  const kept = decisions.filter((decision) => decision.keep);
  const pruned = decisions.filter((decision) => !decision.keep);
  const reclaimableBytes = pruned.reduce((total, decision) => total + decision.image.sizeBytes, 0);

  if (options.json) {
    console.log(JSON.stringify({
      repository: options.repository,
      totalImages: images.length,
      productionDeployment: productionDeployment.url,
      productionSha,
      kept: kept.map((decision) => ({ id: decision.image.id, tags: decision.image.tags, reasons: decision.reasons })),
      prune: pruned.map((decision) => ({ id: decision.image.id, tags: decision.image.tags })),
      reclaimableBytes,
      applied: options.apply,
    }, null, 2));
  } else {
    console.log(`repository ${options.repository}: ${images.length} image(s)`);
    console.log(`\nkeeping ${kept.length}`);
    for (const decision of kept) {
      console.log(`  ${decision.image.id} [${decision.image.tags.join(', ') || 'untagged'}] — ${decision.reasons.join('; ')}`);
    }
    console.log(`\nreclaiming ${pruned.length} (${formatBytes(reclaimableBytes)})`);
    for (const decision of pruned.slice(0, 20)) {
      console.log(`  ${decision.image.id} [${decision.image.tags.join(', ') || 'untagged'}] ${formatBytes(decision.image.sizeBytes)}`);
    }
    if (pruned.length > 20) console.log(`  … and ${pruned.length - 20} more`);
  }

  if (!options.apply) {
    if (!options.json) {
      console.log(`\ndry run: nothing deleted. Re-run with --apply to reclaim the ${pruned.length} image(s) above.`);
    }
    return;
  }

  let removed = 0;
  for (const decision of pruned) {
    try {
      await vercel(['vcr', 'image', 'rm', options.repository, decision.image.id, '--project', options.project, '--yes']);
      removed += 1;
    } catch (error) {
      // A single refusal must not abandon the rest: the quota is the reason this runs, and
      // stopping at the first failure would leave it as full as it started.
      console.error(`could not delete ${decision.image.id}: ${error.message}`);
    }
  }
  console.log(`reclaimed ${removed} of ${pruned.length} image(s)`);
  if (removed !== pruned.length) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  // A usage error or a missing deployment is an expected outcome of running this by hand, so it is
  // reported as a sentence rather than as a stack trace. The stack is still available when the
  // caller is debugging, which is what --debug is for in the surrounding tooling.
  console.error(`prune-vcr-images: ${error.message}`);
  process.exitCode = 1;
}
