import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'tools-versions.json'), 'utf8'));

function platformKey() {
  const osName = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  const archName = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!osName || !archName) throw new Error(`unsupported tool platform: ${process.platform}-${process.arch}`);
  return `${osName}-${archName}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry only transport failures, never a rejected checksum or installed version.
async function download(name, url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      if (response.status < 500 && response.status !== 429) {
        throw Object.assign(new Error(`${name} download failed: ${response.status} ${response.statusText}`), { isNonRetryable: true });
      }
      lastError = new Error(`${name} download failed: ${response.status} ${response.statusText}`);
    } catch (error) {
      if (error?.isNonRetryable) throw error;
      lastError = error;
    }
    if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
  }
  throw lastError;
}

export async function ensureTool(name, versionArgs = ['--version']) {
  const { version, archives, stripComponents = 0 } = manifest[name];
  const configured = process.env[`${name.toUpperCase()}_BIN`]?.trim();
  const verifyVersion = (binary) => {
    const actual = execFileSync(binary, versionArgs, { encoding: 'utf8' }).trim();
    if (actual !== version && actual !== `${name} ${version}`) {
      throw new Error(`${name} version mismatch: found ${actual}, expected ${version}`);
    }
  };
  if (configured) {
    const executable = path.resolve(root, configured);
    if (!fs.existsSync(executable)) throw new Error(`${name.toUpperCase()}_BIN does not exist: ${executable}`);
    verifyVersion(executable);
    return executable;
  }
  const key = platformKey();
  const executable = path.join(root, '.tools', name, version, key, process.platform === 'win32' ? `${name}.exe` : name);
  if (fs.existsSync(executable)) {
    verifyVersion(executable);
    return executable;
  }
  const archive = archives[key];
  if (!archive) throw new Error(`missing ${name} archive metadata for ${key}`);

  console.log(`[tools] Installing ${name} ${version} (${key})`);
  const bytes = await download(name, archive.url);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== archive.sha256) {
    throw new Error(`${name} archive checksum mismatch for ${key}`);
  }
  const installDirectory = path.dirname(executable);
  fs.mkdirSync(path.dirname(installDirectory), { recursive: true });
  // Publish a complete installation atomically; concurrent checks never execute a
  // partly extracted binary or remove another invocation's staging directory.
  const temporary = fs.mkdtempSync(`${installDirectory}.tmp-`);
  try {
    const archivePath = path.join(temporary, archive.url.endsWith('.zip') ? 'archive.zip' : 'archive.tar.gz');
    fs.writeFileSync(archivePath, bytes);
    // Git/MSYS tar can shadow Windows' ZIP-capable bsdtar and misread drive letters.
    const windowsRoot = process.env.SystemRoot;
    if (process.platform === 'win32' && !windowsRoot) throw new Error('SystemRoot is required to locate Windows tar.exe');
    const tar = process.platform === 'win32' ? path.join(windowsRoot, 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xf', archivePath, '-C', temporary, `--strip-components=${stripComponents}`], { stdio: 'inherit' });
    fs.rmSync(archivePath);
    const binary = path.join(temporary, path.basename(executable));
    if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
    verifyVersion(binary);
    try { fs.renameSync(temporary, installDirectory); }
    catch (error) {
      if (!fs.existsSync(executable)) throw error;
      verifyVersion(executable);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return executable;
}
