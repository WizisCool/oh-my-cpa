import React from 'react';
import { Button, Dropdown } from 'antd';
import { LabelTip } from '../../components/common/LabelTip';
import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { BrandArtwork } from '../../components/common/BrandArtwork';
import { DownloadOutlined, LayoutOutlined, MessageOutlined, PlayCircleOutlined } from '../../components/icons';
import { AssistantComposer } from '../../components/workspace/AssistantComposer';
import { AssistantThread } from '../../components/workspace/AssistantThread';
import { EndpointPicker } from '../../components/workspace/EndpointPicker';
import { ModelMark } from '../../components/workspace/ModelMark';
import { ReasoningEffortPicker } from '../../components/workspace/ReasoningEffortPicker';
import { TargetChip } from '../../components/workspace/TargetChip';
import { WorkspaceLayout } from '../../components/workspace/WorkspaceLayout';
import workspace from '../../components/workspace/Workspace.module.css';
import { exportFileName } from '../../agent/export';
import { playgroundSnapshot } from '../../agent/conversationSnapshot';
import { useConversationExport } from '../../components/workspace/useConversationExport';
import { saveBlob } from '../../utils/download';
import { usePreference } from '../../hooks/usePreference';
import { NARROW_VIEWPORT_QUERY } from '../../hooks/useIsNarrowViewport';
import { useI18n } from '../../i18n';
import { getAppConfig } from '../../types/config';
import { isDemoMode } from '../../types/demoMode';
import { useDemoArrivalToast } from '../../components/common/DemoNotice';
import { gatewayCallPointOf } from '../../types/gatewayModels';
import { failureCode } from './api';
import { playgroundErrorKey } from './errors';
import { InspectPanel } from './InspectPanel';
import { ParametersPanel } from './ParametersPanel';
import { PlaygroundMessage } from './PlaygroundTurn';
import { PlaygroundImageAdapter } from './attachments';
import { usePlaygroundThreadRuntime } from './runtime';
import {
  buildChatRequest, buildHistory, createID, DEFAULT_PLAYGROUND_ENDPOINT, DEFAULT_PLAYGROUND_PARAMETERS, DEFAULT_PLAYGROUND_SESSION,
  endpointOf, hasOmittedImage, MAX_REQUEST_BYTES, parametersFromSession, parsePlaygroundSession, playgroundUserAgent,
  PLAYGROUND_SESSION_PREFERENCE, readCustomBody, sessionDocument, usageLink,
} from './state';
import type { Content, Message, PlaygroundParameters, PlaygroundSession, PlaygroundTarget, Turn } from './state';
import { usePlaygroundRun } from './usePlaygroundRun';
import styles from './PlaygroundPage.module.css';
import { LoadFailure, Notice, useToast } from '../../components/feedback';

/**
 * How long the stored session waits for edits to settle before it is written.
 *
 * The document carries the whole bounded conversation, so writing it on every keystroke in the
 * system prompt would send the transcript to the server once per character.
 */
const PERSIST_DEBOUNCE_MS = 600;

type PanelTab = 'parameters' | 'inspect';

/** Module-level so the selection is not re-run on every render of the page. */
function selectNameableKeys(response: Awaited<ReturnType<typeof api.getClientAPIKeys>>) {
  return response.keys.filter(key => Boolean(key.usage_fingerprint));
}

const NO_TARGET: PlaygroundTarget = { fingerprint: '', model: '', endpoint: DEFAULT_PLAYGROUND_ENDPOINT };

