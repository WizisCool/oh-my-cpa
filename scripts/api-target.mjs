// Resolves the Go API address the Vite dev server proxies /omc/api to.
//
// The Go process reads OMCPA_LISTEN_ADDR from its dotenv file (internal/config:
// OMCPA_ENV_FILE selects the file, real environment variables win over it), so
// the proxy has to follow the same value instead of assuming 127.0.0.1:8080: a
// developer machine can already have the default port taken by an unrelated
// service.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_LISTEN_ADDR = '127.0.0.1:8080';

// Mirrors config.DotEnvPath: a relative override resolves against the process
// working directory, which is the repository root for `pnpm dev` and Vite.
function dotEnvPath(root) {
  const configured = (process.env.OMCPA_ENV_FILE || '').trim();
  if (!configured) return path.join(root, '.env');
  return path.isAbsolute(configured) ? configured : path.join(root, configured);
}

// Mirrors config.parseDotEnvLine for the subset that matters here: an optional
// `export` prefix, single or double quoted values, and inline comments after an
// unquoted value.
function parseDotEnvValue(file, name, raw) {
  const value = raw.trim();
  if (!value) return '';
  if (value[0] === '"' || value[0] === "'") {
    const end = value.indexOf(value[0], 1);
    if (end < 0) throw new Error(`${file}: unterminated quoted value for ${name}`);
    return value.slice(1, end);
  }
  const comment = value.indexOf('#');
  return (comment < 0 ? value : value.slice(0, comment)).trim();
}

function readDotEnvValue(root, name) {
  const file = dotEnvPath(root);
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // A fresh clone has no dotenv file, which is benign; anything else would
    // also stop the Go process, so surface it instead of guessing a port.
    if (error.code === 'ENOENT') return '';
    throw new Error(`cannot read dotenv file ${file}: ${error.code || error.message}`);
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length) : trimmed;
    const separator = body.indexOf('=');
    if (separator < 0) continue;
    // Go trims the key, so `OMCPA_LISTEN_ADDR = value` is the same setting.
    if (body.slice(0, separator).trim() !== name) continue;
    // First assignment wins, matching os.LookupEnv inside LoadDotEnv.
    return parseDotEnvValue(file, name, body.slice(separator + 1));
  }
  return '';
}

// Mirrors os.LookupEnv plus config.Load: an explicitly set variable, even an
// empty one, suppresses the dotenv file, and an empty result falls back to the
// documented default.
function readEnvOrFile(root, name) {
  if (name in process.env) return (process.env[name] || '').trim();
  return readDotEnvValue(root, name).trim();
}

export function resolveListenAddr(root) {
  return readEnvOrFile(root, 'OMCPA_LISTEN_ADDR') || DEFAULT_LISTEN_ADDR;
}

export function resolveApiTarget(root) {
  const explicit = (process.env.OMCPA_API_TARGET || '').trim();
  if (explicit) return explicit;

  const listenAddr = resolveListenAddr(root);
  const separator = listenAddr.lastIndexOf(':');
  const defaultPort = DEFAULT_LISTEN_ADDR.slice(DEFAULT_LISTEN_ADDR.lastIndexOf(':') + 1);
  if (separator < 0) return `http://${listenAddr}:${defaultPort}`;

  const port = listenAddr.slice(separator + 1) || defaultPort;
  const rawHost = listenAddr.slice(0, separator).replace(/^\[(.*)\]$/, '$1');
  // A wildcard listener still answers on loopback, and the dev proxy is local.
  const host = !rawHost || rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost;
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}
