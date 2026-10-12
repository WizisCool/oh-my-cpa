/**
 * Regenerates the sharded Sarasa Mono SC under `web/src/assets/fonts/sarasa/`.
 *
 * The source TTFs come from SARASA_FONT_DIR when it is set, and otherwise from the pinned
 * npm release below, cached in `tmp/fonts/` and checked against its integrity hash on
 * every run. Subsetting needs fontTools (`pip install fonttools brotli`) for `pyftsubset`.
 * See `scripts/font-shards.mjs` for how the font is cut and why.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  CORE_CSS_FILE,
  FONT_DIRECTORY,
  FONT_FAMILY,
  FONT_WEIGHTS,
  LOCAL_NAMES,
  MANIFEST_FILE,
  SHARD_URLS_FILE,
  collectSourceCharacters,
  formatUnicodeRange,
  planShards,
  readSfntCodePoints,
  renderCoreCss,
  renderShardUrlsModule,
  shardFileName,
} from './font-shards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runFile = promisify(execFile);

const SOURCE_PACKAGE = {
  label: 'Sarasa Mono SC 0.36.0 (@fontpkg/sarasa-mono-sc@0.36.0)',
  tarball: 'https://registry.npmjs.org/@fontpkg/sarasa-mono-sc/-/sarasa-mono-sc-0.36.0.tgz',
  integrity: 'sha512-+4yD9Yez9fCgmshLWm8HaMhQZlsgqib4dgGl0jWLslZtRCkRrBIHIoTJ6kUDDafhuJdjLZnTLXb6mOd9EF0jLg==',
};
const SOURCE_FILES = { 400: 'sarasa-mono-sc-regular.ttf', 700: 'sarasa-mono-sc-bold.ttf' };

function isVerifiedArchive(archive) {
  return `sha512-${createHash('sha512').update(archive).digest('base64')}` === SOURCE_PACKAGE.integrity;
}

/**
 * The pinned release, extracted fresh into `workDirectory` on every run. Only the archive is
 * cached, and it is re-verified each time: an interrupted extraction or an edited cache can
 * never become the source of committed shards.
 */
async function downloadSource(workDirectory) {
  const cacheDirectory = path.join(root, 'tmp', 'fonts');
  const archivePath = path.join(cacheDirectory, 'source.tgz');
  if (!fs.existsSync(archivePath) || !isVerifiedArchive(fs.readFileSync(archivePath))) {
    fs.mkdirSync(cacheDirectory, { recursive: true });
    console.log(`[font-subset] Downloading ${SOURCE_PACKAGE.tarball}`);
    const response = await fetch(SOURCE_PACKAGE.tarball);
    if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (!isVerifiedArchive(archive)) throw new Error('the downloaded archive does not match its pinned integrity hash');
    fs.writeFileSync(archivePath, archive);
  }
  execFileSync('tar', ['-xzf', archivePath, '-C', workDirectory, ...FONT_WEIGHTS.map((weight) => `package/${SOURCE_FILES[weight]}`)]);
  return path.join(workDirectory, 'package');
}

async function resolveSources(workDirectory) {
  const directory = process.env.SARASA_FONT_DIR || await downloadSource(workDirectory);
  const label = process.env.SARASA_FONT_DIR ? `Sarasa Mono SC from ${path.basename(directory)}` : SOURCE_PACKAGE.label;
  const sources = Object.fromEntries(FONT_WEIGHTS.map((weight) => {
    const file = path.join(directory, SOURCE_FILES[weight]);
    if (!fs.existsSync(file)) throw new Error(`${file} not found; SARASA_FONT_DIR must hold ${Object.values(SOURCE_FILES).join(' and ')}`);
    return [weight, file];
  }));
  return { label, sources };
}

