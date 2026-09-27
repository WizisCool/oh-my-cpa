import React from 'react';
import { Alert, Button, Tooltip } from 'antd';
import { XProvider } from '@ant-design/x';
import type { BubbleItemType, BubbleListProps } from '@ant-design/x';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { BrandArtwork } from '../../components/common/BrandArtwork';
import {
  BarChartOutlined, CloudServerOutlined, DashboardOutlined, LayoutOutlined, MessageOutlined, ReloadOutlined, WarningOutlined,
} from '../../components/icons';
import { Composer } from '../../components/workspace/Composer';
import { ReasoningEffortPicker } from '../../components/workspace/ReasoningEffortPicker';
import type { ComposerHandle } from '../../components/workspace/Composer';
import { ConversationList } from '../../components/workspace/ConversationList';
import type { ConversationListHandle } from '../../components/workspace/ConversationList';
import { TargetPicker } from '../../components/workspace/TargetPicker';
import { WorkspaceLayout } from '../../components/workspace/WorkspaceLayout';
import { useXLocale } from '../../components/workspace/useXLocale';
import workspace from '../../components/workspace/Workspace.module.css';
import { NARROW_VIEWPORT_QUERY } from '../../hooks/useIsNarrowViewport';
import { usePreference } from '../../hooks/usePreference';
import { gatewayCallPointOf } from '../../types/gatewayModels';
import { useI18n } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import { failureCode, getCapabilities, getSession, resetSession } from './api';
import { CapabilityDirectory } from './CapabilityDirectory';
import { TurnView } from './AgentTurn';
import type { LiveRun } from './AgentTurn';
import { useAgentRun } from './useAgentRun';
import {
  AGENT_TARGET_PREFERENCE, DEFAULT_AGENT_TARGET, failureKey, isAwaitingApproval, parseAgentTarget, pendingOperationCount,
} from './state';
import type { AgentTarget, Conversation } from './state';
import styles from './AgentPage.module.css';

/**
 * Starting questions, not templates.
 *
 * The composer's placeholder says what to do; an example says what is possible, which is the gap a
 * new operator falls into - the registry is large and its names are machine identifiers. Each is a
 * question this deployment can answer with read capabilities alone, so it teaches the shape of a
 * request and of an answer without asking anyone to approve anything.
 */
const EXAMPLES = [
  { key: 'agent.example.usage', icon: <BarChartOutlined aria-hidden="true" /> },
  { key: 'agent.example.failed', icon: <WarningOutlined aria-hidden="true" /> },
  { key: 'agent.example.quota', icon: <DashboardOutlined aria-hidden="true" /> },
  { key: 'agent.example.providers', icon: <CloudServerOutlined aria-hidden="true" /> },
];

const BUBBLE_ROLES: BubbleListProps['role'] = {
  user: { placement: 'end', variant: 'borderless' },
  ai: { placement: 'start', variant: 'borderless' },
};

