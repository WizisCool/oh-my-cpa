import { changedFiles, planFastChecks } from '../verify-fast.mjs';
import { runChecks, measureVerification } from '../parallel-checks.mjs';

// CI owns repository/Go gates in separate required jobs; this is only its frontend
// lane, not a mode that can turn the complete local fast gate into a partial pass.
const selected = planFastChecks(changedFiles(process.env.BASE ?? 'HEAD'))
  .filter(check => ['type-check', 'logic', 'components', 'antd-lint'].includes(check.id));
console.log(`[frontend-affected] ${selected.length} frontend checks; repository and Go verdicts belong to their separate CI jobs`);
if (selected.length && !await measureVerification('frontend-affected', () => runChecks(selected, { quiet: true }), selected.map(check => check.label))) process.exitCode = 1;
