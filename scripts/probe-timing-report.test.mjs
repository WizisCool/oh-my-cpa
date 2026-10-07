import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProbeTimings } from './probe-timing-report.mjs';
test('reviewed timing candidates include only successful valid samples',()=>{
  const record=(durationMs,status='passed')=>({id:'claim',durationMs,status});
  assert.deepEqual(summarizeProbeTimings([[record(1000)],[record(3000)],[record(99999,'failed')]]),{claim:{samples:2,medianSeconds:2,p95Seconds:3}});
  for(const runs of [[[record(0)]],[[record(1),record(2)]],[[record(NaN)]]])assert.throws(()=>summarizeProbeTimings(runs));
});
