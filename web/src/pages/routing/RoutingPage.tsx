import React from 'react';
import { App as AntdApp, Button, Popover } from 'antd';
import { useBlocker } from 'react-router-dom';
import clsx from 'clsx';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useT } from '../../i18n';
import type { MessageKey, TFunc } from '../../i18n/catalog';
import { PageHeader } from '../../components/common/PageHeader';
import { PanelsPlaceholder } from '../../components/common/PageLoading';
import { RefreshButton } from '../../components/common/RefreshButton';
import { SearchSelect } from '../../components/common/SearchSelect';
import { EmptyState } from '../../components/common/EmptyState';
import { ConfigDirtyBar } from '../../components/config/ConfigDirtyBar';
import { ModelMark } from '../../components/ModelMark';
import { renderFacetOption } from '../../components/usage/RequestFacetMark';
import { LoadFailure, Notice, useToast } from '../../components/feedback';
import { useProviderBranding } from '../../hooks/useProviderBranding';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { isDemoMode } from '../../types/demoMode';
import type { RoutingBoard, RoutingMember, RoutingOutcome, RoutingPlanRequest, RoutingSettingKey } from '../../types/routing';
import {
  diffPlan,
  draftFromBoard,
  moveMember,
  resolveRoute,
  splitMember,
  stepMember,
  tierIndexOf,
  type RoutingChange,
  type RoutingDraft,
  type RoutingDropTarget,
  type RoutingTier,
} from '../../types/routingPlan';
import { PolicyStrip } from './PolicyStrip';
import { TierLadder } from './TierLadder';
import styles from './RoutingPage.module.css';

const renderModelMark = (_key: string, model: string) => <ModelMark model={model} size={16} />;

export const ROUTING_QUERY_KEY = ['management-routing'] as const;
const ROUTING_MODELS_QUERY_KEY = ['management-routing-models'] as const;

const SETTING_LABELS: Record<RoutingSettingKey, MessageKey> = {
  strategy: 'orch.strategy',
  session_affinity: 'cfg.f_affinity',
  session_affinity_ttl: 'cfg.f_affinity_ttl',
  request_retry: 'cfg.request_retry',
  max_retry_credentials: 'cfg.max_retry_credentials',
  max_retry_interval: 'cfg.max_retry_interval',
  disable_cooling: 'cfg.f_disable_cooling',
  transient_error_cooldown_seconds: 'cfg.f_transient_cooldown',
};

const RESULT_GROUPS: Record<string, MessageKey> = {
  failed: 'orch.result_failed',
  uncertain: 'orch.result_uncertain',
  not_attempted: 'orch.result_not_attempted',
};

function describeValue(t: TFunc, value: unknown): string {
  if (value === null || value === undefined || value === '') return t('orch.value_default');
  if (typeof value === 'boolean') return t(value ? 'orch.value_on' : 'orch.value_off');
  return String(value);
}

function describeChange(t: TFunc, change: RoutingChange, members: ReadonlyMap<string, RoutingMember>): string {
  const from = describeValue(t, change.from);
  const to = describeValue(t, change.to);
  if (change.kind === 'setting') {
    return t('orch.change_setting', { name: t(SETTING_LABELS[change.field as RoutingSettingKey]), from, to });
  }
  const name = members.get(change.key)?.name ?? change.key;
  return t(change.kind === 'priority' ? 'orch.change_priority' : 'orch.change_weight', { name, from, to });
}

/**
 * CPA's priority tiers as one arrangement.
 *
 * Every move, weight and setting is a local draft until it is applied as one plan against the
 * revision it was arranged on. A background read that finds the board changed underneath a draft
 * keeps the draft and says so; applying it then is refused rather than written over the other
 * change.
 */
