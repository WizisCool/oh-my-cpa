import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function summarizeProbeTimings(runs) {
  const samples = new Map();
  for (const run of runs) {
    const seen = new Set();
    for (const item of run) {
      if (!item.id || seen.has(item.id) || !Number.isFinite(item.durationMs) || item.durationMs <= 0 || !['passed','failed'].includes(item.status)) throw new Error('Invalid or duplicate timing record');
      seen.add(item.id);
      if (item.status !== 'passed') continue;
      const durations = samples.get(item.id) ?? [];
      durations.push(item.durationMs / 1000); samples.set(item.id,durations);
    }
  }
  return Object.fromEntries([...samples].sort(([left],[right])=>left.localeCompare(right)).map(([id,values])=>{
    values.sort((left,right)=>left-right);
    const middle=Math.floor(values.length/2);
    return [id,{samples:values.length,medianSeconds:Number((values.length%2 ? values[middle] : (values[middle-1]+values[middle])/2).toFixed(2)),p95Seconds:values[Math.ceil(values.length*.95)-1]}];
  }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length < 3) throw new Error('Supply downloaded scenario timing JSON files; output is a review candidate, not a runtime shard map');
  console.log(JSON.stringify(summarizeProbeTimings(process.argv.slice(2).map(file=>JSON.parse(fs.readFileSync(file,'utf8')))),null,2));
}