export const PlaygroundPage: React.FC = () => {
  const { isExporting, exportSnapshot } = useConversationExport('playground');
  const [isExportMenuOpen, setIsExportMenuOpen] = React.useState(false);
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  useDemoArrivalToast(t('pg.demo'));
  const isDemo = isDemoMode();
  // The deployment's own build names the default User-Agent in the placeholder and the copied
  // cURL; the server resolves the value that actually leaves the process.
  const defaultUserAgent = playgroundUserAgent(getAppConfig().version);

  const sessionPref = usePreference<PlaygroundSession>(PLAYGROUND_SESSION_PREFERENCE, DEFAULT_PLAYGROUND_SESSION, parsePlaygroundSession);
  const [target, setTarget] = React.useState<PlaygroundTarget>(NO_TARGET);
  const [parameters, setParameters] = React.useState<PlaygroundParameters>(DEFAULT_PLAYGROUND_PARAMETERS);
  const [selectedID, setSelectedID] = React.useState('');
  const [panelTab, setPanelTab] = React.useState<PanelTab>('parameters');
  const [isPanelOpen, setIsPanelOpen] = React.useState(() => !window.matchMedia(NARROW_VIEWPORT_QUERY).matches);
  const { turns, lastRunID, isRunning, send, retry, edit, stop, recover, replaceTurns } = usePlaygroundRun(lang);
  const toast = useToast();
  // A refused send, replay or attachment is the outcome of that gesture, so it is a toast. One key:
  // a repeated refusal replaces the last one. Read through a ref because the attachment adapter is
  // built once and must still speak the current language.
  const refuseRef = React.useRef<(code: string) => void>(() => undefined);
  refuseRef.current = (code) => toast.error(t(playgroundErrorKey(code)), { key: 'playground-refusal' });
  const refuse = React.useCallback((code: string) => refuseRef.current(code), []);

  // The console's own key list entry, so a key created or renamed on the key page is current here.
  // Only a key with a usage fingerprint can be named to the server, so the rest are not offered.
  const keys = useQuery({
    queryKey: ['management-client-keys'],
    queryFn: () => api.getClientAPIKeys(),
    select: selectNameableKeys,
  });
  const models = useQuery({
    queryKey: ['playground-models', target.fingerprint],
    queryFn: ({ signal }) => api.getGatewayModels(target.fingerprint, signal),
    enabled: !!target.fingerprint,
    staleTime: 60_000,
  });

  // ── restoring the stored session ───────────────────────────────────────────
  //
  // Three reads arrive in any order - the session, the key list and the key's model directory - and
  // each stored choice is used only once it is known to still exist: a deleted key or a model the
  // gateway no longer serves is never selected (ADR 0023). Until all three have been reconciled
  // nothing is written back, so a slow read cannot persist an empty target over a stored one.
  const storedRef = React.useRef<PlaygroundSession>();
  const [hydration, setHydration] = React.useState({ session: false, key: false, model: false });

  React.useEffect(() => {
    if (!sessionPref.ready || hydration.session) return;
    const stored = sessionPref.value;
    storedRef.current = stored;
    setParameters(parametersFromSession(stored));
    // The endpoint needs no directory to be checked against, so it is restored with the session.
    if (stored.endpoint) setTarget(current => ({ ...current, endpoint: stored.endpoint ?? current.endpoint }));
    replaceTurns(stored.turns ?? [], stored.last_run_id ?? stored.turns?.at(-1)?.id ?? "");
    if (stored.turns?.length) {
      setSelectedID(stored.turns[stored.turns.length - 1].id);
    }
    setHydration(state => ({ ...state, session: true }));
  }, [sessionPref.ready, sessionPref.value, hydration.session, replaceTurns]);

  React.useEffect(() => {
    if (!hydration.session || hydration.key || !keys.isSuccess) return;
    const available = keys.data.map(key => key.usage_fingerprint as string);
    const stored = storedRef.current?.client_key_fingerprint;
    // The demonstration always has a target: a visitor is there to see an answer, not to configure one.
    const fingerprint = stored && available.includes(stored) ? stored : available.length === 1 || isDemo ? available[0] ?? '' : '';
    if (fingerprint) setTarget(current => (current.fingerprint ? current : { ...current, fingerprint, model: '' }));
    setHydration(state => ({ ...state, key: true, model: !fingerprint }));
  }, [hydration.session, hydration.key, keys.isSuccess, keys.data]);

  React.useEffect(() => {
    if (!hydration.key || hydration.model || !models.isSuccess || models.isFetching) return;
    const stored = storedRef.current?.model;
    if (stored && models.data.models.some(item => gatewayCallPointOf(item) === stored)) {
      setTarget(current => (current.model ? current : { ...current, model: stored }));
    }
    setHydration(state => ({ ...state, model: true }));
  }, [hydration.key, hydration.model, models.isSuccess, models.isFetching, models.data]);

  // A key that serves exactly one model has nothing to choose between.
  const onlyModel = models.data && (models.data.models.length === 1 || isDemo && models.data.models.length > 0) ? gatewayCallPointOf(models.data.models[0]) : '';
  React.useEffect(() => {
    if (!target.model && onlyModel) setTarget(current => ({ ...current, model: onlyModel }));
  }, [target.model, onlyModel]);

  const isHydrated = hydration.session && hydration.key && hydration.model;
  const [isRecoveryChecked, setIsRecoveryChecked] = React.useState(isDemo);
  const restoreRunTarget = React.useCallback((turn: Turn) => {
    const request = turn.request;
    const recovered = { ...request, custom_body: request.custom_body ? JSON.stringify(request.custom_body) : undefined };
    storedRef.current = recovered;
    setParameters(parametersFromSession(recovered));
    const hasKey = keys.data?.some(key => key.usage_fingerprint === request.client_key_fingerprint);
    setTarget(hasKey
      ? { fingerprint: request.client_key_fingerprint, model: request.model, endpoint: endpointOf(request) }
      : { ...NO_TARGET, endpoint: endpointOf(request) });
  }, [keys.data]);
  React.useEffect(() => {
    if (isDemo || !hydration.session || !keys.isSuccess) return;
    const controller = new AbortController();
    void recover(controller.signal, restoreRunTarget).finally(() => { if (!controller.signal.aborted) setIsRecoveryChecked(true); });
    return () => controller.abort();
  }, [isDemo, hydration.session, keys.isSuccess, recover, restoreRunTarget]);
  // A streaming turn changes every 40ms, so nothing is written while one runs. A turn that has just
  // settled and a newly chosen key or model are written at once - the reader may reload the moment
  // either happens, and a reload unmounts nothing, so a write still inside its pause would be
  // dropped - and an edit to the parameters waits for typing to pause. A write whose document
  // matches the last one is skipped.
  const { set: persistSession } = sessionPref;
  const lastWrittenRef = React.useRef('');
  const pendingRef = React.useRef<PlaygroundSession>();
  const wasRunningRef = React.useRef(false);
  const flushSession = React.useCallback(() => {
    const document = pendingRef.current;
    pendingRef.current = undefined;
    if (!document) return;
    const serialized = JSON.stringify(document);
    if (serialized === lastWrittenRef.current) return;
    lastWrittenRef.current = serialized;
    void persistSession(document);
  }, [persistSession]);
  const persistedTargetRef = React.useRef<PlaygroundTarget>();
  React.useEffect(() => {
    if (isDemo || !isHydrated || !isRecoveryChecked || isRunning) return;
    pendingRef.current = sessionDocument(target, parameters, turns, lastRunID);
    // The first pass sees the restored target, which the server already holds.
    const previousTarget = persistedTargetRef.current ?? target;
    persistedTargetRef.current = target;
    if (previousTarget.fingerprint !== target.fingerprint || previousTarget.model !== target.model || previousTarget.endpoint !== target.endpoint) {
      flushSession();
      return;
    }
    const timer = setTimeout(flushSession, wasRunningRef.current ? 0 : PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [isDemo, isHydrated, isRecoveryChecked, isRunning, flushSession, target, parameters, turns, lastRunID]);
  // Declared after the write above so that, in the commit where a run ends, the write still sees
  // that it was running.
  React.useEffect(() => {
    wasRunningRef.current = isRunning;
  }, [isRunning]);
  // Leaving the page while an edit is still inside its pause writes it rather than dropping it.
  // `pagehide` covers the departures that unmount nothing: a reload, a closed tab, a phone
  // switching apps.
  const flushRef = React.useRef(flushSession);
  flushRef.current = flushSession;
  React.useEffect(() => {
    const flush = () => flushRef.current();
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, []);

  // ── actions ────────────────────────────────────────────────────────────────

  const customBody = readCustomBody(parameters.customBody);
  const isTargetReady = !!target.fingerprint && !!target.model;

  const submit = (text: string, images: string[]) => {
    if (!isTargetReady || isRunning || !customBody.ok) return;
    if (!text.trim() && images.length === 0) return;
    // The demonstration has one recorded answer, for one message (ADR 0092).
    if (isDemo && (text.trim() !== t('pg.demo.example') || images.length > 0)) {
      refuse('demo_replay_only');
      return;
    }
    const content: Content[] = [
      ...(text.trim() ? [{ type: 'text' as const, text }] : []),
      ...images.map(url => ({ type: 'image_url' as const, image_url: { url } })),
    ];
    const user: Message = { role: 'user', content };
    const request = buildChatRequest(target, parameters, customBody.value, buildHistory(turns), user);
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_REQUEST_BYTES) {
      refuse('request_too_large');
      return;
    }
    const key = keys.data?.find(item => item.usage_fingerprint === target.fingerprint);
    const turn: Turn = {
      id: createID('turn'),
      request,
      keyLabel: key ? (key.alias ? `${key.alias} (${key.key})` : key.key) : '',
      user,
      reply: '',
      status: 'running',
      startedAt: Date.now(),
      events: [],
      eventBytes: 0,
      isTruncated: false,
    };
    setSelectedID(turn.id);
    send(turn);
  };

  // A turn whose image was dropped from storage cannot be asked again; the toast says why rather
  // than the replay failing at the gateway.
  const isReplayable = React.useCallback((turn: Turn) => {
    if (hasOmittedImage(turn)) {
      refuse('image_omitted');
      return false;
    }
    return true;
  }, []);

  const onInspect = React.useCallback((turn: Turn) => {
    setSelectedID(turn.id);
    setPanelTab('inspect');
    setIsPanelOpen(true);
  }, []);

  const onOpenRequests = React.useCallback((turn: Turn) => {
    const link = usageLink(turn);
    if (link) navigate(link);
  }, [navigate]);

  const runtimeRef = React.useRef<ReturnType<typeof usePlaygroundThreadRuntime>>();
  const attachmentAdapter = React.useMemo(() => new PlaygroundImageAdapter(
    () => runtimeRef.current?.thread.composer.getState().attachments.length ?? 0,
    () => refuse('invalid_image'),
  ), []);
  const runtime = usePlaygroundThreadRuntime({
    turns,
    isRunning,
    // Only sending waits for a target. A disabled message box takes no focus, and on a phone that
    // is a tap that raises no keyboard and shows no reason why.
    isDisabled: false,
    isSendDisabled: !isTargetReady || !isRecoveryChecked || !customBody.ok,
    attachments: attachmentAdapter,
    onSend: submit,
    onReload: () => {
      const last = turns.at(-1);
      if (last && !isRunning && isReplayable(last)) retry(last);
    },
    onEdit: text => {
      const last = turns.at(-1);
      if (last && !isRunning && isReplayable(last)) edit(last, text);
    },
    onCancel: stop,
  });
  runtimeRef.current = runtime;

  const resetConversation = () => {
    if (isRunning) return;
    replaceTurns([]);
    runtime.thread.composer.reset();
    setSelectedID('');
  };

  const exportConversation = (format: 'html' | 'image' | 'json') => {
    const now = new Date();
    if (format === 'json') {
      saveBlob(new Blob([`${JSON.stringify(sessionDocument(target, parameters, turns, lastRunID), null, 2)}\n`], { type: 'application/json' }), exportFileName('omc-playground', 'json', now));
      return;
    }
    void exportSnapshot(playgroundSnapshot(turns), format);
  };

  const onParametersChange = React.useCallback((patch: Partial<PlaygroundParameters>) => {
    setParameters(current => ({ ...current, ...patch }));
  }, []);
  const onParametersReset = React.useCallback(() => {
    setParameters(current => ({ ...DEFAULT_PLAYGROUND_PARAMETERS, reasoningEffort: current.reasoningEffort }));
  }, []);


  // ── transcript ─────────────────────────────────────────────────────────────

  const canRetry = !isRunning && !isDemo;
  const selectedTurn = turns.find(turn => turn.id === selectedID) ?? turns.at(-1);

  // ── frame ──────────────────────────────────────────────────────────────────

  const notices = (
    <>
      {keys.isError && <LoadFailure title={t(playgroundErrorKey(failureCode(keys.error)))} onRetry={() => void keys.refetch()} />}
      {keys.isSuccess && keys.data.length === 0 && (
        <Notice tone="info" title={t('pg.no_keys')} action={<Link to="/api-keys">{t('pg.manage_keys')}</Link>} />
      )}
      {models.isError && <LoadFailure title={t(playgroundErrorKey(failureCode(models.error)))} onRetry={() => void models.refetch()} />}
      {models.isSuccess && models.data.models.length === 0 && (
        <Notice tone="info" title={t('pg.no_models')} action={<Link to="/ai-providers">{t('pg.manage_models')}</Link>} />
      )}
    </>
  );

  const actions = (
    <>
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
      <Button aria-label={t('pg.new_chat')} icon={<MessageOutlined />} disabled={isRunning || !isRecoveryChecked || turns.length === 0} onClick={resetConversation}>
        <span className={styles['action-label']}>{t('pg.new_chat')}</span>
      </Button>
      <LabelTip title={t('pg.parameters')}>
        <Button
          aria-label={t('pg.parameters')}
          aria-pressed={isPanelOpen}
          type={isPanelOpen ? 'default' : 'text'}
          icon={<LayoutOutlined />}
          onClick={() => setIsPanelOpen(value => !value)}
        />
      </LabelTip>
    </>
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <WorkspaceLayout
        testId="playground-page"
        title={t('nav.playground')}
        actions={actions}
        notices={notices}
        aside={{
          title: t('pg.parameters'),
          tabs: [
            {
              key: 'parameters',
              label: t('pg.parameters'),
              content: (
                <ParametersPanel
                  parameters={parameters}
                  defaultUserAgent={defaultUserAgent}
                  onChange={onParametersChange}
                  onReset={onParametersReset}
                />
              ),
            },
            {
              key: 'inspect',
              label: t('pg.debug'),
              content: <InspectPanel turn={selectedTurn} defaultUserAgent={defaultUserAgent} onOpenRequests={onOpenRequests} />,
            },
          ],
          activeTab: panelTab,
          onTabChange: key => setPanelTab(key as PanelTab),
          isOpen: isPanelOpen,
          onOpenChange: setIsPanelOpen,
          resizeLabel: t('pg.resize_sidebar'),
          defaultWidth: 380,
        }}
      >
        <AssistantThread
          latestLabel={t('conversation.latest')}
          testId="playground-transcript"
          empty={(
            <div className={workspace['empty']} data-testid="playground-empty">
              <BrandArtwork shape="wordmark" height={28} className={workspace['empty-mark']} label="Oh My CPA" />
              {target.model && (
                <p className={styles['empty-target']}>
                  <ModelMark callPoint={target.model} />
                  <span>{target.model}</span>
                </p>
              )}
              {isDemo && (
                <ThreadPrimitive.Suggestion prompt={t('pg.demo.example')} send className={workspace['example']} data-testid="playground-demo-example">
                  <PlayCircleOutlined aria-hidden="true" />
                  <span>{t('pg.demo.example')}</span>
                </ThreadPrimitive.Suggestion>
              )}
            </div>
          )}
        >
          {() => <PlaygroundMessage canEdit={canRetry} canRetry={canRetry} isReplayable={isReplayable} onInspect={onInspect} onOpenRequests={onOpenRequests} />}
        </AssistantThread>
        <AssistantComposer
          placeholder={t('pg.input')}
          inputLabel={t('pg.input')}
          sendLabel={t('pg.send')}
          stopLabel={t('pg.stop')}
          blockedReason={!isTargetReady ? t('pg.target_required') : !customBody.ok ? t('pg.invalid_json') : undefined}
          attachments={{ addLabel: t('pg.add_image'), removeLabel: t('pg.remove_image') }}
          // What the next message is sent with sits where it is written, as on the Agent page:
          // the endpoint leads the foot, effort and the model close it beside send.
          footerStart={(
            <EndpointPicker
              value={target.endpoint}
              isDisabled={isRunning}
              onChange={endpoint => setTarget(current => ({ ...current, endpoint }))}
            />
          )}
          footerEnd={(
            <>
              <ReasoningEffortPicker
                value={parameters.reasoningEffort}
                isDisabled={isRunning}
                onChange={reasoningEffort => onParametersChange({ reasoningEffort })}
              />
              <TargetChip
                keys={keys.data ?? []}
                models={models.data?.models ?? []}
                fingerprint={target.fingerprint}
                model={target.model}
                isKeysLoading={keys.isFetching}
                isModelsLoading={models.isFetching}
                isDisabled={isRunning}
                isPending={!isHydrated && !keys.isError && !models.isError}
                onFingerprintChange={fingerprint => setTarget(current => ({ ...current, fingerprint, model: '' }))}
                onModelChange={model => setTarget(current => ({ ...current, model }))}
                onRefresh={() => {
                  void keys.refetch();
                  if (target.fingerprint) void models.refetch();
                }}
                emptyHint={keys.isSuccess && keys.data.length === 0
                  ? <>{t('pg.no_keys')} <Link to="/api-keys">{t('pg.manage_keys')}</Link></>
                  : !!target.fingerprint && models.isSuccess
                    ? <>{t('pg.no_models')} <Link to="/ai-providers">{t('pg.manage_models')}</Link></>
                    : undefined}
              />
            </>
          )}
        />
      </WorkspaceLayout>
    </AssistantRuntimeProvider>
  );
};
