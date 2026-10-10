import React from 'react';
import { Card } from 'antd';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { useT, type TFunc } from '../../i18n';
import { LoadFailure, useToast } from '../feedback';
import { LoadingRegion, Placeholder } from '../common/Placeholder';
import { RefreshButton } from '../common/RefreshButton';
import { credentialProviderIconId } from '../common/providerMetadata';
import { ProviderBrandIcon } from '../LobeIcon';
import {
  ClockCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  KeyOutlined,
  PauseCircleOutlined,
  RightOutlined,
} from '../icons';
import type { ManagementAuthFile } from '../../types/managementAuthFile';
import type { QuotaItem, QuotaWindow } from '../../types/quota';
import {
  quotaRefreshFailureReason,
  refreshCredentialQuotas,
} from '../../utils/quotaRefresh';
import {
  QUOTA_REFRESH_TOAST_KEY,
  quotaRefreshOutcomeKind,
} from '../../utils/quotaRefreshOutcome';
import {
  buildCredentialQuotaBoard,
  credentialQuotaRefreshTargets,
  isCredentialQuotaBlocked,
  QUOTA_AMPLE_PERCENT,
  QUOTA_LOW_PERCENT,
  quotaWindowPeriod,
  quotaWindowRemaining,
  type CredentialQuotaRow,
  type CredentialQuotaState,
  type QuotaWindowPeriod,
} from './credentialQuotaLogic';

/** The prefixes the page's refresh button invalidates; shared with the credential workspace. */
export const CREDENTIAL_FILES_QUERY_KEY = 'management-auth-files';
export const CREDENTIAL_QUOTA_QUERY_KEY = 'management-quota';

/** Countdowns are minute-grained, so the clock they read ticks at half that. */
const CLOCK_TICK_MS = 30_000;

export type CredentialQuotaPanelState = 'loading' | 'unknown' | 'empty' | 'ready';

const WINDOW_LABEL_KEYS: Record<QuotaWindowPeriod, string> = {
  five_hour: 'dash.quota.window_five_hour',
  daily: 'dash.quota.window_daily',
  weekly: 'dash.quota.window_weekly',
  monthly: 'dash.quota.window_monthly',
};

/** The states whose row says what is wrong instead of drawing the windows it cannot use. */
const STATUS_ROW_STATES: Partial<Record<CredentialQuotaState, { labelKey: string; Icon: React.ComponentType<{ className?: string }> }>> = {
  reauth: { labelKey: 'dash.quota.state_reauth', Icon: KeyOutlined },
  cooldown: { labelKey: 'dash.quota.state_cooldown', Icon: PauseCircleOutlined },
  problem: { labelKey: 'dash.quota.state_problem', Icon: CloseCircleOutlined },
  unread: { labelKey: 'dash.quota.state_unread', Icon: ExclamationCircleOutlined },
};

function windowShortLabel(window: QuotaWindow, t: TFunc): string {
  const period = quotaWindowPeriod(window);
  return period ? t(WINDOW_LABEL_KEYS[period]) : window.label;
}

function remainingTone(remaining: number | undefined): string {
  if (remaining == null) return 'is-unknown';
  if (remaining >= QUOTA_AMPLE_PERCENT) return 'is-ample';
  return remaining >= QUOTA_LOW_PERCENT ? 'is-partial' : 'is-low';
}

/** How long until an instant, to the coarsest unit that still tells two rows apart. */
function formatTimeUntil(targetMS: number | undefined, nowMS: number, t: TFunc): string {
  if (!targetMS || targetMS <= nowMS) return '';
  const minutes = Math.ceil((targetMS - nowMS) / 60_000);
  if (minutes < 60) return t('quota.in_minutes', { n: minutes });
  const hours = Math.round(minutes / 60);
  return hours < 48 ? t('quota.in_hours', { n: hours }) : t('quota.in_days', { n: Math.round(hours / 24) });
}

const QuotaWindowMeter: React.FC<{ window: QuotaWindow }> = ({ window }) => {
  const t = useT();
  const remaining = quotaWindowRemaining(window);
  const label = windowShortLabel(window, t);
  return (
    <span className="quota-window">
      <span className="quota-window-label" title={window.label}>{label}</span>
      <span
        className="quota-window-track"
        role="meter"
        aria-label={t('dash.quota.meter_label', { window: label })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining ?? 0}
      >
        <span className={clsx('quota-window-fill', remainingTone(remaining))} style={{ width: `${remaining ?? 0}%` }} />
      </span>
      <span className="quota-window-value">{remaining == null ? '--' : `${remaining}%`}</span>
    </span>
  );
};

