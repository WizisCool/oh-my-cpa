import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versions = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'tools-versions.json'), 'utf8'));
const strict = process.argv.includes('--strict');
const failures = [];
const warnings = [];

function command(command, args = []) {
  try {
    return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    return `ERROR:${error.message}`;
  }
}

function packageVersion(packageName) {
  return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', packageName, 'package.json'), 'utf8')).version;
}

function check(label, actual, expected, exact = true) {
  const ok = exact ? actual === expected : actual.startsWith(expected);
  if (ok) {
    console.log(`OK    ${label}: ${actual}`);
    return;
  }
  const message = `${label}: found ${actual}, expected ${exact ? expected : `${expected}.x`}`;
  (strict ? failures : warnings).push(message);
  console[strict ? 'error' : 'warn'](`${strict ? 'FAIL' : 'WARN'}  ${message}`);
}

const nodeVersion = process.versions.node;
const goOutput = command('go', ['version']);
const goVersion = goOutput.match(/go([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] ?? goOutput;
const pnpmVersion = process.platform === 'win32'
  ? command('cmd.exe', ['/d', '/s', '/c', 'pnpm --version'])
  : command('pnpm', ['--version']);

check('Node.js', nodeVersion, versions.node.version);
check('Go', goVersion, versions.go.version);
check('pnpm', pnpmVersion, versions.pnpm.version);
check('@ant-design/cli', packageVersion('@ant-design/cli'), versions.antDesignCli.version);
check('playwright-core', packageVersion('playwright-core'), versions.playwrightCore.version);

const browsers = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'));
const chromium = browsers.browsers.find((browser) => browser.name === 'chromium');
check('Playwright Chromium revision', chromium?.revision ?? 'missing', versions.playwrightCore.chromiumRevision);
check('Playwright Chromium version', chromium?.browserVersion ?? 'missing', versions.playwrightCore.chromiumVersion);

if (warnings.length > 0) {
  console.warn('Local toolchain differs from the reproducible CI matrix; this run is compatibility-only.');
}
if (failures.length > 0) process.exitCode = 1;
