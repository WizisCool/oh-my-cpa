import React from 'react';
import { Button, Drawer, Dropdown } from 'antd';
import { LabelTip } from '../../components/common/LabelTip';
import { AssistantRuntimeProvider, ComposerPrimitive, SelectionToolbarPrimitive, ThreadPrimitive } from '@assistant-ui/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { BrandArtwork } from '../../components/common/BrandArtwork';
import {
  AppstoreOutlined, BarChartOutlined, CloseOutlined, DashboardOutlined, DatabaseOutlined, DownloadOutlined, EditOutlined, FileTextOutlined,
  LinkOutlined, MessageOutlined, PictureOutlined, PlayCircleOutlined, PlusOutlined, QuoteOutlined, ReloadOutlined, StopOutlined, ToolOutlined, WarningOutlined,
} from '../../components/icons';
import { AssistantComposer } from '../../components/workspace/AssistantComposer';
import type { ComposerCommand, ComposerTriggers } from '../../components/workspace/AssistantComposer';
import { AssistantThread } from '../../components/workspace/AssistantThread';
import { EndpointPicker } from '../../components/workspace/EndpointPicker';
import { ReasoningEffortPicker } from '../../components/workspace/ReasoningEffortPicker';
import { TargetChip } from '../../components/workspace/TargetChip';
import workspace from '../../components/workspace/Workspace.module.css';
import { exportFileName } from '../../agent/export';
import type { Presentation, Trace } from '../../agent/types';
import { useTokenDisplayStyle } from '../../types/tokenDisplayContext';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { useVisibleViewport } from '../../hooks/useVisibleViewport';
import { usePreference } from '../../hooks/usePreference';
import { gatewayCallPointOf } from '../../types/gatewayModels';
import { referenceContextWindow } from '../../types/modelSquare';
import { DEFAULT_INFERENCE_ENDPOINT, parseInferenceEndpoint } from '../../types/inferenceEndpoints';
import type { InferenceEndpoint } from '../../types/inferenceEndpoints';
import { ContextReadout } from '../../components/workspace/ContextReadout';
import { useI18n } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import { writeDemoQuestion } from '../../demo/session';
import { useDemoArrivalToast } from '../../components/common/DemoNotice';
import { saveBlob } from '../../utils/download';
import { ThreadPlaceholder } from '../../components/workspace/ThreadPlaceholder';
import { AgentMessage } from './AgentMessage';
import { failureCode, getCapabilities, getOperation, getSession, readTurnImages, resetSession } from './api';
import { CapabilityDirectory } from './CapabilityDirectory';
import { ExternalAgentGuide } from './ExternalAgentGuide';
import { agentSnapshot } from '../../agent/conversationSnapshot';
import { useConversationExport } from '../../components/workspace/useConversationExport';
import { QuestionPanel } from './interrupts/QuestionPanel';
import { AgentAttachmentAdapter, splitAttachedFiles } from './attachments';
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
 * question this deployment answers without a decision to approve: readings from read capabilities,
 * or a picture the model draws for itself. It teaches the shape of a request and of an answer.
 */
const EXAMPLES = [
  { key: 'agent.example.usage', icon: <BarChartOutlined aria-hidden="true" /> },
  { key: 'agent.example.pelican', icon: <PlayCircleOutlined aria-hidden="true" /> },
  { key: 'agent.example.quota', icon: <DashboardOutlined aria-hidden="true" /> },
  { key: 'agent.example.daily', icon: <DatabaseOutlined aria-hidden="true" /> },
];

/** The example the demonstration has a recorded run for. */
const DEMO_REPLAY_EXAMPLE = 'agent.example.daily';

/**
 * What the drawer beside the conversation shows. It is closed until something is asked of it - the
 * capability directory, the connection guide - so the page at rest is the conversation and nothing
 * else. A call's own details open in the conversation, under the call (ADR 0084).
 */
type DrawerView = 'directory' | 'connect';

const DRAWER_TITLES: Record<DrawerView, string> = {
  directory: 'agent.directory',
  connect: 'agent.connect',
};

/** How each presentation a command can ask for is drawn on its chip. */
const PRESENTATIONS: Record<Presentation, { label: string; icon: React.ReactNode }> = {
  ui: { label: 'agent.present.ui', icon: <AppstoreOutlined aria-hidden="true" /> },
  canvas: { label: 'agent.present.canvas', icon: <AppstoreOutlined aria-hidden="true" /> },
  text: { label: 'agent.present.text', icon: <FileTextOutlined aria-hidden="true" /> },
};