const CredentialQuotaRowView: React.FC<{ row: CredentialQuotaRow; nowMS: number }> = ({ row, nowMS }) => {
  const t = useT();
  const status = STATUS_ROW_STATES[row.state];
  // A blocked row counts down to when it serves again; a serving one to when its tightest window
  // refills. An instant the provider did not state exactly keeps its `~`.
  const reset = row.bindingWindow?.reset_at_ms;
  const isEstimated = !row.recoverAtMS && Boolean(row.bindingWindow?.reset_accuracy) && row.bindingWindow?.reset_accuracy !== 'exact';
  const until = formatTimeUntil(row.recoverAtMS ?? (status ? undefined : reset), nowMS, t);
  const when = until ? `${isEstimated ? '~' : ''}${until}` : '';
  return (
    // A row is not a link. It scrolls under a finger, and a row that navigates turns every touch
    // that was meant to move the list into leaving the page; the panel's one exit is its footer.
    <li
      className={clsx('quota-row', `is-${row.state}`, isCredentialQuotaBlocked(row.state) && 'is-blocked')}
      data-quota-state={row.state}
    >
      <ProviderBrandIcon
        iconId={credentialProviderIconId(row.provider, row.fileName)}
        providerKeys={[row.provider]}
        size={16}
        className="quota-row-icon"
      />
      <span className="quota-row-name" title={row.primary}>{row.primary}</span>
      {status ? (
        <span className="quota-row-status" title={row.detail}>
          <status.Icon className="quota-row-status-icon" aria-hidden="true" />
          {t(status.labelKey)}
        </span>
      ) : (
        <span className="quota-row-windows">
          {row.windows.map((window) => <QuotaWindowMeter key={window.id || window.label} window={window} />)}
        </span>
      )}
      <span className="quota-row-when">
        {when && (
          <>
            <ClockCircleOutlined className="quota-row-when-icon" aria-hidden="true" />
            {when}
          </>
        )}
      </span>
    </li>
  );
};

export interface CredentialQuotaPanelProps {
  /** Absent until the credential list has been read once. */
  files?: ManagementAuthFile[];
  /** Absent when no quota reading is available; the rows then say so rather than vanish. */
  quotas?: QuotaItem[];
  nowMS: number;
  isLoading?: boolean;
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Asks the providers for fresh readings; absent where the panel only shows stored ones. */
  onRefreshQuota?: () => void;
  isRefreshingQuota?: boolean;
  className?: string;
}

export function resolveCredentialQuotaPanelState(
  board: { rows: unknown[]; disabledCount: number } | null,
  isLoading: boolean,
): CredentialQuotaPanelState {
  if (!board) return isLoading ? 'loading' : 'unknown';
  return board.rows.length === 0 && board.disabledCount === 0 ? 'empty' : 'ready';
}

/**
 * CredentialQuotaPanel answers what the fleet can still serve: each credential's remaining
 * subscription quota and when it comes back, the ones that cannot serve first.
 *
 * A count of credentials would say that something is wrong and stop there; the reader's next
 * question is always which credential, why, and when it recovers - and for the ones still serving,
 * how long they will last. Those are what the rows carry. Its one action re-reads those quotas from
 * the providers; everything done about a single credential stays in the workspace its footer links
 * to.
 */
export const CredentialQuotaPanel: React.FC<CredentialQuotaPanelProps> = ({
  files,
  quotas,
  nowMS,
  isLoading = false,
  isError = false,
  error,
  onRetry,
  onRefreshQuota,
  isRefreshingQuota = false,
  className,
}) => {
  const t = useT();
  const board = React.useMemo(() => (files ? buildCredentialQuotaBoard(files, quotas ?? []) : null), [files, quotas]);
  const state = resolveCredentialQuotaPanelState(board, isLoading);

  return (
    <Card
      className={clsx('dashboard-tile credential-quota-panel', className)}
      styles={{ body: { padding: 20 } }}
      data-testid="dashboard-credential-quota"
      data-quota-panel-state={state}
    >
      <div className="quota-inner">
        <div className="quota-head">
          <span className="tile-label">{t('dash.quota.title')}</span>
          {board && state === 'ready' && (
            <span className="quota-head-aside">
            <span className="quota-summary">
              <span>{t('dash.quota.summary_serving')} <b>{board.servingCount}</b></span>
              <span className={clsx(board.blockedCount > 0 && 'is-blocked')}>
                {t('dash.quota.summary_blocked')} <b>{board.blockedCount}</b>
              </span>
              {board.disabledCount > 0 && (
                <span>{t('dash.quota.summary_disabled')} <b>{board.disabledCount}</b></span>
              )}
            </span>
            {onRefreshQuota && board.rows.length > 0 && (
              <RefreshButton
                isIconOnly
                size="small"
                className="quota-refresh"
                label={t('quota.btn_refresh_quota')}
                isRefreshing={isRefreshingQuota}
                onRefresh={onRefreshQuota}
              />
            )}
            </span>
          )}
        </div>

        {state === 'loading' && (
          <LoadingRegion className="quota-skeleton">
            {Array.from({ length: 4 }, (_, row) => (
              <Placeholder key={row} width="100%" height={18} row={row} className="placeholder-line" />
            ))}
          </LoadingRegion>
        )}

        {state === 'unknown' && (
          <LoadFailure className="quota-alert" title={t('dash.quota.error')} error={error} onRetry={onRetry} />
        )}

        {state === 'empty' && (
          <div className="quota-empty">
            <p className="empty-copy">{t('dash.quota.empty')}</p>
            <Link to="/oauth-management?action=connect" className="quota-foot-link">
              <span>{t('dash.quota.connect')}</span>
              <RightOutlined className="quota-link-icon" />
            </Link>
          </div>
        )}

        {board && state === 'ready' && (
          <>
            {isError && (
              <LoadFailure
                className="quota-alert"
                tone="warning"
                title={t('dash.quota.stale')}
                onRetry={onRetry}
              />
            )}
            {board.rows.length > 0 ? (
              // Every credential is listed and the list scrolls inside the panel, so a large fleet
              // is readable here without the panel outgrowing the row it shares.
              <ul className="quota-list">
                {board.rows.map((row) => <CredentialQuotaRowView key={row.key} row={row} nowMS={nowMS} />)}
              </ul>
            ) : (
              <p className="empty-copy quota-all-disabled">{t('dash.quota.all_disabled')}</p>
            )}
            <div className="quota-foot">
              <Link to="/oauth-management" className="quota-foot-link">
                <span>{t('oauth.view_auth_files')}</span>
                <RightOutlined className="quota-link-icon" />
              </Link>
            </div>
          </>
        )}
      </div>
    </Card>
  );
};