export function AgentPage() {
  const { t } = useI18n();
  const xLocale = useXLocale();
  const queryClient = useQueryClient();
  const isDemo = isDemoMode();

  const [isPanelOpen, setIsPanelOpen] = React.useState(() => !window.matchMedia(NARROW_VIEWPORT_QUERY).matches);
  const [fingerprint, setFingerprint] = React.useState('');
  const [model, setModel] = React.useState('');
  const [reasoningEffort, setReasoningEffort] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [localError, setLocalError] = React.useState('');
  const listRef = React.useRef<ConversationListHandle>(null);
  const composerRef = React.useRef<ComposerHandle>(null);
  const targetPref = usePreference<AgentTarget>(AGENT_TARGET_PREFERENCE, DEFAULT_AGENT_TARGET, parseAgentTarget);

  const session = useQuery({ queryKey: ['agent-session'], queryFn: ({ signal }) => getSession(signal) });
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: ({ signal }) => getCapabilities(signal) });
  // The console's own key list entry, so creating a key on the key page refreshes this selector.
  const keys = useQuery({ queryKey: ['management-client-keys'], queryFn: () => api.getClientAPIKeys() });
  const directory = useQuery({
    queryKey: ['playground-models', fingerprint],
    queryFn: ({ signal }) => api.getGatewayModels(fingerprint, signal),
    enabled: !!fingerprint,
  });

  const acceptConversation = React.useCallback((conversation: Conversation) => {
    queryClient.setQueryData(['agent-session'], conversation);
  }, [queryClient]);

  // Restored only into an empty composer: if the operator has started the next message, it wins.
  const onRejected = React.useCallback((rejected: string) => setMessage(current => current || rejected), []);
  const agent = useAgentRun({ conversation: session.data, model, fingerprint, reasoningEffort, onConversation: acceptConversation, onRejected });
  const { isRunning, pendingMessage, isResuming, parts, traces, errorCode, startedAtMS, run, stop, clearError } = agent;

  // ── the selector ───────────────────────────────────────────────────────────
  //
  // Restored once, from the operator's own last choice, or from what the stored conversation ran
  // with when there is no choice yet. A conversation waiting on an approval is the exception: it
  // can only be resumed with the key and model it started with, so those win. After this the
  // selector belongs to the operator - a session refetch after a tool result never moves it.
  const isTargetRestored = React.useRef(false);
  React.useEffect(() => {
    if (isTargetRestored.current || !session.data || !targetPref.ready) return;
    isTargetRestored.current = true;
    const stored = targetPref.value;
    const source: AgentTarget = isAwaitingApproval(session.data) || !stored.client_key_fingerprint
      ? { client_key_fingerprint: session.data.client_key_fingerprint, model: session.data.model, reasoning_effort: session.data.reasoning_effort }
      : stored;
    setFingerprint(source.client_key_fingerprint ?? '');
    setModel(source.model ?? '');
    setReasoningEffort(source.reasoning_effort ?? '');
  }, [session.data, targetPref.ready, targetPref.value]);

  // A remembered key or model that no longer exists is dropped rather than sent to.
  React.useEffect(() => {
    if (!keys.isSuccess || !fingerprint || keys.data.keys.some(key => key.usage_fingerprint === fingerprint)) return;
    setFingerprint('');
    setModel('');
  }, [keys.isSuccess, keys.data, fingerprint]);
  const models = directory.data?.models;
  React.useEffect(() => {
    if (!models || directory.isFetching) return;
    if (model && !models.some(item => gatewayCallPointOf(item) === model)) setModel('');
    // A key that serves exactly one model has nothing to choose between.
    if (!model && models.length === 1) setModel(gatewayCallPointOf(models[0]));
  }, [models, directory.isFetching, model]);

  const { set: persistTarget } = targetPref;
  const chooseTarget = (next: { fingerprint: string; model: string; reasoningEffort: string }) => {
    setFingerprint(next.fingerprint);
    setModel(next.model);
    setReasoningEffort(next.reasoningEffort);
    if (isDemo) return;
    void persistTarget({
      ...(next.fingerprint ? { client_key_fingerprint: next.fingerprint } : {}),
      ...(next.model ? { model: next.model } : {}),
      ...(next.reasoningEffort ? { reasoning_effort: next.reasoningEffort } : {}),
    });
  };

  const turns = session.data?.turns ?? [];
  const isAwaiting = isAwaitingApproval(session.data);
  const isFullyConfigured = !!fingerprint && !!model;
  const canRun = !isRunning && !isDemo && isFullyConfigured && !!session.data;
  const canSubmit = isAwaiting ? canRun : canRun && !!message.trim();

  const submit = (text: string) => {
    if (!canSubmit) return;
    listRef.current?.followLatest();
    // Resumption is the same request with an empty message: the server continues the stored turn.
    run(isAwaiting ? '' : text);
    if (!isAwaiting) setMessage('');
  };

  const reset = async () => {
    if (!session.data || isRunning) return;
    try {
      acceptConversation(await resetSession(session.data.revision));
      setMessage('');
      setLocalError('');
      clearError();
    } catch (cause) {
      setLocalError(failureCode(cause));
    }
  };

  // Stable for the life of the page: an inline arrow would be a new prop on every publish tick,
  // which re-renders every stored turn - and re-parses every stored answer - 25 times a second.
  const refetchSession = session.refetch;
  const refreshSession = React.useCallback(() => void refetchSession(), [refetchSession]);

  // Built in two halves. Stored turns depend only on the stored conversation, so a streaming
  // answer changes the tail item and every earlier element keeps its identity.
  const historyItems = React.useMemo<BubbleItemType[]>(() => turns.flatMap(turn => [
    { key: `${turn.id}-user`, role: 'user', content: <div className={workspace['user-text']}>{turn.user}</div> },
    { key: `${turn.id}-ai`, role: 'ai', content: <TurnView turn={turn} onSettled={refreshSession} /> },
  ]), [turns, refreshSession]);

  const isLive = isRunning || traces.length > 0 || parts.length > 0;
  const live = React.useMemo<LiveRun | undefined>(
    () => (isLive ? { parts, traces, startedAtMS, isAwaitingApproval: isAwaiting } : undefined),
    [isLive, parts, traces, startedAtMS, isAwaiting],
  );
  const items = React.useMemo<BubbleItemType[]>(() => {
    if (!live) return historyItems;
    const lastTurn = turns.at(-1);
    // A resumption continues the stored turn that stopped for a decision, so its live output is
    // drawn inside that turn rather than as a second answer beneath it.
    if (isResuming && lastTurn) {
      return [
        ...historyItems.slice(0, -1),
        { key: `${lastTurn.id}-ai`, role: 'ai', content: <TurnView turn={lastTurn} live={live} onSettled={refreshSession} /> },
      ];
    }
    return [
      ...historyItems,
      // The operator's message is shown as sent at once; the stored turn replaces it when the run
      // reports the conversation it saved.
      ...(pendingMessage ? [{ key: 'agent-running-user', role: 'user', content: <div className={workspace['user-text']}>{pendingMessage}</div> }] : []),
      { key: 'agent-running', role: 'ai', content: <TurnView live={live} onSettled={refreshSession} /> },
    ];
  }, [historyItems, live, turns, isResuming, pendingMessage, refreshSession]);

  const runError = localError || errorCode;
  const notices = (
    <>
      {isDemo && <Alert type="info" title={t('agent.demo')} />}
      {session.isError && (
        <Alert
          type="error"
          title={t('agent.session.failed')}
          action={<Button size="small" onClick={refreshSession}>{t('common.retry')}</Button>}
        />
      )}
      {!isDemo && keys.isSuccess && keys.data.keys.length === 0 && (
        <Alert type="info" title={t('pg.no_keys')} action={<Link to="/api-keys">{t('pg.manage_keys')}</Link>} />
      )}
      {!isDemo && !!fingerprint && directory.isSuccess && directory.data.models.length === 0 && (
        <Alert type="info" title={t('pg.no_models')} action={<Link to="/ai-providers">{t('pg.manage_models')}</Link>} />
      )}
      {!!session.data?.omitted && <Alert type="info" title={t('agent.omitted')} />}
      {runError && (
        <Alert
          type="error"
          closable={{ onClose: () => { setLocalError(''); clearError(); } }}
          title={t(failureKey(runError))}
          description={<code>{runError}</code>}
        />
      )}
    </>
  );

  const actions = (
    <>
      <Tooltip title={t('common.refresh')}>
        <Button
          aria-label={t('common.refresh')}
          icon={<ReloadOutlined />}
          disabled={isRunning}
          onClick={() => {
            void keys.refetch();
            void capabilities.refetch();
            if (fingerprint) void directory.refetch();
          }}
        />
      </Tooltip>
      <Button aria-label={t('agent.new')} icon={<MessageOutlined />} disabled={isRunning || isDemo || turns.length === 0} onClick={() => void reset()}>
        <span className={styles['action-label']}>{t('agent.new')}</span>
      </Button>
      <Tooltip title={t('agent.directory')}>
        <Button
          aria-label={t('agent.directory')}
          aria-pressed={isPanelOpen}
          type={isPanelOpen ? 'default' : 'text'}
          icon={<LayoutOutlined />}
          onClick={() => setIsPanelOpen(value => !value)}
        />
      </Tooltip>
    </>
  );

  // Sending is the act this line describes: the message, and whatever the agent reads to answer
  // it, goes to the selected model and on to its upstream provider (ADR 0027).
  const note = isAwaiting
    ? t('agent.resume.hint', { count: String(pendingOperationCount(turns)) })
    : t('agent.data_notice');

  return (
    <XProvider locale={xLocale}>
      <WorkspaceLayout
        testId="agent-page"
        title={t('nav.agent')}
        target={(
          <TargetPicker
            keys={keys.data?.keys ?? []}
            models={directory.data?.models ?? []}
            fingerprint={fingerprint}
            model={model}
            isKeysLoading={keys.isFetching}
            isModelsLoading={directory.isFetching}
            isDisabled={isRunning || isAwaiting}
            onFingerprintChange={value => chooseTarget({ fingerprint: value, model: '', reasoningEffort })}
            onModelChange={value => chooseTarget({ fingerprint, model: value, reasoningEffort })}
          />
        )}
        actions={actions}
        notices={notices}
        aside={{
          title: t('agent.directory'),
          content: <CapabilityDirectory capabilities={capabilities.data ?? []} isPending={capabilities.isPending} isError={capabilities.isError} />,
          isOpen: isPanelOpen,
          onOpenChange: setIsPanelOpen,
          resizeLabel: t('agent.directory.resize'),
          defaultWidth: 340,
          minWidth: 280,
          maxWidth: 560,
        }}
      >
        {session.isPending ? (
          <div className={workspace['empty']} data-testid="agent-loading" aria-busy="true" />
        ) : turns.length === 0 && !isLive ? (
          <div className={workspace['empty']} data-testid="agent-empty">
            <BrandArtwork shape="wordmark" height={28} className={workspace['empty-mark']} label="Oh My CPA" />
            <p className={workspace['empty-text']}>{t('agent.empty.description')}</p>
            <div className={styles['examples']}>
              <span className={styles['examples-label']}>{t('agent.examples')}</span>
              <div className={workspace['suggestions']}>
                {EXAMPLES.map(example => (
                  <button
                    key={example.key}
                    type="button"
                    className={workspace['suggestion']}
                    onClick={() => {
                      setMessage(t(example.key));
                      composerRef.current?.focus();
                    }}
                  >
                    {example.icon}
                    <span>{t(example.key)}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <ConversationList ref={listRef} items={items} roles={BUBBLE_ROLES} latestLabel={t('pg.latest')} />
        )}
        <Composer
          ref={composerRef}
          value={message}
          onChange={setMessage}
          onSubmit={submit}
          onStop={stop}
          placeholder={t('agent.message')}
          inputLabel={t('agent.message')}
          sendLabel={t(isAwaiting ? 'agent.resume' : 'agent.send')}
          isSendLabelled={isAwaiting}
          stopLabel={t('agent.stop')}
          isRunning={isRunning}
          canSend={canSubmit}
          isDisabled={isDemo || !session.data || !isFullyConfigured || isAwaiting}
          footerStart={(
            <ReasoningEffortPicker
              value={reasoningEffort}
              isDisabled={isRunning || isAwaiting}
              onChange={value => chooseTarget({ fingerprint, model, reasoningEffort: value })}
            />
          )}
          note={note}
        />
      </WorkspaceLayout>
    </XProvider>
  );
}
