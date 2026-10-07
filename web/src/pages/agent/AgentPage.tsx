import React from 'react';
import { Button, Dropdown, Tooltip } from 'antd';
import { AssistantRuntimeProvider, ComposerPrimitive, SelectionToolbarPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { BrandArtwork } from '../../components/common/BrandArtwork';
import {
  BarChartOutlined, CloseOutlined, DashboardOutlined, DatabaseOutlined, DownloadOutlined, LayoutOutlined, MessageOutlined, QuoteOutlined, ReloadOutlined, WarningOutlined,
} from '../../components/icons';
import { AssistantComposer } from '../../components/workspace/AssistantComposer';
import { AssistantThread } from '../../components/workspace/AssistantThread';
import { ReasoningEffortPicker } from '../../components/workspace/ReasoningEffortPicker';
import { TargetPicker } from '../../components/workspace/TargetPicker';
import { WorkspaceLayout } from '../../components/workspace/WorkspaceLayout';
import workspace from '../../components/workspace/Workspace.module.css';
import { conversationMarkdown, exportFileName } from '../../agent/export';
import type { Trace } from '../../agent/types';
import { NARROW_VIEWPORT_QUERY } from '../../hooks/useIsNarrowViewport';
import { usePreference } from '../../hooks/usePreference';
import { gatewayCallPointOf } from '../../types/gatewayModels';
import { useI18n } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import { saveBlob } from '../../utils/download';
import { AgentMessage } from './AgentMessage';
import { failureCode, getCapabilities, getOperation, getSession, resetSession } from './api';
import { CallDetails } from './CallDetails';
import { CapabilityDirectory } from './CapabilityDirectory';
import { ExternalAgentGuide } from './ExternalAgentGuide';
import { linkedOperationID } from './connect';
import { useExportLabels } from './exportLabels';
import { QuestionPanel } from './interrupts/QuestionPanel';
import { useAgentThreadRuntime } from './runtime';
import {
  AGENT_TARGET_PREFERENCE, DEFAULT_AGENT_TARGET, failureKey, isAwaitingApproval, parseAgentTarget, pendingOperationID,
} from './state';
import type { AgentTarget, Conversation, Operation } from './state';
import { mergeLiveTurn } from './thread';
import { AgentViewContext } from './tools/AgentViewContext';
import type { AgentViewState } from './tools/AgentViewContext';
import { AgentToolUIs } from './tools/registry';
import { RunRejectedError, useAgentRun } from './useAgentRun';
import styles from './AgentPage.module.css';
import { LoadFailure, Notice } from '../../components/feedback';

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
  { key: 'agent.example.daily', icon: <DatabaseOutlined aria-hidden="true" /> },
];

type PanelTab = 'directory' | 'details' | 'connect';

