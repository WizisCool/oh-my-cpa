import type { PricingProvider } from './pricing';

const MODEL_NAME_ORDER = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const MODEL_CASE_ORDER = new Intl.Collator('en', { numeric: true, sensitivity: 'variant', caseFirst: 'upper' });

export function compareModelNames(left: string, right: string): number {
  return MODEL_NAME_ORDER.compare(left, right) || MODEL_CASE_ORDER.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0);
}

export function comparePricingProviders(left: PricingProvider, right: PricingProvider): number {
  return right.priority - left.priority || compareModelNames(left.name, right.name) || compareModelNames(left.id, right.id);
}

export interface PricingGroup<Row> {
  id: string;
  provider: PricingProvider | null;
  rows: Row[];
}

/** Membership is exact CPA provenance, never inferred from a model's maker or price source. */
export function groupPricingModels<Row extends { model: string }>(rows: readonly Row[], providers: readonly PricingProvider[]): PricingGroup<Row>[] {
  const byModel = new Map(rows.map((row) => [row.model, row]));
  const assigned = new Set<string>();
  const groups: PricingGroup<Row>[] = [];
  for (const provider of [...providers].sort(comparePricingProviders)) {
    const members = [...new Set(provider.models)].flatMap((model) => {
      const row = byModel.get(model);
      if (!row) return [];
      assigned.add(model);
      return [row];
    }).sort((left, right) => compareModelNames(left.model, right.model));
    if (members.length > 0) groups.push({ id: provider.id, provider, rows: members });
  }
  const unassigned = rows.filter((row) => !assigned.has(row.model)).sort((left, right) => compareModelNames(left.model, right.model));
  if (unassigned.length > 0) groups.push({ id: 'unassigned', provider: null, rows: unassigned });
  return groups;
}

/** Page membership rows globally so many providers cannot multiply the render budget. */
export function pagePricingGroups<Row>(groups: readonly PricingGroup<Row>[], page: number, pageSize: number): PricingGroup<Row>[] {
  let skip = (page - 1) * pageSize;
  let remaining = pageSize;
  const visible: PricingGroup<Row>[] = [];
  for (const group of groups) {
    if (remaining <= 0) break;
    if (skip >= group.rows.length) { skip -= group.rows.length; continue; }
    const rows = group.rows.slice(skip, skip + remaining);
    visible.push({ ...group, rows });
    remaining -= rows.length;
    skip = 0;
  }
  return visible;
}
