import React from 'react';
import { Button, Dropdown, Tooltip } from 'antd';
import { AssistantRuntimeProvider, ComposerPrimitive, SelectionToolbarPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { BrandArtwork } from '../../components/common/BrandArtwork';
import {
  BarChartOutlined, CloseOutlined, DashboardOutlined, DatabaseOutlined, DownloadOutlined, EditOutlined, FullscreenOutlined, LayoutOutlined, MessageOutlined, PaperClipOutlined, QuoteOutlined, ReloadOutlined, WarningOutlined,
} from '../../components/icons';
import { AssistantComposer } from '../../components/workspace/AssistantComposer';
import type { ComposerTriggers } from '../../components/workspace/AssistantComposer';
import { AssistantThread } from '../../components/workspace/AssistantThread';
import { ReasoningEffortPicker } from '../../components/workspace/ReasoningEffortPicker';
import { TargetPicker } from '../../components/workspace/TargetPicker';
import { WorkspaceLayout } from '../../components/workspace/WorkspaceLayout';
import workspace from '../../components/workspace/Workspace.module.css';
import { exportFileName } from '../../agent/export';
import type { PageContext } from '../../agent/pageContext';
import type { Trace } from '../../agent/types';
import { NARROW_VIEWPORT_QUERY } from '../../hooks/useIsNarrowViewport';
import { usePreference } from '../../hooks/usePreference';
import { gatewayCallPointOf } from '../../types/gatewayModels';
import { referenceContextWindow } from '../../types/modelSquare';
import { ContextReadout } from '../../components/workspace/ContextReadout';
import { useI18n } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import { saveBlob } from '../../utils/download';
import { AgentMessage } from './AgentMessage';
import { failureCode, getCapabilities, getOperation, getSession, resetSession } from './api';
import { CallDetails } from './CallDetails';
import { CapabilityDirectory } from './CapabilityDirectory';
import { ExternalAgentGuide } from './ExternalAgentGuide';
import { agentSnapshot } from '../../agent/conversationSnapshot';
import { useConversationExport } from '../../components/workspace/useConversationExport';
import { QuestionPanel } from './interrupts/QuestionPanel';
import { AgentTextFileAdapter, splitAttachedFiles } from './attachments';
import { useAgentThreadRuntime } from './runtime';
import {
  AGENT_TARGET_PREFERENCE, DEFAULT_AGENT_TARGET, failureKey, isAwaitingApproval, parseAgentTarget, pendingOperationID, replaceableTurnID,
} from './state';
import type { AgentTarget, Conversation, Operation } from './state';
import { mergeLiveTurn } from './thread';
import { AgentViewContext } from './tools/AgentViewContext';
import type { AgentViewState } from './tools/AgentViewContext';
import { AGENT_AUI_CONFIG } from './tools/registry';
import { RunRejectedError, useAgentRun } from './useAgentRun';
import styles from './AgentPage.module.css';
import { LoadFailure, Notice, useToast } from '../../components/feedback';

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

/**
 * What the assistant is asked first from a given page: the question that page most often raises,
 * ahead of the general examples. A page without an entry offers the general ones alone.
 */
const PAGE_STARTERS: Partial<Record<PageContext['page'], string>> = {
  'usage/events': 'agent.starter.requests',
  quota: 'agent.starter.quota',
  'ai-providers': 'agent.starter.providers',
  'api-keys': 'agent.starter.keys',
  pricing: 'agent.starter.pricing',
};
const SELECTION_STARTER = 'agent.starter.selection';

/** The console's own name for each page that can be context, as its navigation entry reads. */
const PAGE_LABELS: Record<PageContext['page'], string> = {
  dashboard: 'nav.dashboard', 'usage/events': 'nav.usage_events', quota: 'nav.quota', pricing: 'nav.pricing', 'api-keys': 'nav.api_keys',
  'ai-providers': 'nav.providers', 'auth-files': 'nav.auth_files', 'oauth-management': 'nav.auth_files', 'model-square': 'nav.model_square',
  logs: 'nav.logs', audit: 'nav.audit', config: 'nav.config', playground: 'nav.playground', 'omc-settings': 'nav.omc_settings',
  plugins: 'nav.plugins', system: 'nav.system',
};

type PanelTab = 'directory' | 'details' | 'connect';

export interface AgentWorkspaceProps {
  /** `dock` is the assistant beside another page: the same session in a narrower frame. */
  variant?: 'page' | 'dock';
  /** Where the operator is, when the workspace is not itself the page. */
  pageContext?: PageContext;
  /** Whether a docked workspace is the one on screen; a closed dock stays mounted. */
  isActive?: boolean;
  onExpand?: () => void;
  onClose?: () => void;
}

export function AgentPage() {
  return <AgentWorkspace />;
}

/**
 * The Agent's one workspace, shown as its own page or docked beside another (ADR 0073). Both read
 * the same stored conversation and rejoin the same server-side run, so moving between them - or
 * between pages with the dock open - never starts anything over.
 */
export function AgentWorkspace({ variant = 'page', pageContext, isActive = true, onExpand, onClose }: AgentWorkspaceProps) {
  const isDock = variant === 'dock';
  const { t, lang } = useI18n();
  const queryClient = useQueryClient();
  const isDemo = isDemoMode();
  const pageRef = React.useRef<HTMLDivElement>(null);

  const [isPanelOpen, setIsPanelOpen] = React.useState(() => !isDock && !window.matchMedia(NARROW_VIEWPORT_QUERY).matches);
  const [panelTab, setPanelTab] = React.useState<PanelTab>('directory');
  const [selectedCallID, setSelectedCallID] = React.useState('');
  const [fingerprint, setFingerprint] = React.useState('');
  const [model, setModel] = React.useState('');
  const [reasoningEffort, setReasoningEffort] = React.useState('');
  const [localError, setLocalError] = React.useState('');
  const [rejection, setRejection] = React.useState<{ code: string; text: string }>();
  const targetPref = usePreference<AgentTarget>(AGENT_TARGET_PREFERENCE, DEFAULT_AGENT_TARGET, parseAgentTarget);
  const { isExporting, exportSnapshot } = useConversationExport('agent');
  const [isExportMenuOpen, setIsExportMenuOpen] = React.useState(false);

  const session = useQuery({ queryKey: ['agent-session'], queryFn: ({ signal }) => getSession(signal) });
  const capabilities = useQuery({ queryKey: ['capabilities'], queryFn: ({ signal }) => getCapabilities(signal) });
  // The console's own key list entry, so creating a key on the key page refreshes this selector.
  const keys = useQuery({ queryKey: ['management-client-keys'], queryFn: () => api.getClientAPIKeys() });
  // Shared with the model directory page's cache; only the context window is read from it here.
  const reference = useQuery({ queryKey: ['model-square'], queryFn: () => api.getModelSquare(), staleTime: 30_000 });
  const directory = useQuery({
    queryKey: ['playground-models', fingerprint],
    queryFn: ({ signal }) => api.getGatewayModels(fingerprint, signal),
    enabled: !!fingerprint,
  });

  const acceptConversation = React.useCallback((conversation: Conversation) => {
    queryClient.setQueryData(['agent-session'], conversation);
  }, [queryClient]);

  // Context the operator removed stays removed until they are somewhere else: the chip is a
  // statement of what the next message will carry, so dismissing it must hold.
  const contextKey = pageContext ? `${pageContext.page}|${pageContext.selection?.kind ?? ''}:${pageContext.selection?.id ?? ''}|${pageContext.range ?? ''}` : '';
  const [dismissedContext, setDismissedContext] = React.useState('');
  const sentContext = pageContext && dismissedContext !== contextKey ? pageContext : undefined;

  const run = useAgentRun({ conversation: session.data, model, fingerprint, reasoningEffort, language: lang, pageContext: sentContext, onConversation: acceptConversation });
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

  // Opening the dock is asking to type. The composer mounts only once the conversation and its
  // target have loaded, so the request waits for the box instead of being lost to a frame in
  // which it is not there yet.
  React.useEffect(() => {
    if (!isDock || !isActive) return undefined;
    const root = pageRef.current;
    if (!root) return undefined;
    const focusInput = () => {
      const input = root.querySelector<HTMLTextAreaElement>('textarea[name="input"]');
      if (!input || input.disabled) return false;
      input.focus({ preventScroll: true });
      return true;
    };
    if (focusInput()) return undefined;
    const observer = new MutationObserver(() => { if (focusInput()) observer.disconnect(); });
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    return () => observer.disconnect();
  }, [isDock, isActive]);

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

  // Editing the newest message: its text is back in the composer, and the next send replaces its
  // turn. Held by turn id, so a conversation that has moved on forgets it without being told.
  const replaceableID = replaceableTurnID(session.data, capabilities.data ?? []);
  const canReplace = !!replaceableID && !isRunning && !isDemo && isFullyConfigured;
  const [editTarget, setEditTarget] = React.useState('');
  const editingTurnID = editTarget && editTarget === replaceableID ? editTarget : '';
  // The composer shows the message's words; the files it carried stay attached to the edit.
  const editedMessage = React.useMemo(() => splitAttachedFiles(editingTurnID ? session.data?.turns.at(-1)?.user ?? '' : ''), [editingTurnID, session.data]);
  const editingRef = React.useRef({ turnID: editingTurnID, files: editedMessage.blocks });
  editingRef.current = { turnID: editingTurnID, files: editedMessage.blocks };

  // The adapter lives as long as the workspace, so it reaches the current toast and language
  // through a ref rather than being rebuilt - and losing its attached files - when either changes.
  const toast = useToast();
  const refuseFileRef = React.useRef(() => {});
  refuseFileRef.current = () => toast.warning(t('agent.attach.invalid'));
  const fileAdapter = React.useMemo(() => new AgentTextFileAdapter(() => refuseFileRef.current()), []);

  const runtime = useAgentThreadRuntime({
    conversation: session.data,
    run,
    attachments: fileAdapter,
    takeReplaceTarget: React.useCallback(() => {
      const target = editingRef.current;
      setEditTarget('');
      return target;
    }, []),
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

  const newestTurn = session.data?.turns.at(-1);
  const retryTurn = React.useCallback(() => {
    if (!newestTurn) return;
    setEditTarget('');
    void run.send(newestTurn.user, newestTurn.id).catch((cause: unknown) => {
      if (cause instanceof RunRejectedError) setRejection({ code: cause.code, text: '' });
    });
  }, [newestTurn, run]);
  const editTurn = React.useCallback(() => {
    if (!newestTurn) return;
    setEditTarget(newestTurn.id);
    runtime.thread.composer.setText(splitAttachedFiles(newestTurn.user).text);
    focusComposer();
  }, [newestTurn, runtime, focusComposer]);

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
    replaceableTurnID: canReplace ? replaceableID : '',
    retryTurn,
    editTurn,
  }), [traces, capabilities.data, openOperation, selectedCallID, selectCall, isRunning, frame, startedAtMS, runningCall, canReplace, replaceableID, retryTurn, editTurn]);

  // ── exports ────────────────────────────────────────────────────────────────

  const exportConversation = (format: 'html' | 'image' | 'json') => {
    if (!session.data) return;
    const now = new Date();
    if (format === 'json') {
      saveBlob(new Blob([`${JSON.stringify(session.data, null, 2)}\n`], { type: 'application/json' }), exportFileName('omc-agent', 'json', now));
      return;
    }
    void exportSnapshot(agentSnapshot(session.data), format);
  };

  // ── composer triggers ──────────────────────────────────────────────────────

  // The handlers close over this render's session; the list itself must keep its identity while
  // the operator types, or the open list would rebuild under the highlighted row.
  const commandHandlers = React.useRef({ reset, exportConversation });
  commandHandlers.current = { reset, exportConversation };
  const triggers = React.useMemo<ComposerTriggers>(() => ({
    commands: [
      { id: 'new', description: t('agent.new'), run: () => void commandHandlers.current.reset() },
      { id: 'export', description: t('agent.export.html'), run: () => commandHandlers.current.exportConversation('html') },
      ...EXAMPLES.map(example => ({
        id: example.key.slice('agent.example.'.length),
        description: t(example.key),
        run: () => runtime.thread.composer.setText(t(example.key)),
      })),
    ],
    mentions: [
      ...(directory.data?.models ?? []).map(item => ({ id: `model:${gatewayCallPointOf(item)}`, label: gatewayCallPointOf(item), group: t('conversation.model') })),
      ...(keys.data?.keys ?? []).filter(key => Boolean(key.alias)).map(key => ({ id: `key:${key.alias}`, label: key.alias as string, group: t('conversation.client_key') })),
      ...(capabilities.data ?? []).map(capability => ({ id: `capability:${capability.name}`, label: capability.name, group: t('agent.mention.capability') })),
    ],
    emptyLabel: t('conversation.trigger.empty'),
  }), [t, runtime, directory.data, keys.data, capabilities.data]);

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

  const actions = isDock ? (
    <>
      <Tooltip title={t('agent.new')}>
        <Button type="text" aria-label={t('agent.new')} icon={<MessageOutlined />} disabled={isRunning || isDemo || turns.length === 0} onClick={() => void reset()} />
      </Tooltip>
      <Tooltip title={t('assistant.expand')}>
        <Button type="text" aria-label={t('assistant.expand')} icon={<FullscreenOutlined />} onClick={onExpand} />
      </Tooltip>
      <Tooltip title={t('assistant.close')}>
        <Button type="text" aria-label={t('assistant.close')} icon={<CloseOutlined />} onClick={onClose} />
      </Tooltip>
    </>
  ) : (
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
        trigger={['click']}
        open={isExportMenuOpen}
        onOpenChange={setIsExportMenuOpen}
        disabled={turns.length === 0 || isRunning || isExporting}
        menu={{
          items: [
            { key: 'html', label: t('agent.export.html') },
            { key: 'image', label: t('agent.export.image') },
            { key: 'json', label: t('agent.export.json') },
          ],
          onClick: ({ key }) => {
            setIsExportMenuOpen(false);
            exportConversation(key as 'html' | 'image' | 'json');
          },
        }}
      >
        <Button aria-label={t('agent.export')} icon={<DownloadOutlined />} loading={isExporting} disabled={turns.length === 0 || isRunning || isExporting}>
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

  const editChip = editingTurnID ? (
    <div className={styles['context-chip']} data-testid="agent-editing">
      <EditOutlined aria-hidden="true" />
      <span className={styles['context-text']}>
        {t('agent.turn.editing')}
        {editedMessage.files.map(file => <React.Fragment key={file.name}> · <code>{file.name}</code></React.Fragment>)}
      </span>
      <Tooltip title={t('agent.turn.edit_cancel')}>
        <Button type="text" size="small" aria-label={t('agent.turn.edit_cancel')} icon={<CloseOutlined />} onClick={() => { setEditTarget(''); runtime.thread.composer.setText(''); }} />
      </Tooltip>
    </div>
  ) : null;

  const contextChip = sentContext ? (
    <div className={styles['context-chip']} data-testid="agent-context">
      <LayoutOutlined aria-hidden="true" />
      <span className={styles['context-text']}>
        {t(PAGE_LABELS[sentContext.page])}
        {sentContext.selection && <> · <code>{sentContext.selection.label ?? (sentContext.selection.kind === 'request' ? `#${sentContext.selection.id}` : sentContext.selection.id)}</code></>}
        {sentContext.range && <> · {sentContext.range}</>}
      </span>
      <Tooltip title={t('assistant.context.remove')}>
        <Button type="text" size="small" aria-label={t('assistant.context.remove')} icon={<CloseOutlined />} onClick={() => setDismissedContext(contextKey)} />
      </Tooltip>
    </div>
  ) : null;

  // From another page, the questions that page raises come first.
  const starters = [
    ...(sentContext?.selection ? [SELECTION_STARTER] : []),
    ...(sentContext && PAGE_STARTERS[sentContext.page] ? [PAGE_STARTERS[sentContext.page] as string] : []),
  ];
  const empty = (
    <div className={workspace['empty']} data-testid="agent-empty">
      {!isDock && <BrandArtwork shape="wordmark" height={28} className={workspace['empty-mark']} label="Oh My CPA" />}
      <p className={workspace['empty-text']}>{t('agent.empty.description')}</p>
      <div className={styles['examples']}>
        <span className={styles['examples-label']}>{t('agent.examples')}</span>
        <div className={workspace['suggestions']}>
          {starters.map(key => (
            <ThreadPrimitive.Suggestion key={key} prompt={t(key)} send={false} className={workspace['suggestion']} data-starter="page">
              <LayoutOutlined aria-hidden="true" />
              <span>{t(key)}</span>
            </ThreadPrimitive.Suggestion>
          ))}
          {EXAMPLES.slice(0, isDock ? 4 - starters.length : EXAMPLES.length).map(example => (
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
    <AssistantRuntimeProvider runtime={runtime} config={AGENT_AUI_CONFIG}>
      <AgentViewContext.Provider value={view}>
        <div ref={pageRef} className={styles['page']}>
          <WorkspaceLayout
            testId={isDock ? 'assistant-workspace' : 'agent-page'}
            title={t(isDock ? 'assistant.title' : 'nav.agent')}
            isCompact={isDock}
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
                  content: <ExternalAgentGuide isDemo={isDemo} />,
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
                latestLabel={t('conversation.latest')}
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
                header={<>{approvalHint}{editChip}{contextChip}{quote}</>}
                footerStart={(
                  <ReasoningEffortPicker
                    value={reasoningEffort}
                    isDisabled={isRunning || isAwaiting}
                    onChange={value => chooseTarget({ fingerprint, model, reasoningEffort: value })}
                  />
                )}
                footerEnd={<ContextReadout usedTokens={turns.at(-1)?.usage?.context_tokens} windowTokens={referenceContextWindow(reference.data, model)} />}
                note={t('agent.data_notice')}
                attachments={{ addLabel: t('agent.attach.add'), removeLabel: t('agent.attach.remove'), icon: <PaperClipOutlined /> }}
                queue={{ title: t('agent.queue.title'), removeLabel: t('agent.queue.remove') }}
                triggers={triggers}
              />
            )}
          </WorkspaceLayout>
        </div>
      </AgentViewContext.Provider>
    </AssistantRuntimeProvider>
  );
}
