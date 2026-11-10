import type { OAuthRecoveryTarget } from '../../types/oauth';
import React from 'react';
import { useBlocker } from 'react-router-dom';
import { App as AntdApp, Button, Checkbox, Dropdown, Select, Space } from 'antd';
import { ListPlaceholder, LoadingRegion } from '../../components/common/Placeholder';
import {
  BranchesOutlined,
  CloudUploadOutlined,
  DownOutlined,
  LoginOutlined,
  TimerResetOutlined,
  UploadOutlined,
} from '../../components/icons';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import { useDebouncedSearch } from '../../components/usage/useDebouncedSearch';
import { useOAuthManagementViewState } from './useOAuthManagementViewState';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import { isDemoMode } from '../../types/demoMode';
import { pluginMultiPortalKeys, pluginOAuthProviderLogos, pluginOAuthProviderTitles } from '../../types/pluginOAuthProviders';
import { storeListingsByPluginId } from '../../components/plugins/pluginStoreLogic';
import { BatchActionBar } from '../../components/authFiles/BatchActionBar';
import { useCredentialRename } from '../../components/authFiles/useCredentialRename';
import { WarmupSettingsDrawer } from '../../components/authFiles/CredentialWarmup';
import { oauthProviderChoices } from '../oauthProviderLogic';
import { providerDisplayName } from '../../types/providerMetadata';
import { CredentialQuotaBody } from '../quota/CredentialQuotaBody';
import { buildCredentialSections, credentialOrderKey, orderBySection, providersInSectionOrder, type QuotaColumnSort } from './credentialSections';
import { useCredentialOrder } from './useCredentialOrder';
import { useOAuthSectionOrder } from './useOAuthSectionOrder';
import { moveKey, type DropSide } from '../../types/displayOrder';
import { useOAuthSessions } from './useOAuthSessions';
import { OAuthSessionStrip } from './OAuthSessionStrip';
import { isSIWCPending, siwcTargetKey, useSIWCBindings } from '../../hooks/useSIWCBindings';
import { siwcBadgeState } from '../../components/authFiles/siwcBadge';
import { useOAuthWorkspaceActions } from './useOAuthWorkspaceActions';
import {
  buildOAuthWorkspaceProjection,
  consumeOneShotIntent,
  filterOAuthWorkspaceRecords,
  maskedCredentialLabel,
  resolveAuthorizationProviderId,
  sortOAuthWorkspaceRecords,
  DEFAULT_OAUTH_SORT,
  workspaceProviderOptions,
  type OAuthWorkspaceRecord,
} from './oauthWorkspaceLogic';
import { healthCounts, matchesHealthLens, providerSummaries } from './fleetPresentation';
import { FleetToolbar } from './FleetHeader';
import { ProviderStrip } from './ProviderStrip';
import { CredentialList, type CredentialGroup } from './CredentialList';
import { CredentialCards } from './CredentialCards';
import type { CredentialActions, DetailSection } from './CredentialParts';
import styles from './OAuthManagementPage.module.css';
import { CredentialMark } from '../../components/LobeIcon';
import { PageHeader } from '../../components/common/PageHeader';
import { LoadFailure, Notice, useToast } from '../../components/feedback';
import { EmptyState } from '../../components/common/EmptyState';
import { ToolButton } from '../../components/common/ToolButton';
import { Pager } from '../../components/common/Pager';
import { DeferredMount } from '../../components/common/DeferredMount';
import { createRouteLoader } from '../../utils/routeLoader';
import { pickRows, type SelectionAnchor } from '../../types/rowSelection';

const AuthFileDetailDrawer = React.lazy(createRouteLoader(() =>
  import('../../components/authFiles/AuthFileDetailDrawer').then(module => ({ default: module.AuthFileDetailDrawer }))));
const OAuthModelRulesDrawer = React.lazy(createRouteLoader(() =>
  import('../../components/authFiles/OAuthModelRulesDrawer').then(module => ({ default: module.OAuthModelRulesDrawer }))));
const AuthJsonUploadModal = React.lazy(createRouteLoader(() =>
  import('../../components/authFiles/AuthJsonUploadModal').then(module => ({ default: module.AuthJsonUploadModal }))));
const VertexImportModal = React.lazy(createRouteLoader(() =>
  import('../../components/authFiles/VertexImportModal').then(module => ({ default: module.VertexImportModal }))));