export function AgentPage() {
  const { t, lang } = useI18n();
  const queryClient = useQueryClient();
  const isDemo = isDemoMode();
  const pageRef = React.useRef<HTMLDivElement>(null);

  // An approval link from an external agent names the operation to decide. It opens on the tab
  // that draws it even on a narrow viewport, where the panel otherwise starts closed: the link was
  // followed for exactly this.
  const [linkedOperation] = React.useState(() => linkedOperationID(window.location.search));
  const [isPanelOpen, setIsPanelOpen] = React.useState(() => !!linkedOperation || !window.matchMedia(NARROW_VIEWPORT_QUERY).matches);
  const [panelTab, setPanelTab] = React.useState<PanelTab>(linkedOperation ? 'connect' : 'directory');
  const [selectedCallID, setSelectedCallID] = React.useState('');
  const [fingerprint, setFingerprint] = React.useState('');
  const [model, setModel] = React.useState('');
  const [reasoningEffort, setReasoningEffort] = React.useState('');
  const [localError, setLocalError] = React.useState('');
  const [rejection, setRejection] = React.useState<{ code: string; text: string }>();
  const targetPref = usePreference<AgentTarget>(AGENT_TARGET_PREFERENCE, DEFAULT_AGENT_TARGET, parseAgentTarget);
  const exportLabels = useExportLabels();

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

  const run = useAgentRun({ conversation: session.data, model, fingerprint, reasoningEffort, language: lang, onConversation: acceptConversation });
  const { isRunning, frame, errorCode, startedAtMS, clearError } = run;

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

  // ── the operator's decision ────────────────────────────────────────────────
  //
  // A run that stops for the operator stops on one prepared operation: an approval, decided on the
  // card under the call that raised it, or a question, which takes the composer's place. Deciding
  // it continues the run straight away, so the operator's one click is the whole interaction. The
  // operation is polled while open in case another tab decides it first; that decision continues
  // the run here too.
  const pendingID = isAwaiting ? pendingOperationID(session.data) : '';
  const pending = useQuery({
    queryKey: ['agent-operation', pendingID],
    queryFn: ({ signal }) => getOperation(pendingID, signal),
    enabled: !!pendingID,
    refetchInterval: query => (query.state.data?.status === 'pending' ? 5000 : false),
  });
  const openOperation = pending.data?.status === 'pending' ? pending.data : undefined;
  const isQuestion = openOperation?.human_input === 'answer';

  const focusComposer = React.useCallback(() => {
    requestAnimationFrame(() => pageRef.current?.querySelector<HTMLTextAreaElement>('textarea[name="input"]')?.focus({ preventScroll: true }));
  }, []);

  const resumedRef = React.useRef(new Set<string>());
  const { resume } = run;
  const continueAfter = React.useCallback((operation: Operation) => {
    queryClient.setQueryData(['agent-operation', operation.id], operation);
    for (const key of operation.result.invalidates ?? []) void queryClient.invalidateQueries({ queryKey: [key] });
    if (operation.status === 'pending' || resumedRef.current.has(operation.id)) return;
    resumedRef.current.add(operation.id);
    focusComposer();
    resume([operation.id]).catch((cause: unknown) => {
      resumedRef.current.delete(operation.id);
      setLocalError(cause instanceof RunRejectedError ? cause.code : failureCode(cause));
    });
  }, [queryClient, resume, focusComposer]);

  const decidedElsewhere = pending.data && pending.data.status !== 'pending' ? pending.data : undefined;
  React.useEffect(() => {
    if (decidedElsewhere && !isRunning && isAwaiting) continueAfter(decidedElsewhere);
  }, [decidedElsewhere, isRunning, isAwaiting, continueAfter]);

  const runtime = useAgentThreadRuntime({
    conversation: session.data,
    run,
    isDisabled: isDemo || !session.data,
    isSendDisabled: isDemo || !isFullyConfigured || isAwaiting,
    onRejected: React.useCallback((text: string, code: string) => {
      setRejection({ code, text });
    }, []),
    onDecided: continueAfter,
  });

  // A message the server refused before accepting goes back into an empty composer: if the operator
  // has started the next one, it wins.
  React.useEffect(() => {
    if (!rejection) return;
    const composer = runtime.thread.composer;
    if (!composer.getState().text) composer.setText(rejection.text);
  }, [rejection, runtime]);

  const reset = async () => {
    if (!session.data || isRunning) return;
    try {
      acceptConversation(await resetSession(session.data.revision));
      runtime.thread.composer.setText('');
      setLocalError('');
      setRejection(undefined);
      setSelectedCallID('');
      clearError();
    } catch (cause) {
      setLocalError(failureCode(cause));
    }
  };

  const answerQuestion = (operation: Operation) => {
    const lastTurn = turns.at(-1);
    const trace = lastTurn?.traces.find(item => item.result.operation_id === operation.id);
    // The answer goes through the framework's own human-input channel, which lands in the same
    // continuation an approval does.
    try {
      if (!lastTurn || !trace) throw new Error('missing');
      runtime.thread.getMessageById(`${lastTurn.id}:assistant`).getMessagePartByToolCallId(trace.id).resumeToolCall({ operation });
    } catch {
      continueAfter(operation);
    }
  };

  // ── the view context ───────────────────────────────────────────────────────

  const lastTurn = turns.at(-1);
  const traces = React.useMemo(() => {
    const byID = new Map<string, Trace>();
    for (const turn of turns) for (const trace of turn.traces) byID.set(trace.id, trace);
    if (isRunning) for (const trace of mergeLiveTurn(run.isResuming ? lastTurn : undefined, frame).traces) byID.set(trace.id, trace);
    return byID;
  }, [turns, isRunning, run.isResuming, lastTurn, frame]);

  const selectCall = React.useCallback((id: string) => {
    setSelectedCallID(id);
    setPanelTab('details');
    setIsPanelOpen(true);
  }, []);

  const runningCall = isRunning ? frame.traces.find(trace => trace.result.status === 'running')?.name : undefined;
  const view = React.useMemo<AgentViewState>(() => ({
    traces,
    capabilities: capabilities.data ?? [],
    pendingOperation: openOperation,
    selectedCallID,
    selectCall,
    activity: isRunning ? {
      round: frame.round,
      startedAtMS,
      isThinking: frame.parts.at(-1)?.type === 'thought',
      runningCall,
    } : undefined,
  }), [traces, capabilities.data, openOperation, selectedCallID, selectCall, isRunning, frame, startedAtMS, runningCall]);

  // ── exports ────────────────────────────────────────────────────────────────

  const exportConversation = (format: 'markdown' | 'json') => {
    if (!session.data) return;
    const now = new Date();
    if (format === 'json') {
      saveBlob(new Blob([`${JSON.stringify(session.data, null, 2)}\n`], { type: 'application/json' }), exportFileName('omc-agent', 'json', now));
      return;
    }
    saveBlob(new Blob([conversationMarkdown(session.data, exportLabels, now)], { type: 'text/markdown;charset=utf-8' }), exportFileName('omc-agent', 'md', now));
  };

  // ── frame ──────────────────────────────────────────────────────────────────

  const runError = localError || errorCode;
  const notices = (
    <>
      {isDemo && <Notice tone="info" title={t('agent.demo')} />}
      {session.isError && (
        <LoadFailure title={t('agent.session.failed')} onRetry={() => void session.refetch()} />
      )}
      {!isDemo && keys.isSuccess && keys.data.keys.length === 0 && (
        <Notice tone="info" title={t('pg.no_keys')} action={<Link to="/api-keys">{t('pg.manage_keys')}</Link>} />
      )}
      {!isDemo && !!fingerprint && directory.isSuccess && directory.data.models.length === 0 && (
        <Notice tone="info" title={t('pg.no_models')} action={<Link to="/ai-providers">{t('pg.manage_models')}</Link>} />
      )}
      {!!session.data?.omitted && <Notice tone="info" title={t('agent.omitted')} />}
      {rejection && (
        <Notice
          tone="warning"
          data-testid="agent-rejected"
          onClose={() => setRejection(undefined)}
          title={t('agent.rejected', { reason: t(failureKey(rejection.code)) })}
          description={<code>{rejection.code}</code>}
          action={(
            <Button
              size="small"
              disabled={isRunning || isAwaiting}
              onClick={() => {
                const text = rejection.text;
                setRejection(undefined);
                if (runtime.thread.composer.getState().text === text) runtime.thread.composer.setText('');
                void runtime.thread.append({ role: 'user', content: [{ type: 'text', text }] });
              }}
            >
              {t('common.retry')}
            </Button>
          )}
        />
      )}
      {runError && (
        <Notice
          tone="error"
          onClose={() => { setLocalError(''); clearError(); }}
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
      <Dropdown
        disabled={turns.length === 0}
        menu={{
          items: [
            { key: 'markdown', label: t('agent.export.markdown') },
            { key: 'json', label: t('agent.export.json') },
          ],
          onClick: ({ key }) => exportConversation(key as 'markdown' | 'json'),
        }}
      >
        <Button aria-label={t('agent.export')} icon={<DownloadOutlined />} disabled={turns.length === 0}>
          <span className={styles['action-label']}>{t('agent.export')}</span>
        </Button>
      </Dropdown>
      <Button aria-label={t('agent.new')} icon={<MessageOutlined />} disabled={isRunning || isDemo || turns.length === 0} onClick={() => void reset()}>
        <span className={styles['action-label']}>{t('agent.new')}</span>
      </Button>
      <Tooltip title={t('agent.panel')}>
        <Button
          aria-label={t('agent.panel')}
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
  const approvalHint = openOperation && !isQuestion && !isRunning ? (
    <div className={styles['awaiting']} role="status" data-testid="agent-awaiting">
      <WarningOutlined aria-hidden="true" />
      <span>{t('agent.operation.hint')}</span>
      <Button
        type="link"
        size="small"
        onClick={() => {
          const card = pageRef.current?.querySelector<HTMLElement>(`[data-approval-id="${CSS.escape(openOperation.id)}"]`);
          card?.scrollIntoView({ block: 'center' });
          card?.focus({ preventScroll: true });
        }}
      >
        {t('agent.operation.jump')}
      </Button>
    </div>
  ) : null;
  const quote = (
    <ComposerPrimitive.Quote className={styles['quote']}>
      <QuoteOutlined aria-hidden="true" />
      <ComposerPrimitive.QuoteText className={styles['quote-text']} />
      <ComposerPrimitive.QuoteDismiss asChild>
        <Button type="text" size="small" aria-label={t('agent.quote.dismiss')} icon={<CloseOutlined />} />
      </ComposerPrimitive.QuoteDismiss>
    </ComposerPrimitive.Quote>
  );

  const empty = (
    <div className={workspace['empty']} data-testid="agent-empty">
      <BrandArtwork shape="wordmark" height={28} className={workspace['empty-mark']} label="Oh My CPA" />
      <p className={workspace['empty-text']}>{t('agent.empty.description')}</p>
      <div className={styles['examples']}>
        <span className={styles['examples-label']}>{t('agent.examples')}</span>
        <div className={workspace['suggestions']}>
          {EXAMPLES.map(example => (
            <ThreadPrimitive.Suggestion key={example.key} prompt={t(example.key)} send={false} className={workspace['suggestion']}>
              {example.icon}
              <span>{t(example.key)}</span>
            </ThreadPrimitive.Suggestion>
          ))}
        </div>
      </div>
    </div>
  );

  const selectedTrace = selectedCallID ? traces.get(selectedCallID) : undefined;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AgentToolUIs />
      <AgentViewContext.Provider value={view}>
        <div ref={pageRef} className={styles['page']}>
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
              title: t('agent.panel'),
              tabs: [
                {
                  key: 'directory',
                  label: t('agent.directory'),
                  content: <CapabilityDirectory capabilities={capabilities.data ?? []} isPending={capabilities.isPending} isError={capabilities.isError} onRetry={() => void capabilities.refetch()} />,
                },
                { key: 'details', label: t('agent.details'), content: <CallDetails trace={selectedTrace} /> },
                {
                  key: 'connect',
                  label: t('agent.connect'),
                  content: <ExternalAgentGuide capabilities={capabilities.data ?? []} operationID={linkedOperation} isDemo={isDemo} />,
                },
              ],
              activeTab: panelTab,
              onTabChange: key => setPanelTab(key as PanelTab),
              isOpen: isPanelOpen,
              onOpenChange: setIsPanelOpen,
              resizeLabel: t('agent.directory.resize'),
              defaultWidth: 360,
              minWidth: 280,
              maxWidth: 640,
            }}
          >
            {session.isPending ? (
              <div className={workspace['empty']} data-testid="agent-loading" aria-busy="true" />
            ) : (
              <AssistantThread
                empty={empty}
                latestLabel={t('pg.latest')}
                testId="agent-transcript"
                toolbar={(
                  <SelectionToolbarPrimitive.Root className={styles['selection-toolbar']}>
                    <SelectionToolbarPrimitive.Quote asChild>
                      <Button type="text" size="small" className={styles['selection-action']} icon={<QuoteOutlined />}>{t('agent.quote')}</Button>
                    </SelectionToolbarPrimitive.Quote>
                  </SelectionToolbarPrimitive.Root>
                )}
              >
                {() => <AgentMessage />}
              </AssistantThread>
            )}
            {openOperation && isQuestion ? (
              <div className={workspace['composer']}>
                <QuestionPanel key={openOperation.id} operation={openOperation} onDecided={answerQuestion} />
              </div>
            ) : (
              <AssistantComposer
                placeholder={t('agent.message')}
                inputLabel={t('agent.message')}
                sendLabel={t(isRunning ? 'agent.queue.send' : 'agent.send')}
                stopLabel={t('agent.stop')}
                blockedReason={isAwaiting ? t('agent.operation.hint') : undefined}
                header={<>{approvalHint}{quote}</>}
                footerStart={(
                  <ReasoningEffortPicker
                    value={reasoningEffort}
                    isDisabled={isRunning || isAwaiting}
                    onChange={value => chooseTarget({ fingerprint, model, reasoningEffort: value })}
                  />
                )}
                note={t('agent.data_notice')}
                queue={{ title: t('agent.queue.title'), removeLabel: t('agent.queue.remove') }}
              />
            )}
          </WorkspaceLayout>
        </div>
      </AgentViewContext.Provider>
    </AssistantRuntimeProvider>
  );
}
