import type { QuotaItem, QuotaOverviewSummary } from '../../types/quota';

const ONE_HOUR = 3600 * 1000;
const FIVE_HOURS = 5 * 3600 * 1000;
const TWENTY_FOUR_HOURS = 24 * 3600 * 1000;
const SEVEN_DAYS = 7 * 24 * 3600 * 1000;

export function computeTimelinePercent(diffMS: number): number {
  if (diffMS <= 0) return 0;
  if (diffMS <= ONE_HOUR) {
    return Math.max(2, (diffMS / ONE_HOUR) * 25);
  }
  if (diffMS <= FIVE_HOURS) {
    return 25 + ((diffMS - ONE_HOUR) / (FIVE_HOURS - ONE_HOUR)) * 25;
  }
  if (diffMS <= TWENTY_FOUR_HOURS) {
    return 50 + ((diffMS - FIVE_HOURS) / (TWENTY_FOUR_HOURS - FIVE_HOURS)) * 25;
  }
  if (diffMS <= SEVEN_DAYS) {
    return 75 + ((diffMS - TWENTY_FOUR_HOURS) / (SEVEN_DAYS - TWENTY_FOUR_HOURS)) * 25;
  }
  return 100;
}

export function filterQuotaItems(
  items: QuotaItem[],
  activeProvider: string,
  statusFilter: string,
  searchText: string
): QuotaItem[] {
  return items.filter((item) => {
    if (activeProvider !== 'all') {
      if (item.provider?.toLowerCase() !== activeProvider.toLowerCase()) {
        return false;
      }
    }

    if (statusFilter === 'healthy' && item.status !== 'healthy') return false;
    if (statusFilter === 'warning' && item.status !== 'warning') return false;
    if (statusFilter === 'exhausted' && item.status !== 'exhausted') return false;
    if (statusFilter === 'cooldown' && !item.active_cooldown?.is_active) return false;

    if (searchText.trim()) {
      const query = searchText.trim().toLowerCase();
      const matchesName = item.name.toLowerCase().includes(query);
      const matchesAuthIndex = item.auth_index.toLowerCase().includes(query);
      const matchesModel = item.windows?.some((w) => w.model?.toLowerCase().includes(query));
      if (!matchesName && !matchesAuthIndex && !matchesModel) {
        return false;
      }
    }

    return true;
  });
}

export function sortQuotaItems(
  items: QuotaItem[],
  sortMode: string,
  nowMS: number = Date.now()
): QuotaItem[] {
  const list = [...items];

  const getMinRemaining = (q: QuotaItem) => {
    if (!q.windows || q.windows.length === 0) return 100;
    return Math.min(...q.windows.map((w) => w.remaining_percent ?? 100));
  };

  const getSoonestReset = (q: QuotaItem) => {
    if (q.active_cooldown?.is_active && q.active_cooldown.recover_at_ms) {
      return q.active_cooldown.recover_at_ms;
    }
    let minReset = Number.MAX_SAFE_INTEGER;
    q.windows?.forEach((w) => {
      if (w.reset_at_ms && w.reset_at_ms > nowMS && w.reset_at_ms < minReset) {
        minReset = w.reset_at_ms;
      }
    });
    return minReset;
  };

  switch (sortMode) {
    case 'recovery':
      list.sort((a, b) => getSoonestReset(a) - getSoonestReset(b));
      break;
    case 'least_remaining':
      list.sort((a, b) => getMinRemaining(a) - getMinRemaining(b));
      break;
    case 'most_remaining':
      list.sort((a, b) => getMinRemaining(b) - getMinRemaining(a));
      break;
    case 'name':
      list.sort((a, b) => a.name.localeCompare(b.name));
      break;
    default:
      list.sort((a, b) => {
        const priorityRank = (q: QuotaItem) => {
          if (q.active_cooldown?.is_active) return 5;
          if (q.status === 'exhausted') return 4;
          if (q.status === 'warning') return 3;
          if (q.status === 'error') return 2;
          if (q.status === 'healthy') return 1;
          return 0;
        };
        const diff = priorityRank(b) - priorityRank(a);
        if (diff !== 0) return diff;
        return a.name.localeCompare(b.name);
      });
  }

  return list;
}

export function computeFleetSummary(
  allQuotas: QuotaItem[],
  nowMS: number = Date.now()
): QuotaOverviewSummary {
  let healthy = 0;
  let warning = 0;
  let exhausted = 0;
  let cooldown = 0;
  let attention = 0;
  let soonest: number | undefined;

  allQuotas.forEach((q) => {
    if (q.active_cooldown?.is_active) {
      cooldown++;
      attention++;
      if (q.active_cooldown.recover_at_ms && q.active_cooldown.recover_at_ms > nowMS) {
        if (!soonest || q.active_cooldown.recover_at_ms < soonest) {
          soonest = q.active_cooldown.recover_at_ms;
        }
      }
    } else if (q.status === 'healthy') {
      healthy++;
    } else if (q.status === 'warning') {
      warning++;
      attention++;
    } else if (q.status === 'exhausted') {
      exhausted++;
      attention++;
    } else if (q.status === 'error') {
      attention++;
    }

    q.windows?.forEach((w) => {
      if (w.reset_at_ms && w.reset_at_ms > nowMS) {
        if (!soonest || w.reset_at_ms < soonest) {
          soonest = w.reset_at_ms;
        }
      }
    });
  });

  return {
    total_credentials: allQuotas.length,
    healthy_count: healthy,
    warning_count: warning,
    exhausted_count: exhausted,
    cooldown_count: cooldown,
    attention_count: attention,
    soonest_recovery_ms: soonest,
  };
}
