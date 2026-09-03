// Start the optional local CLIProxyAPI dependency from ./cpa.
// CPA_BIN and CPA_CONFIG can override the default binary and config paths.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cpaDir = path.join(root, 'cpa');
const configuredBinary = (process.env.CPA_BIN || '').trim();
const candidates = configuredBinary
  ? [configuredBinary]
  : process.platform === 'win32'
    ? ['cli-proxy-api.exe', 'cli-proxy-api']
    : ['cli-proxy-api', 'cli-proxy-api.exe'];
const binary = candidates
  .map((candidate) => path.isAbsolute(candidate) ? candidate : path.join(cpaDir, candidate))
  .find((candidate) => fs.existsSync(candidate));
const configValue = (process.env.CPA_CONFIG || 'config.yaml').trim();
const config = path.isAbsolute(configValue) ? configValue : path.join(cpaDir, configValue);

if (!binary) {
  console.error(`[cpa] binary not found; place CLIProxyAPI in ${cpaDir} or set CPA_BIN.`);
  process.exit(1);
}
if (!fs.existsSync(config)) {
  console.error(`[cpa] config not found: ${config}`);
  process.exit(1);
}

const child = spawn(binary, ['-config', config, ...process.argv.slice(2)], {
  cwd: cpaDir,
  stdio: 'inherit',
  shell: false,
});
child.once('error', (error) => {
  console.error(`[cpa] failed to start: ${error.message}`);
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  if (signal) {
    console.error(`[cpa] stopped by ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