const OAuthConnectPanel = React.lazy(createRouteLoader(() =>
  import('./OAuthConnectPanel').then(module => ({ default: module.OAuthConnectPanel }))));
const SIWCDialog = React.lazy(createRouteLoader(() =>
  import('../../components/authFiles/SIWCDialog').then(module => ({ default: module.SIWCDialog }))));

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
  const { modal } = AntdApp.useApp();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { searchParams, setSearchParams, queryState, setSearch, isViewLoaded } = useOAuthManagementViewState();
  const visibleNow = useVisibleNow();
  const [isConnectOpen, setIsConnectOpen] = React.useState(false);
  const isDemo = isDemoMode();

  const filesQuery = useQuery({
    queryKey: ['management-auth-files'],
    queryFn: () => api.getManagementAuthFiles(),
    refetchInterval: 60_000,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
  });
  // The overview reads stored observations and CPA's credential list, never a provider, so polling
  // it spends no quota; it is what brings a reading the background refresh stored onto an open page.
  const quotaQuery = useQuery({
    queryKey: ['management-quota'],
    queryFn: api.getQuotaOverview,
    refetchInterval: 60_000,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
  const pluginsQuery = useQuery({
    queryKey: ['management-plugins'],
    queryFn: api.getPlugins,
    staleTime: 30_000,
  });
  // Which plugin published a sign-in is a store fact, so the login cards read the same
  // catalogue the plugin management page reads, under the same query key. It is enabled
  // only while the drawer is open: the catalogue is what its groups and badges are drawn
  // from, and a registry read is not worth making before there are cards to draw.
  const storeQuery = useQuery({
    queryKey: ['management-plugin-store'],
    queryFn: ({ signal }) => api.getPluginStore({ signal }),
    enabled: isConnectOpen && Boolean(pluginsQuery.data?.plugins.length),
    staleTime: 5 * 60_000,
  });
  const pluginCatalog = React.useMemo(() => storeListingsByPluginId(storeQuery.data?.plugins), [storeQuery.data]);

  const choices = React.useMemo(
    () => oauthProviderChoices(pluginsQuery.data?.plugins, t, pluginCatalog),
    [pluginsQuery.data?.plugins, t, pluginCatalog],
  );
  const pluginTitles = React.useMemo(() => pluginOAuthProviderTitles(pluginsQuery.data?.plugins), [pluginsQuery.data?.plugins]);
  const pluginLogos = React.useMemo(
    () => pluginOAuthProviderLogos(pluginsQuery.data?.plugins),
    [pluginsQuery.data?.plugins],
  );
  const multiPortalKeys = React.useMemo(() => pluginMultiPortalKeys(pluginsQuery.data?.plugins), [pluginsQuery.data?.plugins]);
  const projection = React.useMemo(
    () => buildOAuthWorkspaceProjection(
      filesQuery.data?.files ?? [],
      quotaQuery.data?.quotas ?? [],
      choices,
      multiPortalKeys,
    ),
    [choices, filesQuery.data?.files, multiPortalKeys, quotaQuery.data?.quotas],
  );
  const records = projection.records;
  const recordsRef = React.useRef(records);
  React.useEffect(() => {
    recordsRef.current = records;
  }, [records]);

  const providerOptions = React.useMemo(() => workspaceProviderOptions(records, choices), [choices, records]);
  // The scope is everything the provider, the search and the filters let through; the health band
  // counts it, and its lens narrows it to one verdict.
  const scopedRecords = React.useMemo(
    () => filterOAuthWorkspaceRecords(records, queryState.query, queryState.provider, queryState.status, queryState.quota),
    [queryState.provider, queryState.query, queryState.quota, queryState.status, records],
  );
  const scopeCounts = React.useMemo(() => healthCounts(scopedRecords), [scopedRecords]);
  const sortedRecords = React.useMemo(
    () => sortOAuthWorkspaceRecords(scopedRecords.filter((record) => matchesHealthLens(record, queryState.health)), queryState.sort),
    [queryState.health, queryState.sort, scopedRecords],
  );
  // A page is cut from the record order, which keeps a provider's credentials together, so a page
  // groups into the same sections the next page continues.
  const credentialOrder = useCredentialOrder();
  // The section arrangement is over every provider the workspace has, not just the page on screen, so
  // a drag moves the providers themselves and the pages are cut in that order.
  const sectionProviders = React.useMemo(() => providersInSectionOrder(records), [records]);
  const sectionOrder = useOAuthSectionOrder(sectionProviders);
  const isCustomOrder = queryState.sort === 'custom';
  const quotaDirection = queryState.sort === 'quota-asc' ? 'asc' : queryState.sort === 'quota-desc' ? 'desc' : undefined;
  // A quota order ranks each provider's credentials by the share left in their tightest limit.
  const quotaColumnSorts = React.useMemo(() => {
    const sorts: Partial<Record<string, QuotaColumnSort>> = {};
    if (quotaDirection) sectionProviders.forEach((provider) => { sorts[provider] = { key: 'quota', direction: quotaDirection }; });
    return sorts;
  }, [quotaDirection, sectionProviders]);
  const visibleRecords = React.useMemo(
    () => orderBySection(
      sortedRecords,
      quotaColumnSorts,
      isCustomOrder ? credentialOrder.value : undefined,
      sectionOrder.ordered,
    ),
    [sortedRecords, quotaColumnSorts, isCustomOrder, credentialOrder.value, sectionOrder.ordered],
  );
  // A drag rearranges the provider's whole list, filters and pages notwithstanding, starting from
  // the order on screen; under another sort that order becomes the custom one. The document then
  // names exactly the credentials the provider has, so deleted ones do not linger in it.
  const reorderCredential = React.useCallback((record: OAuthWorkspaceRecord, target: OAuthWorkspaceRecord, side: DropSide) => {
    if (!credentialOrder.loaded) return undefined;
    const provider = record.displayProvider;
    const arranged = orderBySection(
      sortOAuthWorkspaceRecords(records.filter((entry) => entry.displayProvider === provider), queryState.sort),
      {},
      isCustomOrder ? credentialOrder.value : undefined,
    );
    const keys = [...new Set(arranged.map(credentialOrderKey))];
    const next = moveKey(keys, credentialOrderKey(record), credentialOrderKey(target), side);
    if (next === keys) return undefined;
    const saved = credentialOrder.set({ ...credentialOrder.value, [provider]: [...next] });
    if (!isCustomOrder) setSearch({ sort: null });
    return saved;
  }, [credentialOrder, isCustomOrder, queryState.sort, records, setSearch]);

  const pageSize = queryState.pageSize;
  const maxPage = Math.max(1, Math.ceil(visibleRecords.length / pageSize));
  const page = Math.min(queryState.page, maxPage);
  const pagedRecords = React.useMemo(
    () => visibleRecords.slice((page - 1) * pageSize, page * pageSize),
    [page, pageSize, visibleRecords],
  );

  React.useEffect(() => {
    if (!filesQuery.data || queryState.page <= maxPage) return;
    // A clamp corrects the entry in force; pushed, Back would land on the page past the end again.
    setSearch({ page: maxPage === 1 ? null : maxPage }, { replace: true });
  }, [filesQuery.data, maxPage, queryState.page, setSearch]);

  const [resetSearchToken, setResetSearchToken] = React.useState(0);
  const [searchValue, setSearchValue] = useDebouncedSearch(
    queryState.query,
    (value) => setSearch({ q: value || null, page: null }),
    resetSearchToken,
  );

  // Consume one-shot navigation intent so it cannot reopen the panel on a later render.
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

  const [connectProviderId, setConnectProviderId] = React.useState('');
  const [connectRecoveryTarget, setConnectRecoveryTarget] = React.useState<OAuthRecoveryTarget>();
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
  const preStartSnapshotRef = React.useRef<Record<string, Set<string>>>({});
  const announceCompletionRef = React.useRef<(result: CompletionResult) => void>(() => undefined);
  const handleAuthorizationCompleted = React.useCallback((providerId: string, recovery?: OAuthRecoveryTarget) => {
    if (recovery) {
      void api.getManagementAuthFiles({ name: recovery.name, auth_index: recovery.auth_index }).then((result) => {
        if (result.files.length !== 1) { toast.warning(t('recovery.read_failed')); return; }
        toast.info(t('recovery.complete'));
      }).catch(() => toast.warning(t('recovery.read_failed')));
      return;
    }
    const snapshot = preStartSnapshotRef.current[providerId]
      ?? new Set(recordsRef.current.map((record) => record.key));
    setCompletionPending((previous) => ({
      ...previous,
      [providerId]: { providerId, snapshot, startedAt: Date.now() },
    }));
  }, [t, toast]);
  const siwcBindings = useSIWCBindings();
  const [siwcRecordKey, setSIWCRecordKey] = React.useState<string>();
  const sessions = useOAuthSessions(choices, handleAuthorizationCompleted, { shouldNotifyCompletion: false });
  const rememberPreStartSnapshot = React.useCallback((providerId: string) => {
    preStartSnapshotRef.current[providerId] = new Set(recordsRef.current.map((record) => record.key));
  }, []);
  const startSession = React.useCallback((providerId: string, proxyUrl?: string, recovery?: OAuthRecoveryTarget) => {
    rememberPreStartSnapshot(providerId);
    return sessions.start(providerId, proxyUrl, recovery);
  }, [rememberPreStartSnapshot, sessions]);
  const startDefaultRouteSession = React.useCallback((providerId: string, recovery?: OAuthRecoveryTarget) => {
    rememberPreStartSnapshot(providerId);
    return sessions.startDefaultRoute(providerId, recovery);
  }, [rememberPreStartSnapshot, sessions]);
  const displayedRecoveryTarget = sessions.states[connectProviderId]?.recoveryTarget ?? connectRecoveryTarget;
  const isRecoverySupported = Boolean(displayedRecoveryTarget && records.some((record) =>
    record.fileName === displayedRecoveryTarget.name
    && record.authIndex === displayedRecoveryTarget.auth_index
    && record.file.recovery_supported,
  ));
  const sessionController = React.useMemo(
    () => ({ ...sessions, start: startSession, startDefaultRoute: startDefaultRouteSession }),
    [sessions, startDefaultRouteSession, startSession],
  );

  // Sessions outlive the drawer, so an ordinary route departure must be an
  // explicit operator decision. The browser handles hard unloads; the router
  // blocker covers in-app navigation without a history monkey patch.
  const hasPendingAuthorization = sessions.activeProviders.length > 0 || Object.values(siwcBindings.sessions).some(isSIWCPending);
  const routeBlocker = useBlocker(({ currentLocation, nextLocation }) => (
    hasPendingAuthorization && currentLocation.pathname !== nextLocation.pathname
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
    if (!hasPendingAuthorization) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasPendingAuthorization]);

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
    // A sign-in finishing is the outcome of the operator's click in the connect panel, so it is a
    // toast; the one it offers - show me the credential - is carried as its action.
    Object.values(nextResults).forEach((result) => announceCompletionRef.current(result));
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
  /** The credential last picked without Shift, where the next Shift run starts. */
  const selectionAnchor = React.useRef<SelectionAnchor<string> | null>(null);
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

  const selectableFilteredRecords = React.useMemo(
    () => visibleRecords.filter((record) => record.canSelectForFileBatch),
    [visibleRecords],
  );
  const hasUnselectedFilteredRecords = selectableFilteredRecords.some((record) => !selectedKeySet.has(record.key));

  const [selectedIdentity, setSelectedIdentity] = React.useState<SelectedIdentity>();
  const [drawerSection, setDrawerSection] = React.useState<DetailSection>('overview');
  const selectedRecord = selectedIdentity
    ? records.find((record) => record.key === selectedIdentity.key)
    : undefined;
  const siwcRecord = siwcRecordKey ? records.find((record) => record.key === siwcRecordKey) : undefined;
  React.useEffect(() => {
    if (selectedIdentity && !selectedRecord) setSelectedIdentity(undefined);
  }, [selectedIdentity, selectedRecord]);

  const [isWarmupSettingsOpen, setIsWarmupSettingsOpen] = React.useState(false);
 const [isModelRulesOpen, setIsModelRulesOpen] = React.useState(false);
  const [isVertexImportOpen, setIsVertexImportOpen] = React.useState(false);
  const [isUploadOpen, setIsUploadOpen] = React.useState(false);
  const fileNames = React.useMemo(() => new Set(records.map((record) => record.fileName)), [records]);

  const onTargetGone = React.useCallback((recordKey: string) => {
    setSelectedIdentity((current) => (current?.key === recordKey ? undefined : current));

  }, []);
  const actions = useOAuthWorkspaceActions(records, selectedKeys, setSelectedKeys, onTargetGone);

  // The two polled reads are invalidated rather than refetched: a refetch of a polled query is
  // indistinguishable from its poll, so it would not raise the loading bar the reader asked for.
  const reloadWorkspace = React.useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['management-auth-files'], exact: true }),
      queryClient.invalidateQueries({ queryKey: ['management-quota'], exact: true }),
      pluginsQuery.refetch(),
    ]);
  }, [pluginsQuery, queryClient]);

  const fleetCounts = React.useMemo(() => healthCounts(records), [records]);
  const railSummaries = React.useMemo(() => providerSummaries(records, sectionOrder.ordered), [records, sectionOrder.ordered]);
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
    setConnectRecoveryTarget(undefined);
    for (const provider of Object.keys(sessions.states)) { if (!sessions.activeProviders.includes(provider)) sessions.reset(provider); }
    const selectedProvider = queryState.provider !== 'all'
      ? resolveAuthorizationProviderId(queryState.provider, choices)
      : undefined;
    setConnectProviderId(selectedProvider ?? '');
    setIsConnectOpen(true);
  };

  const openCredential = (record: OAuthWorkspaceRecord, section: DetailSection = 'overview') => {
    setDrawerSection(section);
    setSelectedIdentity({ key: record.key, name: record.fileName, authIndex: record.authIndex });
  };

  const openConnectForRecord = (record: OAuthWorkspaceRecord) => {
    const providerId = record.authorizationProviderId;
    if (!providerId || choices.find((choice) => choice.id === providerId)?.pluginPageRoute) {
      toast.warning(t('omc.reauth_unavailable', { provider: record.displayProvider }));
      return;
    }
    if (!record.canEditFile) { toast.warning(t('recovery.target_changed')); return; }
    if (sessions.activeProviders.includes(providerId)) {
      const activeTarget = sessions.states[providerId]?.recoveryTarget;
      if (activeTarget?.name !== record.fileName || activeTarget?.auth_index !== record.authIndex) {
        toast.warning(t('recovery.session_conflict'));
        return;
      }
    } else {
      sessions.reset(providerId);
    }
    setConnectRecoveryTarget({ name: record.fileName, auth_index: record.authIndex });
    setSelectedIdentity(undefined);
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
  };
  const announceCompletion = (result: CompletionResult) => {
    const key = `omc-oauth-complete-${result.providerId}`;
    const title = result.kind === 'new'
      ? t('omc.oauth_success_new_credential')
      : result.kind === 'ambiguous'
        ? t('omc.oauth_success_ambiguous')
        : t('omc.oauth_success_refresh_failed');
    const actions = (
      <Button
        size="small"
        onClick={() => {
          toast.dismiss(key);
          revealCompletedCredential(result.providerId, result);
        }}
      >
        {t('omc.view_credentials')}
      </Button>
    );
    if (result.kind === 'new') toast.success(title, { key, actions });
    else toast.warning(title, { key, actions });
  };
  // The effect that settles a sign-in runs before this render's handlers exist, and the action
  // must reveal against the records on screen when it is clicked, not when the toast opened.
  announceCompletionRef.current = announceCompletion;

  const quotaBodyForRecord = (record: OAuthWorkspaceRecord): React.ReactNode => {
    if (record.quota) {
      const isRefreshing = Boolean(record.authIndex && actions.busyQuotaIndexes.has(record.authIndex));
      return (
        <CredentialQuotaBody
          item={record.quota}
          credentialLabel={maskedCredentialLabel(record)}
          credentialMark={<CredentialMark credential={{ provider: record.displayProvider, hint: record.file.name }} pluginLogos={pluginLogos} size={22} />}
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
      <Notice
        tone={record.quotaMatch === 'missing-quota' ? 'info' : 'warning'}
        title={quotaMessage}
        action={record.canRefreshQuota ? (
          <Button size="small" onClick={() => void actions.refreshQuotaForRecord(record)}>
            {t('quota.btn_refresh_quota')}
          </Button>
        ) : undefined}
      />
    );
  };

  const renameCredential = useCredentialRename();
  const isPending = filesQuery.isPending && !filesQuery.data;
  const groups: CredentialGroup[] = buildCredentialSections(pagedRecords, visibleRecords, sectionOrder.ordered)
    .map((section) => ({ ...section, title: providerDisplayName(section.provider, pluginTitles) }));
  const credentialActions: CredentialActions = {
    isBusy: (record) => actions.isRecordBusy(record),
    isRefreshingQuota: (record) => Boolean(record.authIndex && actions.busyQuotaIndexes.has(record.authIndex)),
    siwcBadge: (record) => siwcBadgeState(record.file, siwcBindings.sessions[siwcTargetKey(record.file)]),
    onSelect: (targets, isSelected) => {
      const keys = targets.map((record) => record.key);
      // Choosing one credential by its menu is a pick like any other: it anchors the next Shift run.
      selectionAnchor.current = targets.length === 1 ? { key: keys[0], isSelected, changed: [] } : null;
      setSelectedKeys((previous) => (isSelected
        ? Array.from(new Set([...previous, ...keys]))
        : previous.filter((key) => !keys.includes(key))));
    },
    onPick: (record, isRange) => {
      // A run follows the order the page draws: its providers in turn, each one's credentials as listed.
      const order = groups.flatMap((group) => group.records).filter((row) => row.canSelectForFileBatch).map((row) => row.key);
      const pick = pickRows(selectedKeySet, order, record.key, selectionAnchor.current, isRange);
      selectionAnchor.current = pick.anchor;
      setSelectedKeys([...pick.selected]);
    },
    onToggle: (record) => void actions.toggleOne(record),
    onDownload: (record) => actions.download(record),
    onDelete: (record) => void actions.deleteOne(record),
    onOpen: openCredential,
    onRename: (record, displayName) => renameCredential(record.file, displayName),
    onRefreshQuota: (record) => void actions.refreshQuotaForRecord(record),
    onClearCooldown: (record) => void actions.clearCooldown(record),
    onRedeemCredit: (record) => void actions.redeemCredit(record),
    onReauthenticate: openConnectForRecord,
    onOpenSIWC: (record) => setSIWCRecordKey(record.key),
  };

  const selectablePage = pagedRecords.filter((record) => record.canSelectForFileBatch);
  const selectedOnPage = selectablePage.filter((record) => selectedKeySet.has(record.key)).length;
  const scopeProvider = queryState.provider;
  const changeScope = (provider: string) => setSearch({ provider: provider === 'all' ? null : provider, page: null });
  const railProps = {
    summaries: railSummaries,
    total: records.length,
    attention: fleetCounts.attention,
    active: scopeProvider,
    onChange: changeScope,
    onConnect: openConnect,
    pluginLogos,
    pluginTitles,
    reorder: sectionOrder.reorder,
  };
  const allRefreshCount = new Set(records.filter((record) => record.canRefreshQuota).map((record) => record.authIndex)).size;
  const viewProps = {
    groups,
    pluginLogos,
    selectedKeys: selectedKeySet,
    nowMS: visibleNow,
    actions: credentialActions,
  };

  return (
    <div className={`terminal-page oauth-management-page ${styles.page} ${selectedKeys.length > 0 ? 'has-fleet-selection' : ''}`}>
      <PageHeader
        title={t('nav.auth_files')}
        actions={(
          <>
            <ToolButton icon={<BranchesOutlined />} label={t('af.rules_open')} disabled={actions.isOperating} onClick={() => setIsModelRulesOpen(true)} data-testid="oauth-model-rules" />
            <ToolButton icon={<TimerResetOutlined />} label={t('warmup.settings')} onClick={() => setIsWarmupSettingsOpen(true)} data-testid="oauth-warmup-settings" />
            {/* Signing in is how a credential usually arrives, so it is the button; a file or a
                Vertex key are the other ways in, under its caret. */}
            <Space.Compact>
              <Button type="primary" icon={<LoginOutlined />} onClick={openConnect}>{t('omc.connect_account')}</Button>
              <Dropdown
                trigger={['click']}
                placement="bottomRight"
                menu={{
                  items: [
                    { key: 'upload', icon: <UploadOutlined />, label: t('af.upload'), disabled: isDemo || actions.isOperating },
                    { key: 'vertex', icon: <CloudUploadOutlined />, label: t('af.vertex_open'), disabled: isDemo || actions.isOperating },
                  ],
                  onClick: ({ key }) => (key === 'upload' ? setIsUploadOpen(true) : setIsVertexImportOpen(true)),
                }}
              >
                <Button type="primary" icon={<DownOutlined />} aria-label={t('omc.fleet_add_other')} data-testid="oauth-add-menu" />
              </Dropdown>
            </Space.Compact>
          </>
        )}
      />

      <OAuthSessionStrip
        sessions={sessions}
        choices={choices}
        onOpen={(providerId, recoveryTarget) => {
          setConnectRecoveryTarget(recoveryTarget);
          setConnectProviderId(providerId);
          setIsConnectOpen(true);
        }}
      />

      {(projection.duplicateAuthIndexes.length > 0
        || projection.duplicateFileNames.length > 0
        || projection.missingAuthIndexCount > 0
        || projection.quotaOnly.length > 0) && (
          <Notice
            className={styles['diagnostic-bar']}
            tone="warning"
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
        <LoadFailure className={styles['diagnostic-bar']} title={t('af.error')} error={filesQuery.error} onRetry={() => void filesQuery.refetch()} />
      )}
      {quotaQuery.isError && (
        <LoadFailure className={styles['diagnostic-bar']} tone="warning" title={t('omc.quota_read_failed')} error={quotaQuery.error} onRetry={() => void quotaQuery.refetch()} />
      )}
      {pluginsQuery.isError && (
        <LoadFailure
          className={styles['diagnostic-bar']}
          tone="warning"
          title={t('omc.plugin_discovery_failed')}
          detail={t('omc.plugin_builtins_retained')}
          onRetry={() => void pluginsQuery.refetch()}
        />
      )}

      <div className={styles.workspace}>
        <ProviderStrip {...railProps} />
        <FleetToolbar
          leading={(
            <Checkbox
              className={styles['select-all']}
              checked={selectablePage.length > 0 && selectedOnPage === selectablePage.length}
              indeterminate={selectedOnPage > 0 && selectedOnPage < selectablePage.length}
              disabled={!isViewLoaded || selectablePage.length === 0}
              onChange={(event) => credentialActions.onSelect(selectablePage, event.target.checked)}
              aria-label={t('omc.fleet_select_page')}
              data-testid="oauth-select-page"
            />
          )}
          search={searchValue}
          onSearch={setSearchValue}
          counts={scopeCounts}
          isPending={isPending}
          lens={queryState.health}
          onLens={(lens) => setSearch({ health: lens === 'all' ? null : lens, page: null })}
          status={queryState.status}
          quota={queryState.quota}
          sort={queryState.sort}
          isViewLoaded={isViewLoaded}
          onFilters={(changes) => setSearch({
            ...('status' in changes ? { status: changes.status === 'all' ? null : changes.status } : {}),
            ...('quota' in changes ? { quota: changes.quota === 'all' ? null : changes.quota } : {}),
            page: null,
          })}
          onSort={(sort) => setSearch({ sort: sort === DEFAULT_OAUTH_SORT ? null : sort, page: null })}
          onReset={() => {
            setResetSearchToken((value) => value + 1);
            setSearch({ q: null, status: null, quota: null, sort: null, health: null, page: null });
          }}
          layout={queryState.layout}
          onLayout={(layout) => setSearch({ layout })}
          refresh={{
            filtered: eligibleFilteredRefreshCount,
            page: pagedRecords.filter((record) => record.canRefreshQuota).length,
            all: allRefreshCount,
            isBusy: actions.busyQuotaIndexes.size > 0,
            isDisabled: visibleRecords.length === 0,
            onRefresh: (scope) => void actions.refreshQuota(scope, visibleRecords, pagedRecords, records),
          }}
        />

          {isPending ? (
            <LoadingRegion>
              <ListPlaceholder rows={6} isFramed />
            </LoadingRegion>
          ) : visibleRecords.length === 0 ? (
            <div className={styles.empty}>
              <EmptyState title={records.length === 0 ? t('af.empty_all') : t('af.empty_filter')} />
            </div>
          ) : (
            <>
              {queryState.layout === 'cards'
                ? <CredentialCards {...viewProps} hasGroupHeads={scopeProvider === 'all'} />
                : <CredentialList {...viewProps} onReorder={credentialOrder.loaded && !quotaDirection ? reorderCredential : undefined} />}
              <div className={styles.pagination}>
                <span>{t('omc.result_count', { n: visibleRecords.length, total: records.length })}</span>
                <Select
                  value={pageSize}
                  disabled={!isViewLoaded}
                  onChange={(size) => setSearch({ page_size: size as 12 | 24 | 48, page: null })}
                  style={{ width: 110 }}
                  options={[12, 24, 48].map((size) => ({ value: size, label: t('af.page_size_n', { n: size }) }))}
                />
                <Pager
                  page={page}
                  pageSize={pageSize}
                  total={visibleRecords.length}
                  hasQuickJumper
                  onChange={(nextPage) => setSearch({ page: nextPage === 1 ? null : nextPage })}
                />
              </div>
            </>
          )}
      </div>

      {/* Batch actions dock at the foot of the view while a selection exists, over whatever is scrolled. */}
      {selectedRecords.length > 0 && (
        <div className={styles.dock}>
          <BatchActionBar
            selectedCount={selectedRecords.length}
            selectablePageCount={selectablePage.length}
            selectableFilteredCount={selectableFilteredRecords.length}
            canSelectFiltered={hasUnselectedFilteredRecords}
            isSelectionReady={isViewLoaded}
            onSelectFiltered={() => {
              const keys = selectableFilteredRecords.map((record) => record.key);
              selectionAnchor.current = null;
              setSelectedKeys((previous) => Array.from(new Set([...previous, ...keys])));
            }}
            hiddenCount={hiddenSelectionCount}
            isMutating={actions.isOperating}
            onSelectPage={() => credentialActions.onSelect(selectablePage, true)}
            onClearSelection={() => {
              selectionAnchor.current = null;
              setSelectedKeys([]);
            }}
            onEnable={() => void actions.batchStatus(false, selectedRecords)}
            onDisable={() => void actions.batchStatus(true, selectedRecords)}
            onRefresh={() => void actions.batchRefresh(selectedRecords)}
            // The demonstration never contacts a provider, so it refuses a refresh.
            canRefresh={!isDemo}
            onDelete={() => void actions.batchDelete(selectedRecords)}
          />
        </div>
      )}

      <DeferredMount isActive={isConnectOpen}>
        <OAuthConnectPanel
          open={isConnectOpen}
          choices={choices}
          selectedProviderId={connectProviderId || undefined}
          recoveryTarget={connectRecoveryTarget}
          isRecoverySupported={isRecoverySupported}
          onSelectProvider={(providerId) => { setConnectRecoveryTarget(undefined); setConnectProviderId(providerId); }}
          onClose={() => setIsConnectOpen(false)}
          onViewCredentials={(providerId) => {
            setSearch({ provider: displayProviderForAuthorization(providerId), page: null });
            setIsConnectOpen(false);
          }}
          sessions={sessionController}
        />
      </DeferredMount>

      <DeferredMount isActive={isUploadOpen}>
        <AuthJsonUploadModal
          open={isUploadOpen}
          existingNames={fileNames}
          onClose={() => setIsUploadOpen(false)}
          onChooseFiles={(files) => {
            setIsUploadOpen(false);
            actions.upload(files);
          }}
          onUploaded={actions.reloadWorkspace}
        />
      </DeferredMount>

      <DeferredMount isActive={isVertexImportOpen}>
        <VertexImportModal open={isVertexImportOpen} onClose={() => setIsVertexImportOpen(false)} onImported={actions.reloadWorkspace} />
      </DeferredMount>

      <DeferredMount isActive={Boolean(selectedRecord)}>
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
          onRecover={selectedRecord ? () => openConnectForRecord(selectedRecord) : undefined}
          initialSection={drawerSection}
          canEdit={Boolean(selectedRecord?.canEditFile)}
          provider={selectedRecord?.displayProvider}
          pluginLogos={pluginLogos}
          quotaContent={selectedRecord ? quotaBodyForRecord(selectedRecord) : undefined}
        />
      </DeferredMount>

      <DeferredMount isActive={Boolean(siwcRecord)}>
        <SIWCDialog file={siwcRecord?.file} canEdit={Boolean(siwcRecord?.canEditFile)} bindings={siwcBindings} onClose={() => setSIWCRecordKey(undefined)} />
      </DeferredMount>
      <DeferredMount isActive={isWarmupSettingsOpen}>
        <WarmupSettingsDrawer open={isWarmupSettingsOpen} onClose={() => setIsWarmupSettingsOpen(false)} />
      </DeferredMount>
      <DeferredMount isActive={isModelRulesOpen}>
        <OAuthModelRulesDrawer
          open={isModelRulesOpen}
          onClose={() => setIsModelRulesOpen(false)}
          onSaved={() => {
            void Promise.all([
              queryClient.invalidateQueries({ queryKey: ['management-oauth-model-aliases'] }),
              queryClient.invalidateQueries({ queryKey: ['management-oauth-excluded-models'] }),
              queryClient.invalidateQueries({ queryKey: ['auth-file-models'] }),
              queryClient.invalidateQueries({ queryKey: ['model-square'] }),
              queryClient.invalidateQueries({ queryKey: ['management-overview'] }),
            ]);
          }}
          providerOptions={providerOptions.filter((provider) => provider !== 'all')}
          pluginLogos={pluginLogos}
          pluginTitles={pluginTitles}
        />
      </DeferredMount>
    </div>
  );
};
