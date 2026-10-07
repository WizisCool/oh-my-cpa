import fs from 'node:fs';

export function validateAdvisoryTriage(triage, today = new Date().toISOString().slice(0, 10)) {
  const identifiers = new Set();
  for (const finding of triage.findings) {
    if (!/^GHSA-[a-z0-9-]+$/.test(finding.id) || identifiers.has(finding.id)) throw new Error('Advisory identifiers must be unique and exact');
    identifiers.add(finding.id);
    for (const key of ['package', 'owner', 'reason', 'disposition']) {
      if (typeof finding[key] !== 'string' || !finding[key].trim()) throw new Error(`Advisory ${finding.id} needs ${key}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(finding.reviewBy) || finding.reviewBy <= today) throw new Error(`Advisory ${finding.id} needs a renewed review`);
  }
}

// Ownership records inform remediation; they never suppress the audit's exit verdict.
export function reportAdvisoryTriage(today) {
  const triage = JSON.parse(fs.readFileSync(new URL('./advisory-triage.json', import.meta.url), 'utf8'));
  validateAdvisoryTriage(triage, today);
  for (const finding of triage.findings) console.log(`[advisory] ${finding.id}: ${finding.disposition}; owner=${finding.owner}; review-by=${finding.reviewBy}`);
}
