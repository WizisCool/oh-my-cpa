import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReleasePlan } from './release-plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_TARGETS = ['darwin', 'windows', 'linux', 'freebsd'].flatMap(goos =>
  ['amd64', 'arm64'].map(goarch => ({ goos, goarch })));
const INSTALLATION_FILES = ['compose.full.yml', 'compose.omc.yml', 'cpa.config.example.yaml'];
const ARCHIVE_FILES = ['LICENSE', 'README.md', 'README.zh-CN.md', '.env.example',
  'docs/install.md', 'docs/install-for-agents.md', 'docs/operations.md', 'docs/ops/sqlite-operations.md'];
export const RELEASE_DIRECTORY = path.join(ROOT, 'tmp/native-release');

export function createNativePlan(tag, packageVersion, webVersion) {
  const { version } = createReleasePlan({ tag, packageVersion, webVersion, image: 'wiziscool/oh-my-cpa' });
  return RELEASE_TARGETS.map(({ goos, goarch }) => ({
    goos, goarch,
    binary: `oh-my-cpa${goos === 'windows' ? '.exe' : ''}`,
    archive: `oh-my-cpa_${version}_${goos}_${goarch}.${goos === 'windows' ? 'zip' : 'tar.gz'}`,
    buildArgs: ['build', '-p', '2', '-trimpath', '-buildvcs=false', '-tags', 'timetzdata',
      '-ldflags', `-s -w -X github.com/oh-my-cpa/oh-my-cpa/internal/config.BuildVersion=${tag}`],
  }));
}

export function validateEmbeddedConsole(directory) {
  const index = fs.readFileSync(path.join(directory, 'index.html'), 'utf8');
  const scripts = [...index.matchAll(/<script[^>]+src="([^"]+)"/g)].map(match => match[1]);
  assert.ok(scripts.length > 0, 'Release must embed the built console, not the backend placeholder');
  for (const script of scripts) {
    assert.match(script, /^\.\/assets\/[\w.-]+\.js$/, 'Release console must use local hashed assets');
    assert.ok(fs.statSync(path.join(directory, script)).size > 0, 'Embedded entry script must exist');
  }
}

export function packageNativeArchive(target, staging, output, epoch, execute = execFileSync) {
  const members = [target.binary, ...ARCHIVE_FILES];
  if (target.goos === 'windows') {
    for (const member of members) fs.utimesSync(path.join(staging, member), epoch, epoch);
    execute('zip', ['-X', '-q', path.join(output, target.archive), ...members], { cwd: staging, stdio: 'inherit', env: { ...process.env, TZ: 'UTC' } });
  } else {
    execute('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner',
      '-czf', path.join(output, target.archive), '-C', staging, ...members], { stdio: 'inherit' });
  }
}

function listAssetNames(plan) {
  return [...plan.map(target => target.archive), ...INSTALLATION_FILES].sort();
}

function calculateChecksum(directory, name) {
  assert.ok(fs.lstatSync(path.join(directory, name)).isFile(), 'Release assets must be regular files');
  const bytes = fs.readFileSync(path.join(directory, name));
  assert.ok(bytes.length > 0, 'Release assets must not be empty');
  return createHash('sha256').update(bytes).digest('hex');
}

export function writeReleaseChecksums(directory, plan) {
  const manifest = listAssetNames(plan).map(name => `${calculateChecksum(directory, name)}  ${name}\n`).join('');
  fs.writeFileSync(path.join(directory, 'checksums.txt'), manifest);
}

export function verifyReleaseAssets(directory, plan) {
  assert.deepEqual(fs.readdirSync(directory).sort(), [...listAssetNames(plan), 'checksums.txt'].sort(),
    'Release must contain exactly the full target matrix, installation assets and checksum manifest');
  assert.ok(fs.lstatSync(path.join(directory, 'checksums.txt')).isFile(), 'Checksum manifest must be a regular file');
  const expected = listAssetNames(plan).map(name => `${calculateChecksum(directory, name)}  ${name}\n`).join('');
  assert.equal(fs.readFileSync(path.join(directory, 'checksums.txt'), 'utf8'), expected,
    'Every release asset must match its SHA-256 checksum');
}

export function buildNativeRelease(tag, { root = ROOT, execute = execFileSync } = {}) {
  const output = path.join(root, 'tmp/native-release');
  const plan = createNativePlan(tag,
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    JSON.parse(fs.readFileSync(path.join(root, 'web/package.json'), 'utf8')).version);
  const epoch = Number(execute('git', ['show', '-s', '--format=%ct', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
  assert.ok(Number.isSafeInteger(epoch) && epoch >= 315532800, 'Archive timestamp must be a valid Git commit date');
  // Build once before any Go target: concurrent embedding could capture a half-written SPA.
  execute('pnpm', ['build'], { cwd: root, stdio: 'inherit' });
  validateEmbeddedConsole(path.join(root, 'internal/web/dist'));
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-native-build-'));
  try {
    for (const target of plan) {
      const staging = path.join(stagingRoot, `${target.goos}-${target.goarch}`);
      fs.mkdirSync(staging);
      const executable = path.join(staging, target.binary);
      execute('go', [...target.buildArgs, '-o', executable, './cmd/oh-my-cpa'], {
        cwd: root, stdio: 'inherit', env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
      });
      const metadata = execute('go', ['version', '-m', executable], { encoding: 'utf8' });
      for (const setting of [`GOOS=${target.goos}`, `GOARCH=${target.goarch}`, 'CGO_ENABLED=0']) {
        assert.ok(metadata.includes(`\tbuild\t${setting}\n`), `Release binary must record ${setting}`);
      }
      for (const name of ARCHIVE_FILES.filter(name => name !== '.env.example')) {
        fs.mkdirSync(path.dirname(path.join(staging, name)), { recursive: true });
        fs.copyFileSync(path.join(root, name), path.join(staging, name));
      }
      fs.copyFileSync(path.join(root, 'deploy/native.env.example'), path.join(staging, '.env.example'));
      packageNativeArchive(target, staging, output, epoch, execute);
      console.log(`PACKAGED ${target.goos}/${target.goarch}: ${target.archive} (${summarizeBuildSettings(metadata)})`);
    }
    for (const name of INSTALLATION_FILES) fs.copyFileSync(path.join(root, 'deploy', name), path.join(output, name));
    writeReleaseChecksums(output, plan);
    verifyReleaseAssets(output, plan);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function summarizeBuildSettings(metadata) {
  return metadata.split('\n').filter(line => /\tbuild\t(?:GOOS|GOARCH|CGO_ENABLED)=/.test(line)).map(line => line.trim().split('\t').at(-1)).join(', ');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(argument => argument !== '--verify')) throw new Error('Only --verify is supported');
  if (process.argv.includes('--verify')) {
    const plan = createNativePlan(process.env.RELEASE_TAG,
      JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
      JSON.parse(fs.readFileSync(path.join(ROOT, 'web/package.json'), 'utf8')).version);
    verifyReleaseAssets(RELEASE_DIRECTORY, plan);
    console.log('Verified complete native release assets and SHA-256 checksums');
  } else buildNativeRelease(process.env.RELEASE_TAG);
}
