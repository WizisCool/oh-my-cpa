import React from 'react';
import { Alert, Button, Tabs, Tooltip } from 'antd';
import { XProvider } from '@ant-design/x';
import type { BubbleItemType, BubbleListProps } from '@ant-design/x';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { BrandArtwork } from '../../components/common/BrandArtwork';
import { CloseOutlined, LayoutOutlined, MessageOutlined, ReloadOutlined } from '../../components/icons';
import { Composer } from '../../components/workspace/Composer';
import { ConversationList } from '../../components/workspace/ConversationList';
import type { ConversationListHandle } from '../../components/workspace/ConversationList';
import { TargetPicker } from '../../components/workspace/TargetPicker';
import { WorkspaceLayout } from '../../components/workspace/WorkspaceLayout';
import { useXLocale } from '../../components/workspace/useXLocale';
import workspace from '../../components/workspace/Workspace.module.css';
import { usePreference } from '../../hooks/usePreference';
import { NARROW_VIEWPORT_QUERY } from '../../hooks/useIsNarrowViewport';
import { useI18n } from '../../i18n';
import { getAppConfig } from '../../types/config';
import { isDemoMode } from '../../types/demoMode';
import { gatewayCallPointOf } from '../../types/gatewayModels';
import { failureCode } from './api';
import { playgroundErrorKey } from './errors';
import { InspectPanel } from './InspectPanel';
import { ParametersPanel } from './ParametersPanel';
import { AssistantMessage, UserMessage } from './PlaygroundTurn';
import {
  buildChatRequest, buildHistory, createID, DEFAULT_PLAYGROUND_PARAMETERS, DEFAULT_PLAYGROUND_SESSION,
  hasOmittedImage, MAX_REQUEST_BYTES, parametersFromSession, parsePlaygroundSession, playgroundUserAgent,
  PLAYGROUND_SESSION_PREFERENCE, readCustomBody, sessionDocument, usageLink,
} from './state';
import type { Content, Message, PlaygroundParameters, PlaygroundSession, Turn } from './state';
import { useImageAttachments } from './useImageAttachments';
import { usePlaygroundRun } from './usePlaygroundRun';
import styles from './PlaygroundPage.module.css';

/**
 * How long the stored session waits for edits to settle before it is written.
 *
 * The document carries the whole bounded conversation, so writing it on every keystroke in the
 * system prompt would send the transcript to the server once per character.
 */
const PERSIST_DEBOUNCE_MS = 600;

const BUBBLE_ROLES: BubbleListProps['role'] = {
  user: { placement: 'end', variant: 'borderless' },
  ai: { placement: 'start', variant: 'borderless' },
};

type PanelTab = 'parameters' | 'inspect';

/** Module-level so the selection is not re-run on every render of the page. */
function selectNameableKeys(response: Awaited<ReturnType<typeof api.getClientAPIKeys>>) {
  return response.keys.filter(key => Boolean(key.usage_fingerprint));
}

interface Target {
  fingerprint: string;
  model: string;
}

