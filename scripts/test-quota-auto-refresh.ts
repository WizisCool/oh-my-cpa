import assert from 'node:assert/strict';
import {
  DEFAULT_QUOTA_AUTO_REFRESH,
  QUOTA_AUTO_REFRESH_INTERVALS,
  isQuotaAutoRefreshInterval,
  parseQuotaAutoRefresh,
} from '../web/src/types/quotaAutoRefresh';

// Mirrors the server's defaults and bounds (`internal/quota/auto_refresh.go`): a stored value the
// server would refuse must read as absent, so the page falls back instead of showing it.
assert.deepEqual(DEFAULT_QUOTA_AUTO_REFRESH, { interval_minutes: 360, refresh_on_reset: true });
for (const minutes of QUOTA_AUTO_REFRESH_INTERVALS) assert.equal(isQuotaAutoRefreshInterval(minutes), true);
for (const minutes of [0, 5, 45, 1440]) assert.equal(isQuotaAutoRefreshInterval(minutes), true);
for (const minutes of [-1, 1, 4, 1441, 7.5, NaN, '30', null, undefined]) assert.equal(isQuotaAutoRefreshInterval(minutes), false);

assert.deepEqual(parseQuotaAutoRefresh({ interval_minutes: 30, refresh_on_reset: false }), { interval_minutes: 30, refresh_on_reset: false });
assert.deepEqual(parseQuotaAutoRefresh({ interval_minutes: 0, refresh_on_reset: true, note: 'ignored' }), { interval_minutes: 0, refresh_on_reset: true });
for (const raw of [undefined, null, true, 'on', [], {}, { interval_minutes: 30 }, { refresh_on_reset: true }, { interval_minutes: 2, refresh_on_reset: true }, { interval_minutes: 30, refresh_on_reset: 'yes' }]) {
  assert.equal(parseQuotaAutoRefresh(raw), undefined);
}
