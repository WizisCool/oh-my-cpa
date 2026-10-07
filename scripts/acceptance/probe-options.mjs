import { parseShard } from './probe-shards.mjs';

export function parseProbePort(value) {
  if (!/^\d+$/.test(String(value))) throw new Error('Probe port must be an explicit TCP port');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Probe port must be between 1024 and 65535');
  return port;
}

export function parseProbeOptions(arguments_) {
  const options = { port: 5180 };
  const seen = new Set();
  for (let i = 0; i < arguments_.length; i += 1) {
    const argument = arguments_[i];
    if (!['--port', '--shard'].includes(argument) || seen.has(argument)) throw new Error(`Unknown or duplicate probe option: ${argument}`);
    seen.add(argument);
    const value = arguments_[++i];
    if (argument === '--port') options.port = parseProbePort(value);
    else options.shard = parseShard(value);
  }
  return options;
}