export const PlaygroundPage: React.FC = () => {
  const { t } = useI18n();
  const navigate = useNavigate();
  const xLocale = useXLocale();
  const isDemo = isDemoMode();
  // The deployment's own build names the default User-Agent in the placeholder and the copied
  // cURL; the server resolves the value that actually leaves the process.
  const defaultUserAgent = playgroundUserAgent(getAppConfig().version);

  const sessionPref = usePreference<PlaygroundSession>(PLAYGROUND_SESSION_PREFERENCE, DEFAULT_PLAYGROUND_SESSION, parsePlaygroundSession);
  const [target, setTarget] = React.useState<Target>({ fingerprint: '', model: '' });
  const [parameters, setParameters] = React.useState<PlaygroundParameters>(DEFAULT_PLAYGROUND_PARAMETERS);
  const [draft, setDraft] = React.useState('');
  const [selectedID, setSelectedID] = React.useState('');
  const [panelTab, setPanelTab] = React.useState<PanelTab>('parameters');
  const [isPanelOpen, setIsPanelOpen] = React.useState(() => !window.matchMedia(NARROW_VIEWPORT_QUERY).matches);
  const [notice, setNotice] = React.useState('');
  const { turns, isRunning, send, retry, stop, replaceTurns } = usePlaygroundRun();
  const attachments = useImageAttachments(React.useCallback(() => setNotice('invalid_image'), []));
  const listRef = React.useRef<ConversationListHandle>(null);

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
    if (stored.turns?.length) {
      replaceTurns(stored.turns);
      setSelectedID(stored.turns[stored.turns.length - 1].id);
    }
    setHydration(state => ({ ...state, session: true }));
  }, [sessionPref.ready, sessionPref.value, hydration.session, replaceTurns]);

  React.useEffect(() => {
    if (!hydration.session || hydration.key || !keys.isSuccess) return;
    const available = keys.data.map(key => key.usage_fingerprint as string);
    const stored = storedRef.current?.client_key_fingerprint;
    const fingerprint = stored && available.includes(stored) ? stored : available.length === 1 ? available[0] : '';
    if (fingerprint) setTarget(current => (current.fingerprint ? current : { fingerprint, model: '' }));
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
  const onlyModel = models.data?.models.length === 1 ? gatewayCallPointOf(models.data.models[0]) : '';
  React.useEffect(() => {
    if (!target.model && onlyModel) setTarget(current => ({ ...current, model: onlyModel }));
  }, [target.model, onlyModel]);

  const isHydrated = hydration.session && hydration.key && hydration.model;
  // A streaming turn changes every 40ms, so nothing is written while one runs. A turn that has just
  // settled is written at once - the reader may reload the moment it ends - and an edit to the
  // parameters waits for typing to pause. A write whose document matches the last one is skipped.
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
  React.useEffect(() => {
    if (isDemo || !isHydrated || isRunning) return;
    pendingRef.current = sessionDocument(target, parameters, turns);
    const timer = setTimeout(flushSession, wasRunningRef.current ? 0 : PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [isDemo, isHydrated, isRunning, flushSession, target, parameters, turns]);
  // Declared after the write above so that, in the commit where a run ends, the write still sees
  // that it was running.
  React.useEffect(() => {
    wasRunningRef.current = isRunning;
  }, [isRunning]);
  // Leaving the page while an edit is still inside its pause writes it rather than dropping it.
  const flushRef = React.useRef(flushSession);
  flushRef.current = flushSession;
  React.useEffect(() => () => flushRef.current(), []);

  // ── actions ────────────────────────────────────────────────────────────────

  const customBody = readCustomBody(parameters.customBody);
  const canSend = !!target.fingerprint && !!target.model && !isRunning && !isDemo
    && attachments.pendingCount === 0 && customBody.ok && (!!draft.trim() || attachments.images.length > 0);

  const submit = (text: string) => {
    if (!canSend || !customBody.ok) return;
    const content: Content[] = [
      ...(text.trim() ? [{ type: 'text' as const, text }] : []),
      ...attachments.images.map(image => ({ type: 'image_url' as const, image_url: { url: image.url } })),
    ];
    const user: Message = { role: 'user', content };
    const request = buildChatRequest(target, parameters, customBody.value, buildHistory(turns), user);
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_REQUEST_BYTES) {
      setNotice('request_too_large');
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
    setDraft('');
    attachments.take();
    setNotice('');
    setSelectedID(turn.id);
    listRef.current?.followLatest();
    send(turn);
  };

  const onRetry = React.useCallback((turn: Turn) => {
    if (hasOmittedImage(turn)) {
      setNotice('image_omitted');
      return;
    }
    setNotice('');
    listRef.current?.followLatest();
    retry(turn);
  }, [retry]);

  const onInspect = React.useCallback((turn: Turn) => {
    setSelectedID(turn.id);
    setPanelTab('inspect');
    setIsPanelOpen(true);
  }, []);

  const onOpenRequests = React.useCallback((turn: Turn) => {
    const link = usageLink(turn);
    if (link) navigate(link);
  }, [navigate]);

  const resetConversation = () => {
    if (isRunning) return;
    replaceTurns([]);
    attachments.clear();
    setDraft('');
    setSelectedID('');
    setNotice('');
  };

  const onParametersChange = React.useCallback((patch: Partial<PlaygroundParameters>) => {
    setParameters(current => ({ ...current, ...patch }));
  }, []);
  const onParametersReset = React.useCallback(() => setParameters(DEFAULT_PLAYGROUND_PARAMETERS), []);

  // ── transcript ─────────────────────────────────────────────────────────────

  const lastID = turns.at(-1)?.id;
  const canRetry = !isRunning && !isDemo;
  const items = React.useMemo<BubbleItemType[]>(() => turns.flatMap(turn => [
    { key: `${turn.id}-user`, role: 'user', content: <UserMessage turn={turn} /> },
    {
      key: `${turn.id}-ai`,
      role: 'ai',
      content: (
        <AssistantMessage
          turn={turn}
          isLast={turn.id === lastID}
          canRetry={canRetry}
          onRetry={onRetry}
          onInspect={onInspect}
          onOpenRequests={onOpenRequests}
        />
      ),
    },
  ]), [turns, lastID, canRetry, onRetry, onInspect, onOpenRequests]);

  const selectedTurn = turns.find(turn => turn.id === selectedID) ?? turns.at(-1);

  // ── frame ──────────────────────────────────────────────────────────────────

  const notices = (
    <>
      {isDemo && <Alert type="info" title={t('pg.demo')} />}
      {keys.isError && <Alert type="error" title={t(playgroundErrorKey(failureCode(keys.error)))} />}
      {keys.isSuccess && keys.data.length === 0 && (
        <Alert type="info" title={t('pg.no_keys')} action={<Link to="/api-keys">{t('pg.manage_keys')}</Link>} />
      )}
      {models.isError && <Alert type="error" title={t(playgroundErrorKey(failureCode(models.error)))} />}
      {models.isSuccess && models.data.models.length === 0 && (
        <Alert type="info" title={t('pg.no_models')} action={<Link to="/ai-providers">{t('pg.manage_models')}</Link>} />
      )}
      {notice && <Alert type="error" title={t(playgroundErrorKey(notice))} closable={{ onClose: () => setNotice('') }} />}
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
            if (target.fingerprint) void models.refetch();
          }}
        />
      </Tooltip>
      <Button aria-label={t('pg.new_chat')} icon={<MessageOutlined />} disabled={isRunning || turns.length === 0} onClick={resetConversation}>
        <span className={styles['action-label']}>{t('pg.new_chat')}</span>
      </Button>
      <Tooltip title={t('pg.parameters')}>
        <Button
          aria-label={t('pg.parameters')}
          aria-pressed={isPanelOpen}
          type={isPanelOpen ? 'default' : 'text'}
          icon={<LayoutOutlined />}
          onClick={() => setIsPanelOpen(value => !value)}
        />
      </Tooltip>
    </>
  );

  const panel = (
    <Tabs
      className={workspace['panel-tabs']}
      activeKey={panelTab}
      onChange={key => setPanelTab(key as PanelTab)}
      items={[
        {
          key: 'parameters',
          label: t('pg.parameters'),
          children: (
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
          children: <InspectPanel turn={selectedTurn} defaultUserAgent={defaultUserAgent} onOpenRequests={onOpenRequests} />,
        },
      ]}
    />
  );

  const composerHeader = attachments.images.length > 0 ? (
    <div className={styles['attachments']}>
      {attachments.images.map(image => (
        <div className={styles['attachment']} key={image.uid}>
          <img src={image.url} alt={image.name} />
          <Button
            type="text"
            size="small"
            className={styles['attachment-remove']}
            aria-label={t('pg.remove_image')}
            onClick={() => attachments.remove(image.uid)}
            icon={<CloseOutlined />}
          />
        </div>
      ))}
    </div>
  ) : null;

  return (
    <XProvider locale={xLocale}>
      <WorkspaceLayout
        testId="playground-page"
        title={t('nav.playground')}
        target={(
          <TargetPicker
            keys={keys.data ?? []}
            models={models.data?.models ?? []}
            fingerprint={target.fingerprint}
            model={target.model}
            isKeysLoading={keys.isFetching}
            isModelsLoading={models.isFetching}
            isDisabled={isRunning}
            onFingerprintChange={fingerprint => setTarget({ fingerprint, model: '' })}
            onModelChange={model => setTarget(current => ({ ...current, model }))}
          />
        )}
        actions={actions}
        notices={notices}
        aside={{
          title: t('pg.parameters'),
          content: panel,
          isOpen: isPanelOpen,
          onOpenChange: setIsPanelOpen,
          resizeLabel: t('pg.resize_sidebar'),
          defaultWidth: 380,
        }}
      >
        {turns.length === 0 ? (
          <div className={workspace['empty']} data-testid="playground-empty">
            <BrandArtwork shape="wordmark" height={28} className={workspace['empty-mark']} label="Oh My CPA" />
            {target.model && <p className={styles['empty-target']}>{target.model}</p>}
          </div>
        ) : (
          <ConversationList ref={listRef} items={items} roles={BUBBLE_ROLES} latestLabel={t('pg.latest')} />
        )}
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          onStop={stop}
          placeholder={t('pg.input')}
          inputLabel={t('pg.input')}
          sendLabel={t('pg.send')}
          stopLabel={t('pg.stop')}
          isRunning={isRunning}
          canSend={canSend}
          isDisabled={isDemo || !target.fingerprint || !target.model}
          blockedReason={!customBody.ok ? t('pg.invalid_json') : undefined}
          header={composerHeader}
          onPasteFile={files => {
            if (!isRunning && !isDemo) attachments.add(files);
          }}
        />
      </WorkspaceLayout>
    </XProvider>
  );
};