/** The least a visible viewport falls short of the layout by when a software keyboard is up, in
 *  pixels: more than a browser's collapsing toolbars, less than the shortest keyboard. */
const KEYBOARD_MIN_HEIGHT = 160;

export function AgentPage() {
  const { t, lang } = useI18n();
  const queryClient = useQueryClient();
  const isDemo = isDemoMode();
  const isPhone = useIsPhoneViewport();
  const pageRef = React.useRef<HTMLDivElement>(null);

  const [drawerView, setDrawerView] = React.useState<DrawerView>();
  const closeDrawer = React.useCallback(() => setDrawerView(undefined), []);
  useOverlayHistory({ isOpen: !!drawerView, onClose: closeDrawer });
  // The drawer keeps drawing what it showed while it slides shut.
  const shownViewRef = React.useRef<DrawerView>('directory');
  if (drawerView) shownViewRef.current = drawerView;

  // On a phone the shell ends where the visible viewport does, so the composer stays above a
  // software keyboard and the transcript keeps its own scroll.
  const visibleViewport = useVisibleViewport(isPhone);
  React.useLayoutEffect(() => {
    const shell = pageRef.current;
    if (!shell) return;
    shell.style.maxHeight = isPhone
      ? `${Math.max(0, visibleViewport.top + visibleViewport.height - shell.getBoundingClientRect().top)}px`
      : '';
  }, [isPhone, visibleViewport]);
  // A software keyboard leaves the conversation a few lines. The page's actions give their row
  // back while it is up: each is also a `/` command, and all return when the keyboard goes.
  const isKeyboardOpen = isPhone && visibleViewport.bottom >= KEYBOARD_MIN_HEIGHT;
  const [fingerprint, setFingerprint] = React.useState('');
  const [model, setModel] = React.useState('');
  const [reasoningEffort, setReasoningEffort] = React.useState('');
  const [endpoint, setEndpoint] = React.useState<InferenceEndpoint>(DEFAULT_INFERENCE_ENDPOINT);
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

  const { style: tokenStyle } = useTokenDisplayStyle();
  const run = useAgentRun({ conversation: session.data, model, fingerprint, reasoningEffort, endpoint, language: lang, tokenStyle, onConversation: acceptConversation });
  const { isRunning, frame, errorCode, startedAtMS, clearError } = run;

  // ── the selector ───────────────────────────────────────────────────────────
  //
  // Restored once, from the operator's own last choice, or from what the stored conversation ran
  // with when there is no choice yet. A conversation waiting on an approval is the exception: it
  // can only be resumed with the key and model it started with, so those win. After this the
  // selector belongs to the operator - a session refetch after a tool result never moves it.
  const [isTargetRestored, setIsTargetRestored] = React.useState(false);
  React.useEffect(() => {
    if (isTargetRestored || !session.data || !targetPref.ready) return;
    setIsTargetRestored(true);
    const stored = targetPref.value;
    const source: AgentTarget = isAwaitingApproval(session.data) || !stored.client_key_fingerprint
      ? { client_key_fingerprint: session.data.client_key_fingerprint, model: session.data.model, reasoning_effort: session.data.reasoning_effort, endpoint: parseInferenceEndpoint(session.data.endpoint) }
      : stored;
    setFingerprint(source.client_key_fingerprint ?? '');
    setModel(source.model ?? '');
    setReasoningEffort(source.reasoning_effort ?? '');
    setEndpoint(source.endpoint ?? DEFAULT_INFERENCE_ENDPOINT);
  }, [isTargetRestored, session.data, targetPref.ready, targetPref.value]);

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
    // The demonstration always has one: a visitor is there to see a run, not to configure one.
    if (!model && (models.length === 1 || isDemo && models.length > 0)) setModel(gatewayCallPointOf(models[0]));
  }, [models, directory.isFetching, model, isDemo]);
  React.useEffect(() => {
    if (!isDemo || fingerprint || !isTargetRestored || !keys.isSuccess) return;
    const first = keys.data.keys.find(key => key.usage_fingerprint)?.usage_fingerprint;
    if (first) setFingerprint(first);
  }, [isDemo, fingerprint, isTargetRestored, keys.isSuccess, keys.data]);

  const { set: persistTarget } = targetPref;
  const chooseTarget = (change: Partial<{ fingerprint: string; model: string; reasoningEffort: string; endpoint: InferenceEndpoint }>) => {
    const next = { fingerprint, model, reasoningEffort, endpoint, ...change };
    setFingerprint(next.fingerprint);
    setModel(next.model);
    setReasoningEffort(next.reasoningEffort);
    setEndpoint(next.endpoint);
    if (isDemo) return;
    void persistTarget({
      ...(next.fingerprint ? { client_key_fingerprint: next.fingerprint } : {}),
      ...(next.model ? { model: next.model } : {}),
      ...(next.reasoningEffort ? { reasoning_effort: next.reasoningEffort } : {}),
      ...(next.endpoint !== DEFAULT_INFERENCE_ENDPOINT ? { endpoint: next.endpoint } : {}),
    });
  };

  useDemoArrivalToast(t('agent.demo'));
  const replayQuestion = t(DEMO_REPLAY_EXAMPLE);
  React.useEffect(() => {
    if (isDemo) writeDemoQuestion(replayQuestion);
  }, [isDemo, replayQuestion]);

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

  // Editing the newest message: its text is back in the composer, and the next send replaces its
  // turn. Held by turn id, so a conversation that has moved on forgets it without being told.
  const replaceableID = replaceableTurnID(session.data, capabilities.data ?? []);
  const canReplace = !!replaceableID && !isRunning && !isDemo && isFullyConfigured;
  const [editTarget, setEditTarget] = React.useState('');
  const editingTurnID = editTarget && editTarget === replaceableID ? editTarget : '';
  // The composer shows the message's words; the files it carried stay attached to the edit.
  const editedMessage = React.useMemo(() => splitAttachedFiles(editingTurnID ? session.data?.turns.at(-1)?.user ?? '' : ''), [editingTurnID, session.data]);
  // What `/ui` or `/text` asked of the next answer: held until that message is sent.
  const [present, setPresent] = React.useState<Presentation>();
  const presentRef = React.useRef(present);
  presentRef.current = present;
  const editingRef = React.useRef({ turnID: editingTurnID, files: editedMessage.blocks });
  editingRef.current = { turnID: editingTurnID, files: editedMessage.blocks };

  // The adapter lives as long as the workspace, so it reaches the current toast and language
  // through a ref rather than being rebuilt - and losing its attached files - when either changes.
  const toast = useToast();
  const refuseFileRef = React.useRef<(kind: 'image' | 'file') => void>(() => {});
  refuseFileRef.current = kind => toast.warning(t(kind === 'image' ? 'agent.attach.invalid_image' : 'agent.attach.invalid'));
  const fileAdapter = React.useMemo(() => new AgentAttachmentAdapter(kind => refuseFileRef.current(kind)), []);

  const runtime = useAgentThreadRuntime({
    conversation: session.data,
    run,
    attachments: fileAdapter,
    takeSendOptions: React.useCallback(() => {
      const options = { ...editingRef.current, present: presentRef.current };
      setEditTarget('');
      setPresent(undefined);
      return options;
    }, []),
    isDisabled: !session.data,
    isSendDisabled: !isFullyConfigured || isAwaiting,
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
    void run.send(newestTurn.user, { replaceTurn: newestTurn.id, present: newestTurn.present }).catch((cause: unknown) => {
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
      acceptConversation(await resetSession(session.data.revision, session.data));
      runtime.thread.composer.setText('');
      setLocalError('');
      setRejection(undefined);
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

  const runningCall = isRunning ? frame.traces.find(trace => trace.result.status === 'running')?.name : undefined;
  const view = React.useMemo<AgentViewState>(() => ({
    traces,
    capabilities: capabilities.data ?? [],
    pendingOperation: openOperation,
    activity: isRunning ? {
      retry: frame.retry,
      startedAtMS,
      isThinking: frame.parts.at(-1)?.type === 'thought',
      runningCall,
    } : undefined,
    replaceableTurnID: canReplace ? replaceableID : '',
    retryTurn,
    editTurn,
    composeMessage: message => {
      const composer = runtime.thread.composer;
      const current = composer.getState().text;
      setEditTarget('');
      composer.setText(current.trim() ? `${current}\n\n${message}` : message);
    },
  }), [traces, capabilities.data, openOperation, isRunning, frame, startedAtMS, runningCall, canReplace, replaceableID, retryTurn, editTurn, runtime]);

  // ── exports ────────────────────────────────────────────────────────────────

  const exportConversation = (format: 'html' | 'image' | 'json') => {
    if (!session.data) return;
    const now = new Date();
    if (format === 'json') {
      saveBlob(new Blob([`${JSON.stringify(session.data, null, 2)}\n`], { type: 'application/json' }), exportFileName('omc-agent', 'json', now));
      return;
    }
    const conversation = session.data;
    void readTurnImages(conversation.turns)
      .then(images => exportSnapshot(agentSnapshot(conversation, images), format))
      .catch(() => toast.error(t('agent.export.failed')));
  };

  // ── composer triggers ──────────────────────────────────────────────────────

  // Every command does something the page can do right now: it sets how the next answer is
  // presented, or runs a page action. One that cannot run is left out rather than listed inert.
  // The handlers close over this render's session; the list itself must keep its identity while
  // the operator types, or the open list would rebuild under the highlighted row.
  const commandHandlers = React.useRef({ reset, exportConversation, retryTurn, editTurn, stop: run.stop, openPanel: setDrawerView });
  commandHandlers.current = { reset, exportConversation, retryTurn, editTurn, stop: run.stop, openPanel: setDrawerView };
  const canAsk = !isDemo && !isAwaiting;
  const hasTurns = turns.length > 0;
  const triggers = React.useMemo<ComposerTriggers>(() => {
    const handlers = () => commandHandlers.current;
    const offered: (ComposerCommand | false)[] = [
      canAsk && { id: 'ui', description: t('agent.command.ui'), icon: PRESENTATIONS.ui.icon, run: () => setPresent('ui') },
      canAsk && { id: 'text', description: t('agent.command.text'), icon: PRESENTATIONS.text.icon, run: () => setPresent('text') },
      isRunning && { id: 'stop', description: t('agent.command.stop'), icon: <StopOutlined />, run: () => handlers().stop() },
      canReplace && { id: 'retry', description: t('agent.command.retry'), icon: <ReloadOutlined />, run: () => handlers().retryTurn() },
      canReplace && { id: 'edit', description: t('agent.command.edit'), icon: <EditOutlined />, run: () => handlers().editTurn() },
      hasTurns && !isRunning && { id: 'new', description: t('agent.new'), icon: <MessageOutlined />, run: () => void handlers().reset() },
      hasTurns && !isRunning && { id: 'export', description: t('agent.command.export'), icon: <DownloadOutlined />, run: () => handlers().exportConversation('html') },
      hasTurns && !isRunning && { id: 'image', description: t('agent.command.image'), icon: <PictureOutlined />, run: () => handlers().exportConversation('image') },
      { id: 'capabilities', description: t('agent.command.capabilities'), icon: <ToolOutlined />, run: () => handlers().openPanel('directory') },
      { id: 'connect', description: t('agent.command.connect'), icon: <LinkOutlined />, run: () => handlers().openPanel('connect') },
    ];
    return {
      commands: offered.filter((command): command is ComposerCommand => !!command),
      mentions: [
        ...(directory.data?.models ?? []).map(item => ({ id: `model:${gatewayCallPointOf(item)}`, label: gatewayCallPointOf(item), group: t('conversation.model') })),
        ...(keys.data?.keys ?? []).filter(key => Boolean(key.alias)).map(key => ({ id: `key:${key.alias}`, label: key.alias as string, group: t('conversation.client_key') })),
        ...(capabilities.data ?? []).map(capability => ({ id: `capability:${capability.name}`, label: capability.name, group: t('agent.mention.capability') })),
      ],
      emptyLabel: t('conversation.trigger.empty'),
    };
  }, [t, canAsk, canReplace, isRunning, hasTurns, isDemo, directory.data, keys.data, capabilities.data]);

  // ── frame ──────────────────────────────────────────────────────────────────

  const runError = localError || errorCode;
  const notices = (
    <>
      {session.isError && (
        <LoadFailure title={t('agent.session.failed')} onRetry={() => void session.refetch()} />
      )}
      {!isDemo && keys.isSuccess && keys.data.keys.length === 0 && (
        <Notice tone="info" title={t('pg.no_keys')} action={<Link to="/api-keys">{t('pg.manage_keys')}</Link>} />
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

  // The page's own actions float over the conversation's top trailing corner, together: starting
  // over leads them, named, because it is the one a reader goes looking for; export, the
  // capability directory and the connection guide follow as icons.
  const canExport = hasTurns && !isRunning && !isExporting;
  const bar = (
    <div className={styles['shell-bar']}>
      {hasTurns && (
        <LabelTip title={isPhone ? t('agent.new') : undefined}>
          <Button type="text" className={styles['shell-new']} data-testid="agent-new" aria-label={t('agent.new')} icon={<MessageOutlined />} disabled={isRunning} onClick={() => void reset()}>
            <span>{t('agent.new')}</span>
          </Button>
        </LabelTip>
      )}
      {hasTurns && <span className={styles['shell-bar-rule']} aria-hidden="true" />}
      {hasTurns && (
        <Dropdown
          trigger={['click']}
          open={isExportMenuOpen}
          onOpenChange={setIsExportMenuOpen}
          disabled={!canExport}
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
          <LabelTip title={t('agent.export')} open={isExportMenuOpen ? false : undefined}>
            <Button type="text" aria-label={t('agent.export')} icon={<DownloadOutlined />} loading={isExporting} disabled={!canExport} />
          </LabelTip>
        </Dropdown>
      )}
      <LabelTip title={t('agent.directory')}>
        <Button type="text" data-testid="agent-directory-open" aria-label={t('agent.directory')} icon={<ToolOutlined />} onClick={() => setDrawerView('directory')} />
      </LabelTip>
      <LabelTip title={t('agent.connect')}>
        <Button type="text" aria-label={t('agent.connect')} icon={<LinkOutlined />} onClick={() => setDrawerView('connect')} />
      </LabelTip>
    </div>
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

  const chips = editingTurnID || present ? (
    <>
      {editingTurnID && (
        <span className={workspace['composer-chip']} data-testid="agent-editing">
          <EditOutlined aria-hidden="true" />
          <span className={workspace['composer-chip-text']}>
            {t('agent.turn.editing')}
            {editedMessage.files.map(file => <React.Fragment key={file.name}> · <code>{file.name}</code></React.Fragment>)}
            {!!newestTurn?.images?.length && <> · {t('agent.turn.images', { n: newestTurn.images.length })}</>}
          </span>
          <LabelTip title={t('agent.turn.edit_cancel')}>
            <Button type="text" size="small" aria-label={t('agent.turn.edit_cancel')} icon={<CloseOutlined />} onClick={() => { setEditTarget(''); runtime.thread.composer.setText(''); }} />
          </LabelTip>
        </span>
      )}
      {present && (
        <span className={workspace['composer-chip']} data-tone="accent" data-testid="agent-present" data-present={present}>
          {PRESENTATIONS[present].icon}
          <span className={workspace['composer-chip-text']}>{t(PRESENTATIONS[present].label)}</span>
          <LabelTip title={t('agent.present.remove')}>
            <Button type="text" size="small" aria-label={t('agent.present.remove')} icon={<CloseOutlined />} onClick={() => setPresent(undefined)} />
          </LabelTip>
        </span>
      )}
    </>
  ) : null;

  // An empty conversation is a place to start, not a frame waiting to be filled: the greeting, the
  // box and a few questions sit together in the middle of the page, and the box takes its place at
  // the bottom once there is a conversation above it.
  const isHero = !session.isPending && !hasTurns && !isRunning;
  const hero = (
    <div className={styles['hero']} data-testid="agent-empty">
      <BrandArtwork shape="wordmark" height={26} className={styles['hero-mark']} label="Oh My CPA" />
      <p className={styles['hero-text']}>{t('agent.empty.description')}</p>
    </div>
  );
  // The demonstration answers one question, from a recording (ADR 0092): it is the only example
  // offered there, and choosing it sends it.
  const shownExamples = isDemo ? EXAMPLES.filter(example => example.key === DEMO_REPLAY_EXAMPLE) : EXAMPLES;
  const examples = (
    <div className={styles['examples']} aria-label={t('agent.examples')}>
      {shownExamples.map(example => (
        <ThreadPrimitive.Suggestion key={example.key} prompt={t(example.key)} send={isDemo} className={workspace['example']} data-testid={isDemo ? 'agent-demo-example' : undefined}>
          {example.icon}
          <span>{t(example.key)}</span>
        </ThreadPrimitive.Suggestion>
      ))}
    </div>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime} config={AGENT_AUI_CONFIG}>
      <AgentViewContext.Provider value={view}>
        <div ref={pageRef} className={styles['shell']} data-testid="agent-page" data-hero={isHero || undefined} data-keyboard={isKeyboardOpen || undefined}>
          {bar}
          <main className={styles['shell-main']}>
            {notices}
            {session.isPending ? (
              <ThreadPlaceholder testId="agent-loading" />
            ) : (
              <AssistantThread
                // The thread is one render behind the stored conversation, and for that render it
                // is empty: the greeting is offered only when the conversation itself has no turns.
                empty={isHero ? hero : undefined}
                isCompact={isHero}
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
                placeholder={t(isPhone ? 'agent.message' : 'agent.message.placeholder')}
                inputLabel={t('agent.message')}
                sendLabel={t(isRunning ? 'agent.queue.send' : 'agent.send')}
                stopLabel={t('agent.stop')}
                blockedReason={isAwaiting ? t('agent.operation.hint') : !isFullyConfigured ? t('conversation.target.choose') : undefined}
                header={<>{approvalHint}{quote}</>}
                chips={chips}
                // The endpoint leads the foot, as in the Playground. A turn waiting on a decision
                // pins it with the rest: its calls are replayed in the schema they were made in.
                footerStart={<EndpointPicker value={endpoint} isDisabled={isAwaiting} onChange={value => chooseTarget({ endpoint: value })} />}
                footerEnd={(
                  <>
                    {/* Both settings belong to the next message, and a message can be written and
                        queued while a run works, so both stay open during one. Only a turn waiting
                        on a decision pins them: it resumes with what it started with. */}
                    <ReasoningEffortPicker
                      value={reasoningEffort}
                      isDisabled={isAwaiting}
                      onChange={value => chooseTarget({ reasoningEffort: value })}
                    />
                    <TargetChip
                      keys={keys.data?.keys ?? []}
                      models={directory.data?.models ?? []}
                      fingerprint={fingerprint}
                      model={model}
                      isKeysLoading={keys.isFetching}
                      isModelsLoading={directory.isFetching}
                      isDisabled={isAwaiting}
                      isPending={!isTargetRestored && !session.isError}
                      onFingerprintChange={value => chooseTarget({ fingerprint: value, model: '' })}
                      onModelChange={value => chooseTarget({ model: value })}
                      onRefresh={() => {
                        void keys.refetch();
                        void capabilities.refetch();
                        if (fingerprint) void directory.refetch();
                      }}
                      emptyHint={!isDemo && keys.isSuccess && keys.data.keys.length === 0
                        ? <>{t('pg.no_keys')} <Link to="/api-keys">{t('pg.manage_keys')}</Link></>
                        : !isDemo && !!fingerprint && directory.isSuccess
                          ? <>{t('pg.no_models')} <Link to="/ai-providers">{t('pg.manage_models')}</Link></>
                          : undefined}
                    />
                  </>
                )}
                note={t('agent.data_notice')}
                status={<ContextReadout usedTokens={turns.at(-1)?.usage?.context_tokens} windowTokens={referenceContextWindow(reference.data, model)} />}
                attachments={{ addLabel: t('agent.attach.add'), removeLabel: t('agent.attach.remove'), icon: <PlusOutlined /> }}
                queue={{ summary: count => t('agent.queue.summary', { count: String(count) }), removeLabel: t('agent.queue.remove') }}
                triggers={triggers}
              />
            )}
            {isHero && !(openOperation && isQuestion) && examples}
          </main>
          <Drawer
            title={t(DRAWER_TITLES[shownViewRef.current])}
            placement="right"
            open={!!drawerView}
            onClose={closeDrawer}
            size={shownViewRef.current === 'connect' ? 'min(560px, 92vw)' : 'min(440px, 92vw)'}
            className={workspace['drawer']}
            data-testid="agent-drawer"
          >
            {shownViewRef.current === 'directory' && (
              <CapabilityDirectory capabilities={capabilities.data ?? []} isPending={capabilities.isPending} isError={capabilities.isError} onRetry={() => void capabilities.refetch()} />
            )}
            {shownViewRef.current === 'connect' && <ExternalAgentGuide isDemo={isDemo} />}
          </Drawer>
        </div>
      </AgentViewContext.Provider>
    </AssistantRuntimeProvider>
  );
}
