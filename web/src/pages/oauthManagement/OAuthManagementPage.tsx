import React from 'react';
import { useBlocker, useSearchParams } from 'react-router-dom';
import {
  Alert,
  App as AntdApp,
  Button,
  Dropdown,
  Empty,
  Input,
  Pagination,
  Select,
  Space,
  Spin,
} from 'antd';
import {
  BranchesOutlined,
  DownOutlined,
  FilterOutlined,
  LoginOutlined,
  SearchOutlined,
  SyncOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import { useDebouncedSearch } from '../../components/usage/useDebouncedSearch';
import { usePreference } from '../../hooks/usePreference';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import { isDemoMode } from '../../types/demoMode';
import { pluginOAuthLogoFor, pluginOAuthProviderLogos } from '../../types/pluginOAuthProviders';
import { providerFilterTabs } from '../../types/credentialProviders';
import type { AuthFileSortKey, AuthFileStatusFilter } from '../../components/authFiles/authFileLogic';
import {
  isAuthFileDisabled,
  isAuthFileHealthy,
  isAuthFileProblem,
} from '../../components/authFiles/authFileLogic';
import { AuthFileDetailDrawer } from '../../components/authFiles/AuthFileDetailDrawer';
import { BatchActionBar } from '../../components/authFiles/BatchActionBar';
import { OAuthModelAliasDrawer } from '../../components/authFiles/OAuthModelAliasDrawer';
import { ProviderFilterTabs } from '../../components/common/ProviderFilterTabs';
import { oauthProviderChoices } from '../oauthProviderLogic';
import { CompactQuotaView } from '../quota/CompactQuotaView';
import { CredentialQuotaBody } from '../quota/CredentialQuotaBody';
import { OAuthConnectPanel } from './OAuthConnectPanel';
import { OAuthCredentialRecord } from './OAuthCredentialRecord';
import { useOAuthSessions } from './useOAuthSessions';
import { useOAuthWorkspaceActions } from './useOAuthWorkspaceActions';
import {
  buildOAuthWorkspaceProjection,
  consumeOneShotIntent,
  filterOAuthWorkspaceRecords,
  parseOAuthWorkspaceQuery,
  resolveAuthorizationProviderId,
  sortOAuthWorkspaceRecords,
  updateWorkspaceSearch,
  workspaceProviderCounts,
  workspaceProviderOptions,
  type OAuthWorkspaceQuotaFilter,
  type OAuthWorkspaceRecord,
} from './oauthWorkspaceLogic';
import styles from './OAuthManagementPage.module.css';

interface OAuthManagementViewPreference {
  pageSize: 12 | 24 | 48;
}

const DEFAULT_VIEW_PREFERENCE: OAuthManagementViewPreference = {
  pageSize: 12,
};

function parseViewPreference(raw: unknown): OAuthManagementViewPreference | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  const pageSize = record.pageSize === 12 || record.pageSize === 24 || record.pageSize === 48
    ? record.pageSize
    : DEFAULT_VIEW_PREFERENCE.pageSize;
  return { pageSize };
}

interface CompletionPending {
  providerId: string;
  snapshot: Set<string>;
  startedAt: number;
}

interface CompletionResult {
  providerId: string;
  kind: 'new' | 'ambiguous' | 'refresh-failed';
  recordKey?: string;
}

interface SelectedIdentity {
  key: string;
  name: string;
  authIndex?: string;
}

