import type { MessageKey } from '../../i18n/catalog';
import { quotaWindowParts } from '../../pages/quota/quotaWindowSelection';
import React from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../../api/client';
import { useT, type TFunc } from '../../i18n';
import { LoadFailure, useToast } from '../feedback';
import { LoadingRegion, Placeholder } from '../common/Placeholder';
import { RefreshButton } from '../common/RefreshButton';
import { Tooltip } from '../common/Tooltip';
import { usePluginMultiPortalKeys, usePluginOAuthLogos } from '../../hooks/usePluginOAuthLogos';
import type { PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import { CredentialMark } from '../LobeIcon';
import {
  ClockCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  HourglassOutlined,
  KeyOutlined,
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
import { Panel } from '../common/Panel';
import { ReorderHandle, RowReorder, useReorderRow } from '../common/RowReorder';
import { useSortableList } from '../../hooks/useSortableList';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import { DASHBOARD_ORDER_PREFERENCE } from '../../types/dashboardLayout';
import './dashboard.css';

/** The prefixes the page's refresh button invalidates; shared with the credential workspace. */
export const CREDENTIAL_FILES_QUERY_KEY = 'management-auth-files';
export const CREDENTIAL_QUOTA_QUERY_KEY = 'management-quota';

export type CredentialQuotaPanelState = 'loading' | 'unknown' | 'empty' | 'ready';

const WINDOW_LABEL_KEYS: Record<QuotaWindowPeriod, MessageKey> = {
  five_hour: 'dash.quota.window_five_hour',
  daily: 'dash.quota.window_daily',
  weekly: 'dash.quota.window_weekly',
  monthly: 'dash.quota.window_monthly',
};

/** The states whose row says what is wrong instead of drawing the windows it cannot use. */
const STATUS_ROW_STATES: Partial<Record<CredentialQuotaState, { labelKey: MessageKey; Icon: React.ComponentType<{ className?: string }> }>> = {
  reauth: { labelKey: 'dash.quota.state_reauth', Icon: KeyOutlined },
  cooldown: { labelKey: 'dash.quota.state_cooldown', Icon: HourglassOutlined },
  'model-cooldown': { labelKey: 'quota.model_cooldown_status', Icon: HourglassOutlined },
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
      {/* The panel keeps one compact line per credential; a plugin's own words for what is left
          (its only amounts) ride in the shared hint, which touch and keyboard focus reach too,
          rather than widening the row. */}
      <Tooltip card={{ heading: quotaWindowParts(window).name, notes: [quotaWindowParts(window).group, window.description] }}>
        <span className="quota-window-label" tabIndex={0}>{label}</span>
      </Tooltip>
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

const EmptyQuotaSlot: React.FC = () => <span className="quota-window is-missing" aria-hidden="true">—</span>;

interface QuotaRowProps {
  row: CredentialQuotaRow;
  nowMS: number;
  pluginLogos?: PluginOAuthLogos;
  /** The row's part in a sortable list; absent where the list keeps its urgency order. */
  reorder?: ReturnType<typeof useReorderRow>;
  isPhone?: boolean;
}

const CredentialQuotaRowView: React.FC<QuotaRowProps> = ({ row, nowMS, pluginLogos, reorder, isPhone = false }) => {
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
      {...reorder?.row}
      className={clsx('quota-row', `is-${row.state}`, isCredentialQuotaBlocked(row.state) && 'is-blocked')}
      data-quota-state={row.state}
    >
      {reorder && !isPhone && <ReorderHandle {...reorder.handle} name={row.primary} />}
      <CredentialMark
        credential={row.credential} pluginLogos={pluginLogos}
        size={16}
        className="quota-row-icon"
      />
      <span className="quota-row-name" data-tip={row.primary} data-tip-overflow="">{row.primary}</span>
      {status ? (
        <span className="quota-row-status" data-tip={row.detail}>
          <status.Icon className="quota-row-status-icon" aria-hidden="true" />
          {t(status.labelKey)}
        </span>
      ) : (
        <span className="quota-row-windows">
          {/* Both places are always drawn, so a credential without a five-hour limit leaves that
              place empty instead of moving its weekly reading under everyone else's five hours. */}
          {row.slots[0] ? <QuotaWindowMeter window={row.slots[0]} /> : <EmptyQuotaSlot />}
          {row.slots[1] ? <QuotaWindowMeter window={row.slots[1]} /> : <EmptyQuotaSlot />}
        </span>
      )}
      <span className="quota-row-when">
        {when && (
          <>
            <ClockCircleOutlined className="quota-row-when-icon" aria-hidden="true" />
            {when}
          </>
        )}
        {reorder && isPhone && <ReorderHandle {...reorder.handle} name={row.primary} variant="inline" />}
      </span>
    </li>
  );
};

/** A row that takes its place in the operator's order. */
const SortableQuotaRow: React.FC<Omit<QuotaRowProps, 'reorder'>> = (props) => {
  const reorder = useReorderRow(quotaRowKey(props.row));
  return <CredentialQuotaRowView {...props} reorder={reorder} />;
};

/** What the stored order names a credential by: its file name, as the OAuth list does. */
function quotaRowKey(row: CredentialQuotaRow): string {
  return row.fileName;
}

/**
 * The rows in the operator's order. A credential the order does not name - one connected since,
 * or every credential before anything was dragged - keeps the urgency order after the named ones.
 */
const SortableQuotaList: React.FC<{ rows: CredentialQuotaRow[]; nowMS: number; pluginLogos?: PluginOAuthLogos }> = ({ rows, nowMS, pluginLogos }) => {
  const isPhone = useIsPhoneViewport();
  const sortable = useSortableList(DASHBOARD_ORDER_PREFERENCE, 'credential_quota', rows, quotaRowKey);
  return (
    <RowReorder {...sortable.reorder} items={sortable.ordered.map(quotaRowKey)}>
      <ul className="quota-list">
        {sortable.ordered.map((row) => <SortableQuotaRow key={row.key} row={row} nowMS={nowMS} pluginLogos={pluginLogos} isPhone={isPhone} />)}
      </ul>
    </RowReorder>
  );
};

export interface CredentialQuotaPanelProps {
  pluginLogos?: PluginOAuthLogos;
  /** The login portals multi-portal plugins declare; a credential issued by one draws that portal. */
  multiPortalKeys?: ReadonlySet<string>;
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
  /** Lets the operator drag rows into their own order, stored with the dashboard's preferences. */
  isSortable?: boolean;
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
 * the providers; everything done about a single credential stays in the OAuth workspace.
 */
export const CredentialQuotaPanel: React.FC<CredentialQuotaPanelProps> = ({
  files,
  quotas,
  nowMS,
  pluginLogos,
  multiPortalKeys,
  isLoading = false,
  isError = false,
  error,
  onRetry,
  onRefreshQuota,
  isRefreshingQuota = false,
  isSortable = false,
  className,
}) => {
  const t = useT();
  const board = React.useMemo(
    () => (files ? buildCredentialQuotaBoard(files, quotas ?? [], multiPortalKeys) : null),
    [files, multiPortalKeys, quotas],
  );
  const state = resolveCredentialQuotaPanelState(board, isLoading);

  return (
    <Panel
      className={clsx('dashboard-tile credential-quota-panel', className)}
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
            {/* Every credential is listed and the list scrolls inside the panel, so a large fleet
                is readable here without the panel outgrowing the row it shares. */}
            {board.rows.length > 0 && isSortable ? (
              <SortableQuotaList rows={board.rows} nowMS={nowMS} pluginLogos={pluginLogos} />
            ) : board.rows.length > 0 ? (
              <ul className="quota-list">
                {board.rows.map((row) => <CredentialQuotaRowView key={row.key} row={row} nowMS={nowMS} pluginLogos={pluginLogos} />)}
              </ul>
            ) : (
              <p className="empty-copy quota-all-disabled">{t('dash.quota.all_disabled')}</p>
            )}
          </>
        )}
      </div>
    </Panel>
  );
};

/**
 * CredentialQuota reads the two stored projections the panel joins. Neither read reaches a
 * provider: the quota endpoint serves the last recorded readings, so a dashboard that polls it
 * spends nothing upstream. Only the refresh control does, through the same run the credential
 * workspace uses, and it reports under the same toast key so the two never stack reports.
 */
export const CredentialQuota: React.FC = React.memo(function CredentialQuota() {
  const pluginLogos = usePluginOAuthLogos();
  const multiPortalKeys = usePluginMultiPortalKeys();
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

  const nowMS = useVisibleNow();

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
      isSortable
      pluginLogos={pluginLogos}
      multiPortalKeys={multiPortalKeys}
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
});