/** Runs `tasks` with at most `limit` in flight; on a failure, starts no more and waits for the rest. */
async function runLimited(tasks, limit) {
  let next = 0;
  let failure;
  const workers = Array.from({ length: limit }, async () => {
    while (failure === undefined && next < tasks.length) {
      try {
        await tasks[next++]();
      } catch (error) {
        failure ??= error;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== undefined) throw failure;
}

// Each pyftsubset process loads a whole ~25 MiB CJK font, so a many-core machine is still
// held to a few at a time.
const SUBSET_CONCURRENCY = Math.min(os.availableParallelism(), 4);

// Inside the repository's tmp/ rather than the system's, so the finished directory can be renamed
// into place: a rename is atomic only within one filesystem.
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
const workDirectory = fs.mkdtempSync(path.join(root, 'tmp', 'font-subset-'));
const outputDirectory = path.join(root, FONT_DIRECTORY);
const GENERATED_FILE = /\.woff2$|^(?:manifest\.json|core\.css|shardUrls\.ts)$/;
let shardCount = 0;
let totalBytes = 0;
let shouldKeepWorkDirectory = false;
try {
  const resolved = await resolveSources(workDirectory);
  const { label } = resolved;
  const { sources } = resolved;
  const codePointSets = FONT_WEIGHTS.map((weight) => readSfntCodePoints(fs.readFileSync(sources[weight])));
  // One plan serves every weight, so a character's shard never depends on its weight.
  if (codePointSets.some((codePoints) => codePoints.size !== codePointSets[0].size || [...codePoints].some((codePoint) => !codePointSets[0].has(codePoint)))) {
    throw new Error('the source weights cover different characters');
  }
  const plan = planShards(codePointSets[0], collectSourceCharacters(root));
  console.log(`[font-subset] ${codePointSets[0].size} characters in ${plan.length} shards per weight`);

  // The whole directory is built beside the work files - every shard, the manifest, the core
  // stylesheet, the URL module and the files kept from the committed directory, such as the
  // licence - and then swapped in at once, so the committed font is never half replaced.
  const stagedDirectory = path.join(workDirectory, 'sarasa');
  fs.mkdirSync(stagedDirectory);
  if (fs.existsSync(outputDirectory)) {
    for (const file of fs.readdirSync(outputDirectory)) {
      if (!GENERATED_FILE.test(file)) fs.copyFileSync(path.join(outputDirectory, file), path.join(stagedDirectory, file));
    }
  }
  const tasks = FONT_WEIGHTS.flatMap((weight) => plan.map((shard) => async () => {
    const unicodesFile = path.join(workDirectory, `${weight}-${shard.name}.txt`);
    fs.writeFileSync(unicodesFile, shard.codePoints.map((codePoint) => codePoint.toString(16)).join('\n'));
    await runFile('pyftsubset', [
      sources[weight],
      `--unicodes-file=${unicodesFile}`,
      `--output-file=${path.join(stagedDirectory, shardFileName(weight, shard.name))}`,
      '--flavor=woff2',
      '--layout-features=*',
      '--no-hinting',
      '--desubroutinize',
    ]);
  }));
  await runLimited(tasks, SUBSET_CONCURRENCY);

  const manifest = {
    family: FONT_FAMILY,
    source: label,
    weights: FONT_WEIGHTS,
    local: LOCAL_NAMES,
    shards: plan.map((shard) => ({ name: shard.name, unicodeRange: formatUnicodeRange(shard.codePoints) })),
  };
  fs.writeFileSync(path.join(stagedDirectory, path.basename(MANIFEST_FILE)), `${JSON.stringify(manifest, null, 1)}\n`);
  fs.writeFileSync(path.join(stagedDirectory, path.basename(CORE_CSS_FILE)), renderCoreCss(manifest));
  fs.writeFileSync(path.join(stagedDirectory, path.basename(SHARD_URLS_FILE)), renderShardUrlsModule(manifest));
  shardCount = plan.length * FONT_WEIGHTS.length;
  totalBytes = fs.readdirSync(stagedDirectory).filter((file) => file.endsWith('.woff2'))
    .reduce((total, file) => total + fs.statSync(path.join(stagedDirectory, file)).size, 0);

  const previousDirectory = path.join(workDirectory, 'previous');
  if (fs.existsSync(outputDirectory)) fs.renameSync(outputDirectory, previousDirectory);
  try {
    fs.renameSync(stagedDirectory, outputDirectory);
  } catch (error) {
    if (fs.existsSync(previousDirectory)) {
      try {
        fs.renameSync(previousDirectory, outputDirectory);
      } catch {
        shouldKeepWorkDirectory = true;
        throw new Error(`installing the font failed and the previous font could not be restored; it is in ${previousDirectory}`, { cause: error });
      }
    }
    throw error;
  }
} finally {
  if (!shouldKeepWorkDirectory) fs.rmSync(workDirectory, { recursive: true, force: true });
}

console.log(`[font-subset] Wrote ${shardCount} shards (${(totalBytes / 1024 / 1024).toFixed(1)} MiB), the manifest, the core stylesheet and the URL module.`);