/**
 * CredentialQuota reads the two stored projections the panel joins. Neither read reaches a
 * provider: the quota endpoint serves the last recorded readings, so a dashboard that polls it
 * spends nothing upstream. Only the refresh control does, through the same run the credential
 * workspace uses, and it reports under the same toast key so the two never stack reports.
 */
export const CredentialQuota: React.FC = () => {
  const filesQuery = useQuery({
    queryKey: [CREDENTIAL_FILES_QUERY_KEY],
    queryFn: () => api.getManagementAuthFiles(),
    refetchInterval: 60_000,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    meta: { silent: true },
  });
  const quotaQuery = useQuery({
    queryKey: [CREDENTIAL_QUOTA_QUERY_KEY],
    queryFn: api.getQuotaOverview,
    refetchInterval: 60_000,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
    meta: { silent: true },
  });

  const [nowMS, setNowMS] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = window.setInterval(() => setNowMS(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);

  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [isRefreshingQuota, setIsRefreshingQuota] = React.useState(false);
  // The glyph turns instead of the button locking, so a second click can arrive before the first
  // run has rendered as in-flight. State is what the button reads; this ref is what the lock reads,
  // because two clicks inside one commit both see the state that was rendered before either ran.
  const isRefreshRunningRef = React.useRef(false);
  const files = filesQuery.data?.files;
  const quotas = quotaQuery.data?.quotas;
  const refreshQuota = React.useCallback(async () => {
    if (isRefreshRunningRef.current) return;
    const targets = credentialQuotaRefreshTargets(files ?? [], quotas ?? []);
    if (targets.length === 0) {
      toast.info(t('omc.quota_refresh_none'), { key: QUOTA_REFRESH_TOAST_KEY });
      return;
    }
    isRefreshRunningRef.current = true;
    setIsRefreshingQuota(true);
    try {
      const outcome = await refreshCredentialQuotas(targets);
      const failed = outcome.failures.length;
      const unknown = outcome.unknownIndexes.length;
      if (quotaRefreshOutcomeKind({ failed, unknown }) === 'report') {
        toast.warning(t('omc.quota_refresh_report', { succeeded: outcome.succeeded, failed: failed + unknown, skipped: 0 }), {
          key: QUOTA_REFRESH_TOAST_KEY,
          items: [
            ...outcome.failures.map((failure) => ({ name: failure.name, reason: quotaRefreshFailureReason(failure, t), group: t('toast.group_failed') })),
            ...outcome.unknownIndexes.map((name) => ({ name, reason: t('omc.quota_refresh_unknown'), group: t('toast.group_unknown') })),
          ],
        });
      } else {
        toast.success(t('omc.quota_refresh_report_clean', { succeeded: outcome.succeeded, skipped: 0 }), { key: QUOTA_REFRESH_TOAST_KEY });
      }
      await queryClient.invalidateQueries({ queryKey: [CREDENTIAL_QUOTA_QUERY_KEY] });
    } finally {
      isRefreshRunningRef.current = false;
      setIsRefreshingQuota(false);
    }
  }, [files, queryClient, quotas, t, toast]);

  return (
    <CredentialQuotaPanel
      onRefreshQuota={() => void refreshQuota()}
      isRefreshingQuota={isRefreshingQuota}
      files={filesQuery.data?.files}
      quotas={quotaQuery.data?.quotas}
      nowMS={nowMS}
      isLoading={filesQuery.isLoading}
      isError={filesQuery.isError || quotaQuery.isError}
      error={filesQuery.error ?? quotaQuery.error}
      onRetry={() => {
        void filesQuery.refetch();
        void quotaQuery.refetch();
      }}
    />
  );
};