export const OAuthManagementPage: React.FC = () => {
  const t = useT();
  const { message, modal } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const visibleNow = useVisibleNow();
  const [isFiltersOpen, setIsFiltersOpen] = React.useState(false);
  const isDemo = isDemoMode();
  const viewPreference = usePreference<OAuthManagementViewPreference>(
    'oauth_management_view_v1',
    DEFAULT_VIEW_PREFERENCE,
    parseViewPreference,
  );
  const queryState = React.useMemo(() => parseOAuthWorkspaceQuery(searchParams), [searchParams]);
  React.useEffect(() => {
    if (queryState.status !== 'all' || queryState.quota !== 'all' || queryState.sort !== 'name-asc') {
      setIsFiltersOpen(true);
    }
  }, [queryState.status, queryState.quota, queryState.sort]);


  const filesQuery = useQuery({
    queryKey: ['management-auth-files'],
    queryFn: () => api.getManagementAuthFiles(),
    refetchInterval: 60_000,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
  const quotaQuery = useQuery({
    queryKey: ['management-quota'],
    queryFn: api.getQuotaOverview,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
  const pluginsQuery = useQuery({
    queryKey: ['management-plugins'],
    queryFn: api.getPlugins,
    staleTime: 30_000,
  });

  const choices = React.useMemo(
    () => oauthProviderChoices(pluginsQuery.data?.plugins, t),
    [pluginsQuery.data?.plugins, t],
  );
  const pluginLogos = React.useMemo(
    () => pluginOAuthProviderLogos(pluginsQuery.data?.plugins),
    [pluginsQuery.data?.plugins],
  );
  const projection = React.useMemo(
    () => buildOAuthWorkspaceProjection(
      filesQuery.data?.files ?? [],
      quotaQuery.data?.quotas ?? [],
      choices,
    ),
    [choices, filesQuery.data?.files, quotaQuery.data?.quotas],
  );
  const records = projection.records;
  const recordsRef = React.useRef(records);
  React.useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  const providerOptions = React.useMemo(() => workspaceProviderOptions(records, choices), [choices, records]);
  const providerCounts = React.useMemo(() => workspaceProviderCounts(records), [records]);
  const visibleRecords = React.useMemo(
    () => sortOAuthWorkspaceRecords(
      filterOAuthWorkspaceRecords(
        records,
        queryState.query,
        queryState.provider,
        queryState.status,
        queryState.quota,
      ),
      queryState.sort,
    ),
    [queryState.provider, queryState.query, queryState.quota, queryState.sort, queryState.status, records],
  );

  const pageSize = searchParams.has('page_size') ? queryState.pageSize : viewPreference.value.pageSize;
  const maxPage = Math.max(1, Math.ceil(visibleRecords.length / pageSize));
  const page = Math.min(queryState.page, maxPage);
  const pagedRecords = React.useMemo(
    () => visibleRecords.slice((page - 1) * pageSize, page * pageSize),
    [page, pageSize, visibleRecords],
  );

  const setSearch = React.useCallback((
    changes: Record<string, string | number | null | undefined>,
  ) => {
    setSearchParams((current) => updateWorkspaceSearch(current, changes), { replace: true });
  }, [setSearchParams]);

  React.useEffect(() => {
    if (!filesQuery.data || queryState.page <= maxPage) return;
    setSearch({ page: maxPage === 1 ? null : maxPage });
  }, [filesQuery.data, maxPage, queryState.page, setSearch]);

  const [resetSearchToken, setResetSearchToken] = React.useState(0);
  const [searchValue, setSearchValue] = useDebouncedSearch(
    queryState.query,
    (value) => setSearch({ q: value || null, page: null }),
    resetSearchToken,
  );

  // Consume one-shot navigation intent before the connect panel arms overlay history,
  // so Back closes the panel once instead of reopening it from a stale query value.
  const [pendingIntent, setPendingIntent] = React.useState<{ connect: boolean; provider?: string; focusQuota: boolean }>();
  const [pendingFocusQuota, setPendingFocusQuota] = React.useState(false);
  React.useEffect(() => {
    if (!queryState.action && !queryState.focus) return;
    setPendingIntent({
      connect: queryState.action === 'connect',
      provider: queryState.connectProvider,
      focusQuota: queryState.focus === 'quota',
    });
    if (queryState.focus === 'quota') setPendingFocusQuota(true);
    setSearchParams(consumeOneShotIntent(searchParams), { replace: true });
  }, [queryState.action, queryState.connectProvider, queryState.focus, searchParams, setSearchParams]);

  const [isConnectOpen, setIsConnectOpen] = React.useState(false);
  const [connectProviderId, setConnectProviderId] = React.useState('');
  React.useEffect(() => {
    if (!pendingIntent || searchParams.has('action') || searchParams.has('focus')) return;
    if (pendingIntent.connect) {
      setConnectProviderId(pendingIntent.provider ?? '');
      setIsConnectOpen(true);
    }
    setPendingIntent(undefined);
  }, [pendingIntent, searchParams]);

  React.useEffect(() => {
    if (!pendingFocusQuota) return;
    if (filesQuery.isError) {
      setPendingFocusQuota(false);
      return;
    }
    if (!filesQuery.data) return;
    const frame = window.requestAnimationFrame(() => {
      document.querySelector('[data-quota-focus-anchor]')?.scrollIntoView({ block: 'start' });
      setPendingFocusQuota(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [filesQuery.data, filesQuery.isError, pendingFocusQuota]);

  const [completionPending, setCompletionPending] = React.useState<Record<string, CompletionPending>>({});
  const [completionResults, setCompletionResults] = React.useState<Record<string, CompletionResult>>({});
  const preStartSnapshotRef = React.useRef<Record<string, Set<string>>>({});
  const handleAuthorizationCompleted = React.useCallback((providerId: string) => {
    const snapshot = preStartSnapshotRef.current[providerId]
      ?? new Set(recordsRef.current.map((record) => record.key));
    setCompletionPending((previous) => ({
      ...previous,
      [providerId]: { providerId, snapshot, startedAt: Date.now() },
    }));
  }, []);
  const sessions = useOAuthSessions(choices, handleAuthorizationCompleted);
  const startSession = React.useCallback((providerId: string) => {
    preStartSnapshotRef.current[providerId] = new Set(recordsRef.current.map((record) => record.key));
    return sessions.start(providerId);
  }, [sessions]);
  const sessionController = React.useMemo(
    () => ({ ...sessions, start: startSession }),
    [sessions, startSession],
  );

  // Sessions outlive the drawer, so an ordinary route departure must be an
  // explicit operator decision. The browser handles hard unloads; the router
  // blocker covers in-app navigation without a history monkey patch.
  const routeBlocker = useBlocker(({ currentLocation, nextLocation }) => (
    sessions.activeProviders.length > 0 && currentLocation.pathname !== nextLocation.pathname
  ));
  React.useEffect(() => {
    if (routeBlocker.state !== 'blocked') return;
    modal.confirm({
      title: t('omc.leave_active_auth_title'),
      content: t('omc.leave_active_auth_desc'),
      okText: t('omc.leave_anyway'),
      cancelText: t('common.cancel'),
      onOk: () => routeBlocker.proceed(),
      onCancel: () => routeBlocker.reset(),
    });
  }, [modal, routeBlocker, t]);
  React.useEffect(() => {
    if (sessions.activeProviders.length === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [sessions.activeProviders.length]);

  React.useEffect(() => {
    if (Object.keys(completionPending).length === 0 || filesQuery.isFetching) return;
    const settled: string[] = [];
    const nextResults: Record<string, CompletionResult> = {};
    for (const [providerId, pending] of Object.entries(completionPending)) {
      if (filesQuery.isError) {
        nextResults[providerId] = { providerId, kind: 'refresh-failed' };
        settled.push(providerId);
        continue;
      }
      if (filesQuery.dataUpdatedAt <= pending.startedAt) continue;
      const candidates = records.filter((record) => {
        if (pending.snapshot.has(record.key)) return false;
        return record.authorizationProviderId === providerId || record.displayProvider === providerId;
      });
      nextResults[providerId] = candidates.length === 1
        ? { providerId, kind: 'new', recordKey: candidates[0].key }
        : { providerId, kind: 'ambiguous' };
      settled.push(providerId);
    }
    if (settled.length === 0) return;
    setCompletionResults((previous) => ({ ...previous, ...nextResults }));
    setCompletionPending((previous) => {
      const next = { ...previous };
      settled.forEach((providerId) => delete next[providerId]);
      return next;
    });
    settled.forEach((providerId) => delete preStartSnapshotRef.current[providerId]);
  }, [
    completionPending,
    filesQuery.dataUpdatedAt,
    filesQuery.isError,
    filesQuery.isFetching,
    records,
  ]);

  const [selectedKeys, setSelectedKeys] = React.useState<string[]>([]);
  const selectedKeySet = React.useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const selectedRecords = React.useMemo(
    () => records.filter((record) => selectedKeySet.has(record.key) && record.canSelectForFileBatch),
    [records, selectedKeySet],
  );
  React.useEffect(() => {
    const selectableKeys = new Set(records.filter((record) => record.canSelectForFileBatch).map((record) => record.key));
    setSelectedKeys((previous) => {
      const next = previous.filter((key) => selectableKeys.has(key));
      return next.length === previous.length ? previous : next;
    });
  }, [records]);

  const [selectedIdentity, setSelectedIdentity] = React.useState<SelectedIdentity>();
  const [drawerSection, setDrawerSection] = React.useState<'overview' | 'configuration' | 'models'>('overview');
  const selectedRecord = selectedIdentity
    ? records.find((record) => record.key === selectedIdentity.key)
    : undefined;
  React.useEffect(() => {
    if (selectedIdentity && !selectedRecord) setSelectedIdentity(undefined);
  }, [selectedIdentity, selectedRecord]);

  const [isAliasOpen, setIsAliasOpen] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const onTargetGone = React.useCallback((recordKey: string) => {
    setSelectedIdentity((current) => (current?.key === recordKey ? undefined : current));

  }, []);
  const actions = useOAuthWorkspaceActions(records, selectedKeys, setSelectedKeys, onTargetGone);

  const reloadWorkspace = React.useCallback(() => {
    void Promise.all([
      filesQuery.refetch(),
      quotaQuery.refetch(),
      pluginsQuery.refetch(),
    ]);
  }, [filesQuery, pluginsQuery, quotaQuery]);

  const totalCount = records.length;
  const disabledCount = records.filter((record) => isAuthFileDisabled(record.file)).length;
  const attentionCount = records.filter((record) => !isAuthFileDisabled(record.file) && (record.isQuotaAttention || isAuthFileProblem(record.file))).length;
  const healthyCount = records.filter((record) => isAuthFileHealthy(record.file) && !record.isQuotaAttention).length;
  const knownTotal = filesQuery.isPending ? '—' : totalCount;

  const providerTabs = React.useMemo(
    () => providerFilterTabs([...records.map((record) => record.displayProvider), ...providerOptions]),
    [providerOptions, records],
  );
  const hiddenSelectionCount = selectedRecords.filter(
    (record) => !pagedRecords.some((pageRecord) => pageRecord.key === record.key),
  ).length;
  const eligibleFilteredRefreshCount = React.useMemo(
    () => new Set(visibleRecords.filter((record) => record.canRefreshQuota).map((record) => record.authIndex)).size,
    [visibleRecords],
  );

  const displayProviderForAuthorization = React.useCallback((providerId: string) => (
    records.find((record) => record.authorizationProviderId === providerId)?.displayProvider ?? providerId
  ), [records]);

  const openConnect = () => {
    const selectedProvider = queryState.provider !== 'all'
      ? resolveAuthorizationProviderId(queryState.provider, choices)
      : undefined;
    setConnectProviderId(selectedProvider ?? '');
    setIsConnectOpen(true);
  };

  const openCredential = (
    record: OAuthWorkspaceRecord,
    section: 'overview' | 'configuration' | 'models' = 'overview',
  ) => {
    setDrawerSection(section);
    setSelectedIdentity({ key: record.key, name: record.fileName, authIndex: record.authIndex });
  };

  const openConnectForRecord = (record: OAuthWorkspaceRecord) => {
    const providerId = record.authorizationProviderId;
    if (!providerId) {
      message.warning(t('omc.reauth_unavailable', { provider: record.displayProvider }));
      return;
    }
    setConnectProviderId(providerId);
    setIsConnectOpen(true);
  };

  const revealCompletedCredential = (providerId: string, result: CompletionResult) => {
    const completedRecord = result.recordKey
      ? records.find((record) => record.key === result.recordKey)
      : undefined;
    const displayProvider = completedRecord?.displayProvider
      || displayProviderForAuthorization(providerId);
    setSearch({ provider: displayProvider, page: null });
    setIsConnectOpen(false);
    const recordKey = result.recordKey;
    if (recordKey) {
      window.requestAnimationFrame(() => {
        document.querySelector(`[data-identity="${CSS.escape(recordKey)}"]`)?.scrollIntoView({ block: 'center' });
      });
    }
    setCompletionResults((previous) => {
      const next = { ...previous };
      delete next[providerId];
      return next;
    });
  };

  const sessionEntries = Object.entries(sessions.states)
    .filter(([, state]) => state.status === 'starting' || state.status === 'waiting' || state.status === 'error')
    .map(([providerId, state]) => ({
      providerId,
      state,
      choice: choices.find((choice) => choice.id === providerId),
    }));

  const quotaBodyForRecord = (record: OAuthWorkspaceRecord, forRow = false): React.ReactNode => {
    if (record.quota) {
      const isRefreshing = Boolean(record.authIndex && actions.busyQuotaIndexes.has(record.authIndex));
      if (forRow) {
        return (
          <CompactQuotaView
            item={record.quota}
            nowMS={visibleNow}
          />
        );
      }
      return (
        <CredentialQuotaBody
          item={record.quota}
          nowMS={visibleNow}
          isDemo={isDemo}
          isRefreshing={isRefreshing}
          onRefresh={() => void actions.refreshQuotaForRecord(record)}
          onClearCooldown={() => void actions.clearCooldown(record)}
          onRedeemCredit={() => void actions.redeemCredit(record)}
        />
      );
    }
    const quotaMessage = record.quotaMatch === 'missing-index'
      ? t('omc.quota_missing_index')
      : record.quotaMatch === 'ambiguous-file-index' || record.quotaMatch === 'ambiguous-quota-index'
        ? t('omc.quota_ambiguous')
        : t('omc.quota_unobserved');
    return (
      <Alert
        type={record.quotaMatch === 'missing-quota' ? 'info' : 'warning'}
        showIcon
        title={quotaMessage}
        action={record.canRefreshQuota ? (
          <Button size="small" onClick={() => void actions.refreshQuotaForRecord(record)}>
            {t('quota.btn_refresh_quota')}
          </Button>
        ) : undefined}
      />
    );
  };

  return (
    <div className={`terminal-page oauth-management-page ${styles.page}`}>
      <header className={styles.head}>
        <div className={styles['head-title-group']}>
          <h1 className="terminal-title">{t('nav.auth_files')}</h1>
          <div className={styles['summary-strip']}>
            <span className={styles['summary-total']}>
              {t('af.meta_total', { n: knownTotal })}
            </span>
            <span className={styles['summary-divider']}>·</span>
            <span className={styles['summary-healthy']}>
              <span className={styles['status-dot']} />
              {t('af.meta_active', { n: filesQuery.isPending ? '—' : healthyCount })}
            </span>
            {(filesQuery.isPending || disabledCount > 0) && (
              <>
                <span className={styles['summary-divider']}>·</span>
                <span className={styles['summary-disabled']}>
                  <span className={styles['status-dot']} />
                  {t('af.meta_disabled', { n: filesQuery.isPending ? '—' : disabledCount })}
                </span>
              </>
            )}
            {(filesQuery.isPending || attentionCount > 0) && (
              <>
                <span className={styles['summary-divider']}>·</span>
                <span className={styles['summary-attention']}>
                  <span className={styles['status-dot']} />
                  {t('omc.quota_filter_attention')} {filesQuery.isPending ? '—' : attentionCount}
                </span>
              </>
            )}
          </div>
        </div>
        <div className={styles.actions}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            multiple
            hidden
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              actions.upload(files);
            }}
          />
          <Button type="primary" icon={<LoginOutlined />} onClick={openConnect}>
            {t('omc.connect_account')}
          </Button>
          <Button
            icon={<UploadOutlined />}
            disabled={isDemo || actions.isOperating}
            onClick={() => fileInputRef.current?.click()}
          >
            {t('af.upload')}
          </Button>
          <Button
            icon={<BranchesOutlined />}
            disabled={actions.isOperating}
            onClick={() => setIsAliasOpen(true)}
            data-testid="oauth-management-model-alias-open"
          >
            {t('af.alias_open')}
          </Button>
        </div>
      </header>

      {sessionEntries.length > 0 && (
        <div className={styles['session-strip']} aria-live="polite">
          <span className={styles['session-strip-label']}>{t('omc.active_authorizations')}</span>
          {sessionEntries.map(({ providerId, state, choice }) => (
            <span className={styles['session-pill']} data-testid="oauth-session-pill" key={providerId}>
              <span>{choice?.title ?? providerId}</span>
              <span>·</span>
              <span>
                {state.status === 'error'
                  ? t('omc.session_failed')
                  : state.status === 'starting'
                    ? t('common.loading')
                    : t('omc.session_waiting')}
              </span>
              <Button
                type="link"
                size="small"
                onClick={() => {
                  setConnectProviderId(providerId);
                  setIsConnectOpen(true);
                }}
              >
                {state.status === 'error' ? t('common.retry') : t('common.details')}
              </Button>
            </span>
          ))}
        </div>
      )}

      {Object.entries(completionResults).map(([providerId, result]) => (
        <Alert
          key={providerId}
          className={styles['diagnostic-bar']}
          type={result.kind === 'new' ? 'success' : 'warning'}
          showIcon
          title={
            result.kind === 'new'
              ? t('omc.oauth_success_new_credential')
              : result.kind === 'ambiguous'
                ? t('omc.oauth_success_ambiguous')
                : t('omc.oauth_success_refresh_failed')
          }
          action={(
            <Space>
              <Button size="small" onClick={() => revealCompletedCredential(providerId, result)}>{t('omc.view_credentials')}</Button>
              <Button
                size="small"
                type="text"
                onClick={() => setCompletionResults((previous) => {
                  const next = { ...previous };
                  delete next[providerId];
                  return next;
                })}
              >
                {t('common.close')}
              </Button>
            </Space>
          )}
        />
      ))}

      {(projection.duplicateAuthIndexes.length > 0
        || projection.duplicateFileNames.length > 0
        || projection.missingAuthIndexCount > 0
        || projection.quotaOnly.length > 0) && (
          <Alert
            className={styles['diagnostic-bar']}
            type="warning"
            showIcon
            title={t('af.status_problem')}
            description={t('omc.sync_diagnostics_desc', {
              duplicateIndexes: projection.duplicateAuthIndexes.length,
              duplicateFiles: projection.duplicateFileNames.length,
              missingIndexes: projection.missingAuthIndexCount,
              quotaOnly: projection.quotaOnly.length,
            })}
            action={<Button size="small" onClick={reloadWorkspace}>{t('common.retry')}</Button>}
          />
        )}

      {filesQuery.isError && (
        <Alert
          className={styles['diagnostic-bar']}
          type="error"
          showIcon
          title={t('af.error')}
          description={filesQuery.error instanceof Error ? filesQuery.error.message : t('af.request_failed')}
          action={<Button size="small" onClick={() => void filesQuery.refetch()}>{t('common.retry')}</Button>}
        />
      )}
      {quotaQuery.isError && (
        <Alert
          className={styles['diagnostic-bar']}
          type="warning"
          showIcon
          title={t('omc.quota_read_failed')}
          description={quotaQuery.error instanceof Error ? quotaQuery.error.message : t('af.request_failed')}
          action={<Button size="small" onClick={() => void quotaQuery.refetch()}>{t('common.retry')}</Button>}
        />
      )}
      {pluginsQuery.isError && (
        <Alert
          className={styles['diagnostic-bar']}
          type="warning"
          showIcon
          title={t('omc.plugin_discovery_failed')}
          description={t('omc.plugin_builtins_retained')}
        />
      )}

      <ProviderFilterTabs
        providers={providerTabs.filter((provider) => provider === 'all' || provider === queryState.provider || (providerCounts[provider] ?? 0) > 0)}
        counts={providerCounts}
        active={queryState.provider}
        onChange={(provider) => setSearch({ provider: provider === 'all' ? null : provider, page: null })}
        pluginLogos={pluginLogos}
      />

      <BatchActionBar
        selectedCount={selectedRecords.length}
        selectablePageCount={pagedRecords.filter((record) => record.canSelectForFileBatch).length}
        hiddenCount={hiddenSelectionCount}
        isMutating={actions.isOperating}
        onSelectPage={() => {
          const keys = pagedRecords.filter((record) => record.canSelectForFileBatch).map((record) => record.key);
          setSelectedKeys((previous) => Array.from(new Set([...previous, ...keys])));
        }}
        onClearSelection={() => setSelectedKeys([])}
        onEnable={() => void actions.batchStatus(false, selectedRecords)}
        onDisable={() => void actions.batchStatus(true, selectedRecords)}
        onDelete={() => void actions.batchDelete(selectedRecords)}
      />

      <div className={styles.toolbar}>
        <div className={styles.search}>
          <Input
            prefix={<SearchOutlined />}
            value={searchValue}
            allowClear
            aria-label={t('af.search_ph')}
            placeholder={t('af.search_ph')}
            onChange={(event) => setSearchValue(event.target.value)}
          />
        </div>
        <Button
          className={styles['filter-toggle']}
          icon={<FilterOutlined />}
          aria-expanded={isFiltersOpen}
          aria-controls="oauth-collection-filters"
          type={isFiltersOpen || queryState.status !== 'all' || queryState.quota !== 'all' || queryState.sort !== 'name-asc' ? 'primary' : 'default'}
          onClick={() => setIsFiltersOpen((open) => !open)}
        >
          {t('events.more_filters')}
        </Button>
        <Dropdown.Button
          icon={<DownOutlined />}
          disabled={visibleRecords.length === 0}
          menu={{
            items: [
              { key: 'page', label: t('omc.refresh_scope_page', { n: pagedRecords.filter((record) => record.canRefreshQuota).length }) },
              { key: 'filtered', label: t('omc.refresh_scope_filtered', { n: eligibleFilteredRefreshCount }) },
              { key: 'all', label: t('omc.refresh_scope_all', { n: new Set(records.filter((record) => record.canRefreshQuota).map((record) => record.authIndex)).size }) },
            ],
            onClick: ({ key }) => void actions.refreshQuota(key as 'page' | 'filtered' | 'all', visibleRecords, pagedRecords, records),
          }}
          onClick={() => void actions.refreshQuota('filtered', visibleRecords, pagedRecords, records)}
          loading={actions.busyQuotaIndexes.size > 0}
        >
          <SyncOutlined /> {t('omc.refresh_quota_count', { n: eligibleFilteredRefreshCount })}
        </Dropdown.Button>
      </div>
      {isFiltersOpen && (
        <div id="oauth-collection-filters" className={styles['advanced-filters']}>
          <div className={styles['filter-field']}>
            <span className={styles['filter-field-label']}>{t('af.detail_status')}</span>
            <Select<AuthFileStatusFilter>
              value={queryState.status}
              onChange={(status) => setSearch({ status: status === 'all' ? null : status, page: null })}
              aria-label={t('af.detail_status')}
              style={{ width: 140 }}
              options={[
                { value: 'all', label: t('af.status_all') },
                { value: 'enabled', label: t('af.enabled') },
                { value: 'disabled', label: t('af.disabled') },
                { value: 'problem', label: t('af.status_problem') },
              ]}
            />
          </div>
          <div className={styles['filter-field']}>
            <span className={styles['filter-field-label']}>{t('omc.tab_quota')}</span>
            <Select<OAuthWorkspaceQuotaFilter>
              value={queryState.quota}
              onChange={(quota) => setSearch({ quota: quota === 'all' ? null : quota, page: null })}
              aria-label={t('omc.tab_quota')}
              style={{ width: 160 }}
              options={[
                { value: 'all', label: t('common.all') },
                { value: 'attention', label: t('omc.quota_filter_attention') },
                { value: 'healthy', label: t('quota.status_normal') },
                { value: 'warning', label: t('quota.status_warning') },
                { value: 'exhausted', label: t('quota.status_exceeded') },
                { value: 'cooldown', label: t('quota.status_cooldown') },
                { value: 'stale', label: t('quota.status_stale') },
                { value: 'error', label: t('quota.status_error') },
                { value: 'unobserved', label: t('omc.quota_unobserved') },
                { value: 'unsupported', label: t('omc.quota_unsupported') },
              ]}
            />
          </div>
          <div className={styles['filter-field']}>
            <span className={styles['filter-field-label']}>{t('af.sort_label')}</span>
            <Select<AuthFileSortKey>
              value={queryState.sort}
              onChange={(sort) => setSearch({ sort: sort === 'name-asc' ? null : sort, page: null })}
              style={{ width: 160 }}
              options={[
                { value: 'name-asc', label: t('af.sort_name_asc') },
                { value: 'name-desc', label: t('af.sort_name_desc') },
                { value: 'requests-desc', label: t('af.sort_requests') },
                { value: 'priority-desc', label: t('af.sort_priority') },
                { value: 'weight-desc', label: t('af.sort_weight') },
              ]}
            />
          </div>
          <div className={styles['toolbar-actions']}>
            <Button
              icon={<SearchOutlined />}
              onClick={() => {
                setResetSearchToken((value) => value + 1);
                setSearch({ q: null, status: null, quota: null, sort: null, page: null });
              }}
            >
              {t('omc.reset_filters')}
            </Button>
          </div>
        </div>
      )}

      {actions.quotaReport && (
        <Alert
          className={styles['quota-operation-report']}
          data-testid="quota-operation-report"
          closable={{ onClose: actions.clearQuotaReport }}
          type="warning"
          showIcon
          title={t('omc.quota_refresh_report', {
            succeeded: actions.quotaReport.succeeded,
            failed: actions.quotaReport.failed + actions.quotaReport.unknown,
            skipped: actions.quotaReport.skipped,
          })}
          // Only a run with a failure reaches this report, and the per-target reason is the
          // point of it, so the detail is on screen rather than behind a disclosure. The
          // scroll keeps a long list of failures bounded.
          description={actions.quotaReport.details.length > 0 ? (
            <div className="operation-detail-scroll">
              {actions.quotaReport.details.map((item, index) => (
                <div key={`${item.name}-${index}`}><span className="mono-num">{item.name}</span>: {item.reason}</div>
              ))}
            </div>
          ) : undefined}
        />
      )}

      {filesQuery.isPending && !filesQuery.data ? (
        <div className="dashboard-loading"><Spin><div style={{ minHeight: 80, minWidth: 220 }} /></Spin></div>
      ) : visibleRecords.length === 0 ? (
        <div className={`terminal-panel ${styles.empty}`}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={records.length === 0 ? t('af.empty_all') : t('af.empty_filter')}
          />
        </div>
      ) : (
        <>
          <div className={`terminal-panel ${styles.records}`}>
            <div className={styles['table-header']} aria-hidden="true">
              <div className={styles['th-identity']}>
                <span>{t('omc.col_credential')}</span>
              </div>
              <div className={styles['th-status']}>{t('af.detail_status')}</div>
              <div className={styles['th-management']}>{t('omc.col_traffic')}</div>
              <div className={styles['th-quota']}>{t('omc.col_quota_window')}</div>
              <div className={styles['th-actions']}>{t('keys.col_actions')}</div>
            </div>
            {pagedRecords.map((record) => (
              <div key={record.key} data-quota-focus-anchor={record.quota ? record.authIndex : undefined}>
                <OAuthCredentialRecord
                  file={record.file}
                  identityKey={record.key}
                  displayProvider={record.displayProvider}
                  pluginLogo={pluginOAuthLogoFor(pluginLogos, record.displayProvider)}
                  selected={selectedKeySet.has(record.key)}
                  busy={actions.isRecordBusy(record)}
                  canTargetFile={record.canSelectForFileBatch}
                  onSelect={(checked) => {
                    setSelectedKeys((previous) => (
                      checked
                        ? Array.from(new Set([...previous, record.key]))
                        : previous.filter((key) => key !== record.key)
                    ));
                  }}
                  onToggle={() => void actions.toggleOne(record)}
                  onDownload={() => actions.download(record)}
                  onDelete={() => void actions.deleteOne(record)}
                  onEdit={() => openCredential(record, 'configuration')}
                  onShowModels={() => openCredential(record, 'models')}
                  onShowDetails={() => openCredential(record, 'overview')}
                  onRefreshQuota={() => void actions.refreshQuotaForRecord(record)}
                  canRefreshQuota={record.canRefreshQuota}
                  isRefreshingQuota={Boolean(record.authIndex && actions.busyQuotaIndexes.has(record.authIndex))}
                  onClearCooldown={() => void actions.clearCooldown(record)}
                  canClearCooldown={record.canClearCooldown}
                  quotaContent={quotaBodyForRecord(record, true)}
                  identityDiagnostic={!record.hasUniqueFileName ? (
                    <Alert
                      type="warning"
                      showIcon
                      title={t('omc.duplicate_file_identity', { name: record.fileName })}
                    />
                  ) : undefined}
                  reauthAction={record.quota?.recommendation?.action === 'reauth' ? (
                    <Button type="link" size="small" onClick={() => openConnectForRecord(record)}>
                      {t('omc.reauthenticate')}
                    </Button>
                  ) : undefined}
                />
              </div>
            ))}
          </div>
          <div className={styles.pagination}>
            <span>{t('omc.result_count', { n: visibleRecords.length, total: records.length })}</span>
            <Select
              value={pageSize}
              onChange={(size) => {
                const next = size as 12 | 24 | 48;
                setSearch({ page_size: next, page: null });
                void viewPreference.set({ pageSize: next });
              }}
              style={{ width: 110 }}
              options={[12, 24, 48].map((size) => ({ value: size, label: t('af.page_size_n', { n: size }) }))}
            />

            {visibleRecords.length > pageSize && (
              <Pagination
                current={page}
                pageSize={pageSize}
                total={visibleRecords.length}
                showSizeChanger={false}
                showQuickJumper
                onChange={(nextPage) => setSearch({ page: nextPage === 1 ? null : nextPage })}
              />
            )}
          </div>
        </>
      )}

      <OAuthConnectPanel
        open={isConnectOpen}
        choices={choices}
        selectedProviderId={connectProviderId || undefined}
        onSelectProvider={setConnectProviderId}
        onClose={() => setIsConnectOpen(false)}
        onViewCredentials={(providerId) => {
          setSearch({ provider: displayProviderForAuthorization(providerId), page: null });
          setIsConnectOpen(false);
        }}
        sessions={sessionController}
      />

      <AuthFileDetailDrawer
        file={selectedRecord?.file ?? null}
        open={Boolean(selectedRecord)}
        onClose={() => setSelectedIdentity(undefined)}
        onSaved={() => {
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ['management-auth-files'] }),
            queryClient.invalidateQueries({ queryKey: ['management-quota'] }),
            queryClient.invalidateQueries({ queryKey: ['management-overview'] }),
          ]);
        }}
        onDownload={() => {
          const latest = selectedRecord
            ? recordsRef.current.find((record) => record.key === selectedRecord.key)
            : undefined;
          if (latest) actions.download(latest);
        }}
        initialSection={drawerSection}
        canEdit={Boolean(selectedRecord?.canEditFile)}
        quotaContent={selectedRecord ? quotaBodyForRecord(selectedRecord, false) : undefined}
      />

      <OAuthModelAliasDrawer
        open={isAliasOpen}
        onClose={() => setIsAliasOpen(false)}
        onSaved={() => {
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: ['management-oauth-model-aliases'] }),
            queryClient.invalidateQueries({ queryKey: ['auth-file-models'] }),
            queryClient.invalidateQueries({ queryKey: ['management-overview'] }),
          ]);
        }}
        providerOptions={providerOptions.filter((provider) => provider !== 'all')}
      />
    </div>
  );
};
