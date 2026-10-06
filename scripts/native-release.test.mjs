import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { buildNativeRelease, createNativePlan, packageNativeArchive, validateEmbeddedConsole, writeReleaseChecksums, verifyReleaseAssets } from './native-release.mjs';

const ARCHIVE_DOCUMENTS = ['LICENSE', 'README.md', 'README.zh-CN.md', 'docs/install.md',
  'docs/install-for-agents.md', 'docs/operations.md', 'docs/ops/sqlite-operations.md'];
const PLAN = createNativePlan('v0.1.2', '0.1.2', '0.1.2');
function runWithDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omc-release-test-'));
  try { run(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('native matrix is exactly CPA OS/architecture coverage with stable names and injected versions', () => {
  assert.deepEqual(PLAN.map(target => `${target.goos}/${target.goarch}`), [
    'darwin/amd64', 'darwin/arm64', 'windows/amd64', 'windows/arm64',
    'linux/amd64', 'linux/arm64', 'freebsd/amd64', 'freebsd/arm64',
  ]);
  for (const target of PLAN) {
    assert.equal(target.binary, target.goos === 'windows' ? 'oh-my-cpa.exe' : 'oh-my-cpa');
    assert.equal(target.archive, `oh-my-cpa_0.1.2_${target.goos}_${target.goarch}.${target.goos === 'windows' ? 'zip' : 'tar.gz'}`);
    assert.ok(target.buildArgs.includes('timetzdata'));
    assert.ok(target.buildArgs.includes('-s -w -X github.com/oh-my-cpa/oh-my-cpa/internal/config.BuildVersion=v0.1.2'));
  }
  for (const tag of ['v0.1.2-rc.1', 'v01.1.2', '0.1.2', 'v0.1.2\nbad']) {
    assert.throws(() => createNativePlan(tag, '0.1.2', '0.1.2'));
  }
  assert.throws(() => createNativePlan('v0.1.2', '0.1.1', '0.1.2'));
  assert.throws(() => createNativePlan('v0.1.2', '0.1.2', '0.1.1'));
});

test('native packaging refuses a placeholder, missing entry or external script', () => runWithDirectory(directory => {
  for (const html of ['<html>backend placeholder</html>', '<script src="https://cdn.example/entry.js"></script>',
    '<script src="./assets/missing.js"></script>']) {
    fs.writeFileSync(path.join(directory, 'index.html'), html);
    assert.throws(() => validateEmbeddedConsole(directory));
  }
  fs.mkdirSync(path.join(directory, 'assets'));
  fs.writeFileSync(path.join(directory, 'assets/entry-hash.js'), 'console.log("built")');
  fs.writeFileSync(path.join(directory, 'index.html'), '<script type="module" src="./assets/entry-hash.js"></script>');
  validateEmbeddedConsole(directory);
}));

test('release integrity rejects missing, unexpected, empty, symlinked or corrupt assets', () => runWithDirectory(directory => {
  const names = [...PLAN.map(target => target.archive), 'compose.full.yml', 'compose.omc.yml', 'cpa.config.example.yaml'];
  for (const name of names) fs.writeFileSync(path.join(directory, name), name);
  writeReleaseChecksums(directory, PLAN);
  verifyReleaseAssets(directory, PLAN);
  const victim = path.join(directory, names[0]);
  for (const content of ['changed', '']) {
    fs.writeFileSync(victim, content);
    assert.throws(() => verifyReleaseAssets(directory, PLAN));
  }
  fs.unlinkSync(victim);
  assert.throws(() => verifyReleaseAssets(directory, PLAN));
  fs.symlinkSync(path.join(directory, names[1]), victim);
  assert.throws(() => verifyReleaseAssets(directory, PLAN));
  fs.unlinkSync(victim);
  fs.writeFileSync(victim, names[0]);
  fs.writeFileSync(path.join(directory, 'extra.tar.gz'), 'unexpected');
  assert.throws(() => verifyReleaseAssets(directory, PLAN));
  fs.unlinkSync(path.join(directory, 'extra.tar.gz'));
  fs.appendFileSync(path.join(directory, 'checksums.txt'), '../unsafe\n');
  assert.throws(() => verifyReleaseAssets(directory, PLAN));
}));

test('tar and zip archives extract the exact payload with executable permission on Unix', () => runWithDirectory(directory => {
  for (const goos of ['linux', 'windows']) {
    const target = PLAN.find(target => target.goos === goos);
    const staging = path.join(directory, goos);
    fs.mkdirSync(staging);
    for (const name of [target.binary, ...ARCHIVE_DOCUMENTS, '.env.example']) {
      fs.mkdirSync(path.dirname(path.join(staging, name)), { recursive: true });
      fs.writeFileSync(path.join(staging, name), name, { mode: name === target.binary ? 0o755 : 0o644 });
    }
    packageNativeArchive(target, staging, directory, 1720000000);
    const extracted = path.join(directory, `${goos}-extracted`);
    fs.mkdirSync(extracted);
    if (goos === 'windows') execFileSync('unzip', ['-q', path.join(directory, target.archive), '-d', extracted]);
    else execFileSync('tar', ['-xzf', path.join(directory, target.archive), '-C', extracted]);
    assert.deepEqual(fs.readdirSync(extracted, { recursive: true }).sort(), fs.readdirSync(staging, { recursive: true }).sort());
    for (const name of [...ARCHIVE_DOCUMENTS, '.env.example']) assert.equal(fs.readFileSync(path.join(extracted, name), 'utf8'), name);
    assert.equal(fs.readFileSync(path.join(extracted, target.binary), 'utf8'), target.binary);
    if (goos !== 'windows') assert.equal(fs.statSync(path.join(extracted, target.binary)).mode & 0o777, 0o755);
  }
}));

test('native environment template preserves embedded identity and requires operator-owned secrets', () => {
  const source = fs.readFileSync(new URL('../deploy/native.env.example', import.meta.url), 'utf8');
  assert.ok(!source.includes('OMCPA_VERSION='));
  assert.ok(source.includes('OMCPA_LISTEN_ADDR=127.0.0.1:8080'));
  assert.ok(source.includes('OMCPA_DATA_DIR=./data'));
  assert.ok(source.includes('OMCPA_MASTER_KEY=replace-me'));
  const placeholder = /^OMCPA_MASTER_KEY=(.+)$/m.exec(source)[1];
  assert.ok(placeholder.length < 32, 'Template must fail key validation until the operator supplies a key');
  assert.ok(source.includes('OMCPA_CPA_MANAGEMENT_KEY=replace-with-'));
});


test('native builder embeds once before all Go targets, cleans stale files and pins target environments', () => runWithDirectory(root => {
  fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  fs.mkdirSync(path.join(root, 'deploy'));
  fs.mkdirSync(path.join(root, 'tmp/native-release'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp/native-release', 'stale.tar.gz'), 'stale');
  for (const directory of [root, path.join(root, 'web')]) {
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '0.1.2' }));
  }
  for (const name of ARCHIVE_DOCUMENTS) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), name);
  }
  for (const name of ['native.env.example', 'compose.full.yml', 'compose.omc.yml', 'cpa.config.example.yaml']) {
    fs.writeFileSync(path.join(root, 'deploy', name), name);
  }
  const commands = [];
  const execute = (command, args, options) => {
    commands.push({ command, args, options });
    if (command === 'git') return '1720000000\n';
    if (command === 'pnpm') {
      const consoleDirectory = path.join(root, 'internal/web/dist');
      fs.mkdirSync(path.join(consoleDirectory, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(consoleDirectory, 'index.html'), '<script src="./assets/index-hash.js"></script>');
      fs.writeFileSync(path.join(consoleDirectory, 'assets/index-hash.js'), 'built console');
      return;
    }
    if (command === 'go' && args[0] === 'build') {
      assert.ok(fs.existsSync(path.join(root, 'internal/web/dist/index.html')));
      assert.equal(options.env.CGO_ENABLED, '0');
      const target = PLAN.find(target => target.goos === options.env.GOOS && target.goarch === options.env.GOARCH);
      assert.ok(target);
      assert.ok(args.includes('timetzdata'));
      assert.deepEqual(args.slice(0, target.buildArgs.length), target.buildArgs);
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'executable', { mode: 0o755 });
      return;
    }
    if (command === 'go' && args[0] === 'version') {
      const build = commands.findLast(entry => entry.command === 'go' && entry.args[0] === 'build');
      return `\tbuild\tCGO_ENABLED=0\n\tbuild\tGOOS=${build.options.env.GOOS}\n\tbuild\tGOARCH=${build.options.env.GOARCH}\n`;
    }
    return execFileSync(command, args, options);
  };
  buildNativeRelease('v0.1.2', { root, execute });
  assert.equal(commands.filter(entry => entry.command === 'pnpm').length, 1);
  const buildCommands = commands.filter(entry => entry.command === 'go' && entry.args[0] === 'build');
  assert.deepEqual(buildCommands.map(entry => `${entry.options.env.GOOS}/${entry.options.env.GOARCH}`),
    PLAN.map(target => `${target.goos}/${target.goarch}`));
  assert.ok(commands.findIndex(entry => entry.command === 'pnpm') < commands.findIndex(entry => entry.command === 'go'));
  verifyReleaseAssets(path.join(root, 'tmp/native-release'), PLAN);
  let hasExecuted = false;
  assert.throws(() => buildNativeRelease('v0.1.3', { root, execute: () => { hasExecuted = true; } }));
  assert.equal(hasExecuted, false, 'Invalid identity must fail before frontend or Go execution');
  assert.throws(() => buildNativeRelease('v0.1.2', { root, execute: (command, args, options) => {
    if (command === 'go' && args[0] === 'build') throw new Error('Unsupported dependency target');
    return execute(command, args, options);
  } }), /Unsupported dependency target/);
  assert.equal(fs.existsSync(path.join(root, 'tmp/native-release/checksums.txt')), false,
    'A failed target must remove the prior output and cannot leave a publishable manifest');
}));
