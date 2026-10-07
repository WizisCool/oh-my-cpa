import { reportAdvisoryTriage } from './advisory-triage.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAINTENANCE_CHECKS = {
  race: [
    ['go', ['test','-race','-p=2','-timeout=3m','./internal/usage/...','./internal/cpa/...','./internal/agent/...','./internal/mcpbridge/...']],
    ['go', ['test','-race','-timeout=3m','-run=(?i)(Concurrent|Cancel|Shutdown|BrowserRun|Gate|Atomic|Deadline|MaintenanceRefuses)','./internal/repository','./internal/api']],
  ],
  fuzz: [
    ['go',['test','./internal/security','-run=^$','-fuzz=^FuzzPublicURLRemovesAuthoritySecrets$','-fuzztime=10s','-parallel=2']],
    ['go',['test','./internal/security','-run=^$','-fuzz=^FuzzRedactJSONPreservesShapeAndRemovesKnownSecrets$','-fuzztime=10s','-parallel=2']],
    ['go',['test','./internal/pricing','-run=^$','-fuzz=^FuzzQuoteLegacyParity$','-fuzztime=10s','-parallel=2']],
  ],
  advisories: [['pnpm',['audit','--json']],['go',['run','golang.org/x/vuln/cmd/govulncheck@v1.8.0','-json','./...']]],
};
export function runMaintenanceChecks(mode, execute = spawnSync, outputDirectory = 'tmp/maintenance') {
  if (!MAINTENANCE_CHECKS[mode]) throw new Error(`Unknown maintenance mode: ${mode}`);
  if (mode === 'advisories') reportAdvisoryTriage();
  fs.mkdirSync(outputDirectory,{recursive:true});
  const results = MAINTENANCE_CHECKS[mode].map(([command,args],index)=>{
    const result=execute(command,args,{encoding:'utf8',timeout:240_000,maxBuffer:16*1024*1024,env:{...process.env,CGO_ENABLED:mode==='race'?'1':'0'}});
    fs.writeFileSync(path.join(outputDirectory, `${mode}-${index}.log`),`${result.stdout??''}\n${result.stderr??''}\n${result.error?.message??''}`);
    console.log(`[maintenance] ${result.status===0?'PASS':'FAIL'} ${command} ${args.join(' ')}`);
    return result.status===0 && !result.error;
  });
  return results.every(Boolean);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode,option,...extra]=process.argv.slice(2);
  if (!MAINTENANCE_CHECKS[mode] || (option && option!=='--plan') || extra.length) throw new Error('Expected race|fuzz|advisories [--plan]');
  if(option==='--plan') console.log(JSON.stringify(MAINTENANCE_CHECKS[mode],null,2));
  else if(!runMaintenanceChecks(mode))process.exitCode=1;
}