export function RoutingPage() {
  const branding = useProviderBranding();
  const t = useT();
  const toast = useToast();
  const { modal } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const isPhone = useIsPhoneViewport();
  const isDemo = isDemoMode();

  const boardQuery = useQuery({ queryKey: ROUTING_QUERY_KEY, queryFn: () => api.getRouting(), staleTime: 0, refetchOnMount: 'always' });
  const [baseline, setBaseline] = React.useState<RoutingBoard | null>(null);
  const [draft, setDraft] = React.useState<RoutingDraft | null>(null);
  const [landedKey, setLandedKey] = React.useState<string | null>(null);
  const [announcement, setAnnouncement] = React.useState('');
  const [lensModel, setLensModel] = React.useState<string | undefined>(undefined);
  const [isAwaitingReadback, setIsAwaitingReadback] = React.useState(false);
  const pageRef = React.useRef<HTMLDivElement>(null);
  const updateDirtyHeight = React.useCallback((height: number) => {
    pageRef.current?.style.setProperty('--routing-dirty-height', `${height}px`);
  }, []);

  const diff = React.useMemo(() => (baseline && draft ? diffPlan(baseline, draft) : null), [baseline, draft]);
  const isDirty = Boolean(diff && diff.changes.length > 0);
  const latest = boardQuery.data;
  const hasRemoteChange = Boolean(latest && baseline && latest.revision !== baseline.revision);

  // A fresh read replaces the arrangement only while nothing is drafted on top of it. Whether a
  // draft exists is read at the moment the read arrives, not followed: discarding a draft must not
  // by itself re-adopt an older read.
  const isDirtyRef = React.useRef(isDirty);
  isDirtyRef.current = isDirty;
  const isAwaitingReadbackRef = React.useRef(isAwaitingReadback);
  isAwaitingReadbackRef.current = isAwaitingReadback;
  React.useEffect(() => {
    if (latest && !isDirtyRef.current && !isAwaitingReadbackRef.current) {
      setBaseline(latest);
      setDraft(draftFromBoard(latest));
      setIsAwaitingReadback(false);
    }
  }, [latest]);

  const modelsQuery = useQuery({
    queryKey: ROUTING_MODELS_QUERY_KEY,
    queryFn: () => api.getRoutingModels(),
    staleTime: 30_000,
  });
  const modelOptions = React.useMemo(() => {
    const names = new Set<string>();
    for (const models of Object.values(modelsQuery.data?.models ?? {})) {
      for (const model of models) names.add(model);
    }
    // Each model leads with its maker's mark, drawn as the request filters and the dashboard draw it;
    // the search still reads the plain name in `title`.
    return [...names].sort().map((name) => ({
      value: name,
      title: name,
      label: renderFacetOption(renderModelMark, 'model', { value: name, label: name }),
    }));
  }, [modelsQuery.data]);

  const members = React.useMemo(() => new Map((baseline?.members ?? []).map((member) => [member.key, member])), [baseline]);
  // The route is always drawn; a chosen model narrows it once the members' models are read.
  const lens = React.useMemo(
    () => (lensModel && modelsQuery.data ? { model: lensModel, models: modelsQuery.data } : null),
    [lensModel, modelsQuery.data],
  );
  const preview = React.useMemo(() => (baseline && draft ? resolveRoute(baseline, draft, lens) : null), [baseline, draft, lens]);

  const adopt = React.useCallback((board: RoutingBoard) => {
    setBaseline(board);
    setDraft(draftFromBoard(board));
    setIsAwaitingReadback(false);
    queryClient.setQueryData(ROUTING_QUERY_KEY, board);
  }, [queryClient]);

  const rearrange = (key: string, next: (tiers: RoutingTier[]) => RoutingTier[]) => {
    if (!draft || !baseline || applyMutation.isPending || isAwaitingReadback) return;
    const tiers = next(draft.tiers);
    if (tiers.map((tier) => tier.memberKeys.join()).join('|') === draft.tiers.map((tier) => tier.memberKeys.join()).join('|')) return;
    const arrangement = { ...draft, tiers };
    if (!diffPlan(baseline, arrangement)) {
      toast.warning(t('orch.priority_conflict'));
      return;
    }
    setDraft(arrangement);
    setLandedKey(key);
    setAnnouncement(t('orch.moved', { name: members.get(key)?.name ?? key, n: tierIndexOf(tiers, key) + 1 }));
  };

  const applyMutation = useMutation({
    mutationFn: (plan: RoutingPlanRequest) => api.patchRouting(plan),
    onMutate: () => queryClient.cancelQueries({ queryKey: ROUTING_QUERY_KEY }),
    onSuccess: async (outcome: RoutingOutcome) => {
      void queryClient.invalidateQueries({ queryKey: ['management-providers'] });
      void queryClient.invalidateQueries({ queryKey: ['management-auth-files'] });
      if (outcome.board) {
        await queryClient.cancelQueries({ queryKey: ROUTING_QUERY_KEY });
        adopt(outcome.board);
      } else {
        // A submitted plan is no longer a safe baseline. Keep editing and another apply blocked
        // until a successful read confirms what landed, even when that read initially fails.
        setIsAwaitingReadback(true);
        const readback = await boardQuery.refetch();
        if (readback.isSuccess && readback.data) adopt(readback.data);
      }
      if (outcome.is_complete) {
        toast.success(t('orch.applied'));
        return;
      }
      toast.warning(t('orch.partial'), {
        items: outcome.results
          .filter((result) => result.status !== 'applied')
          .map((result) => ({
            name: result.key === 'settings' ? t('orch.settings_target') : members.get(result.key)?.name ?? result.key,
            group: t(RESULT_GROUPS[result.status] ?? 'orch.result_failed'),
          })),
      });
    },
    onError: (error) => {
      const code = error instanceof ApiError ? (error.data as { code?: string } | undefined)?.code : undefined;
      if (code === 'routing_conflict') {
        toast.error(t('orch.conflict'), {
          key: 'routing-conflict',
          actions: <Button size="small" onClick={() => { toast.dismiss('routing-conflict'); void reload(); }}>{t('orch.reload')}</Button>,
        });
        return;
      }
      toast.error(t('orch.apply_failed'), { error });
    },
  });

  const reload = async () => {
    const result = await boardQuery.refetch();
    if (result.isSuccess && result.data) adopt(result.data);
  };

  const isEditingDisabled = applyMutation.isPending || isAwaitingReadback;
  const shouldProtectDraft = isDirty || isEditingDisabled;
  const routeBlocker = useBlocker(({ currentLocation, nextLocation }) => (
    shouldProtectDraft && currentLocation.pathname !== nextLocation.pathname
  ));
  React.useEffect(() => {
    if (routeBlocker.state !== 'blocked') return;
    const confirmation = modal.confirm({
      title: t('orch.leave_title'),
      content: t('orch.leave_desc'),
      okText: t('orch.leave_confirm'),
      cancelText: t('common.cancel'),
      onOk: () => routeBlocker.proceed(),
      onCancel: () => routeBlocker.reset(),
    });
    return () => confirmation.destroy();
  }, [modal, routeBlocker, t]);
  React.useEffect(() => {
    if (!shouldProtectDraft) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [shouldProtectDraft]);

  // Until the board is read and its draft seeded, the real head and the board's panels.
  const loadingFrame = (
    <div className="terminal-page terminal-page-stack" data-testid="routing-page">
      <PageHeader title={t('orch.title')} actions={<RefreshButton isRefreshing onRefresh={() => void boardQuery.refetch()} />} />
      <PanelsPlaceholder />
    </div>
  );
  if (boardQuery.isPending && !baseline) return loadingFrame;
  if (boardQuery.isError && !baseline) {
    return (
      <div className="terminal-page terminal-page-stack" data-testid="routing-page">
        <PageHeader title={t('orch.title')} />
        <LoadFailure title={t('orch.load_failed')} error={boardQuery.error} onRetry={() => void boardQuery.refetch()} />
      </div>
    );
  }
  if (!baseline || !draft || !preview) return loadingFrame;
  if (!diff) {
    return <Notice tone="warning" title={t('orch.priority_conflict')} />;
  }

  const review = (
    <Popover
      trigger="click"
      placement="topLeft"
      content={(
        <ul className={styles['review']}>
          {diff.changes.map((change, index) => <li key={index}>{describeChange(t, change, members)}</li>)}
        </ul>
      )}
    >
      <Button size="small" type="link">{t('orch.review')}</Button>
    </Popover>
  );

  return (
    <div ref={pageRef} className={clsx('terminal-page terminal-page-stack', isDirty && styles['has-dirty-bar'])} data-testid="routing-page">
      <PageHeader
        title={t('orch.title')}
        actions={<RefreshButton disabled={applyMutation.isPending} onRefresh={() => void (isDirty && !isAwaitingReadback ? boardQuery.refetch() : reload())} isRefreshing={boardQuery.isFetching} />}
      />
      {isAwaitingReadback && !boardQuery.isFetching && (
        <LoadFailure tone="warning" title={t('orch.readback_pending')} error={boardQuery.error} onRetry={() => void reload()} />
      )}
      {hasRemoteChange && isDirty && !isAwaitingReadback && (
        <Notice tone="warning" title={t('orch.remote_change')} action={<Button size="small" onClick={() => void reload()}>{t('orch.reload')}</Button>} />
      )}
      {baseline.partial.length > 0 && (
        <Notice tone="warning" title={t('orch.partial_board', { sources: baseline.partial.join(', ') })} />
      )}
      <div className={styles['workspace']}>
        {baseline.members.length === 0 ? (
          <EmptyState title={t('orch.empty')} description={t('orch.empty_desc')} />
        ) : (
          <section className={styles['board']} aria-label={t('orch.board')}>
            <TierLadder branding={branding}
              tiers={draft.tiers}
              members={members}
              tierPriorities={diff.tierPriorities}
              strategy={draft.settings.strategy}
              weights={draft.weights}
              preview={preview}
              isLens={lens !== null}
              canDrag={!isPhone && !isEditingDisabled}
              disabled={isEditingDisabled}
              landedKey={landedKey}
              entry={(
                <SearchSelect
                  label={t('orch.lens')}
                  className={styles['lens']}
                  value={lensModel}
                  placeholder={t('orch.lens_placeholder')}
                  showSearch={{ optionFilterProp: 'title' }}
                  allowClear
                  loading={modelsQuery.isFetching}
                  options={modelOptions}
                  onChange={(value) => setLensModel((value as string | undefined) || undefined)}
                />
              )}
              exit={draft.settings.request_retry > 0 ? t('orch.exit_retry', { rounds: draft.settings.request_retry }) : t('orch.exit_now')}
              onMove={(key, target: RoutingDropTarget) => rearrange(key, (tiers) => moveMember(tiers, key, target))}
              onStep={(key, direction) => rearrange(key, (tiers) => stepMember(tiers, key, direction))}
              onSplit={(key, side) => rearrange(key, (tiers) => splitMember(tiers, key, side))}
              onWeights={(key, weights) => setDraft({ ...draft, weights: { ...draft.weights, [key]: weights } })}
            />
            {modelsQuery.isError && (
              <LoadFailure tone="warning" title={t('orch.lens_failed')} error={modelsQuery.error} onRetry={() => void modelsQuery.refetch()} />
            )}
            {lens && preview.steps.length === 0 && (
              <p className={styles['lens-note']}>{t('orch.lens_none')}</p>
            )}
            <div className="sr-only" aria-live="polite">{announcement}</div>
          </section>
        )}
        <aside className={styles['aside']}>
          <PolicyStrip settings={draft.settings} disabled={isEditingDisabled} onChange={(settings) => setDraft({ ...draft, settings })} />
        </aside>
      </div>
      <ConfigDirtyBar
        isDirty={isDirty}
        isSaving={applyMutation.isPending}
        disabled={isDemo || isAwaitingReadback}
        disabledReason={isAwaitingReadback ? t('orch.readback_pending') : undefined}
        isDiscardDisabled={isAwaitingReadback}
        onHeightChange={updateDirtyHeight}
        label={t('orch.changes', { n: diff.changes.length })}
        extra={review}
        confirmTitle={t('orch.confirm_title')}
        confirmDescription={t('orch.confirm_desc')}
        onSave={() => applyMutation.mutate({ revision: baseline.revision, ...diff.request })}
        onDiscard={() => latest && adopt(latest)}
      />
    </div>
  );
}

export default RoutingPage;
