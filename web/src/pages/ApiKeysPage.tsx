import type { MessageKey } from '../i18n/catalog';
import { useTimeZone } from '../utils/TimeZoneProvider';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Field } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PlusOutlined, SyncOutlined } from '../components/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from '../utils/time';
import { api, ApiError, apiErrorCode, describeError } from '../api/client';
import { QUERY_KEYS } from '../api/queryKeys';
import { useOptimisticClientKeyMutation } from '../hooks/useConfigMutations';
import { invalidateQueriesSilently } from '../utils/progressSources';
import { useT } from '../i18n';
import { isDemoMode } from '../types/demoMode';
import { ApiKeysList } from '../components/keys/ApiKeysList';
import { buildKeyRecords, summarizeKeys, type ApiKeyRecord, type KeyUseFilter } from '../components/keys/keyOverview';
import type { ClientAPIKeyItem, ClientKeyUsageItem } from '../types/providers';
import { PageHeader } from '../components/common/PageHeader';
import { useIsPhoneViewport } from '../hooks/useIsPhoneViewport';
import { SecretInput } from '../components/common/SecretInput';
import { SummaryStrip } from '../components/common/SummaryStrip';
import styles from './ApiKeysPage.module.css';
import { LoadFailure, Notice, useToast } from '../components/feedback';
import { SearchInput } from '../components/common/SearchInput';
import { Toolbar } from '../components/common/Toolbar';
import { StatTiles } from '../components/common/StatTiles';
import { StatusLabel, type StatusTone } from '../components/common/StatusLabel';
import { AppDrawer } from '../components/common/AppDrawer';
import { CopyButton } from '../components/common/CopyButton';
import { ToolButton } from '../components/common/ToolButton';
import { successRateTone } from '../types/usageEventMetrics';

/** The longest name the alias endpoint accepts. */
const MAX_ALIAS_LENGTH = 64;

/** A fresh gateway key: a recognisable prefix and 128 bits from the platform's CSPRNG. */
function generateGatewayKey(): string {
  const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sk-cpa-${randomHex}`;
}

interface EditorState {
  isOpen: boolean;
  /** The key's position when editing one; null while adding. */
  index: number | null;
  /** The value the dialog opened with, so a changed secret can be called out. */
  originalKey: string;
}

const CLOSED_EDITOR: EditorState = { isOpen: false, index: null, originalKey: '' };

const USE_TILES: readonly { key: KeyUseFilter; tone: StatusTone; labelKey: MessageKey; hintKey?: MessageKey }[] = [
  { key: 'all', tone: 'neutral', labelKey: 'keys.stat_all' },
  { key: 'active', tone: 'success', labelKey: 'keys.stat_active' },
  { key: 'idle', tone: 'neutral', labelKey: 'keys.stat_idle', hintKey: 'keys.stat_idle_hint' },
];

/**
 * ApiKeysPage owns the gateway client API keys as their own surface.
 *
 * The keys are part of CPA's configuration document (`api-keys`, or `access.api-keys` in a v8
 * layout), not a separate store, so every change is written as one revision-guarded transaction
 * on that document - the same one the configuration workbench uses. It is the only editor of that
 * field: the workbench points here instead of carrying a second one.
 *
 * A change applies when it is confirmed. Adding, editing and removing a key each end in their
 * own confirmation - the dialog's primary action, or the removal's popover - so there is no
 * second "save the list" step to find: a draft that looked applied but was not was the one way
 * this page could leave an operator believing a key worked when CPA had never heard of it.
 *
 * A key has no disabled state to edit — CPA authenticates by presence in the list, so removing
 * a key is the only way to stop it, and that is what the list offers.
 *
 * The page is laid out with the provider list's parts - the summary under the title, the tiles
 * that filter the list, the ruled toolbar, the table, and a side panel for the editor - so the
 * Gateway pages read as one console.
 */
export const ApiKeysPage: React.FC = () => {
  const timeZone = useTimeZone();
  const t = useT();
  // Gateway keys live in CPA's own configuration document, so adding, editing and
  // removing a key are refused by the demonstration.
  const isDemo = isDemoMode();
  const toast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isPhone = useIsPhoneViewport();

  const keysQuery = useQuery({
    // Its own cache entry, not the dashboard's: that one reads the masked list, and a
    // shared entry would let whichever page fetched first decide what the other sees.
    // A mask here would not merely display wrong - the alias join below is by key text,
    // so every name and every usage column would quietly empty out.
    queryKey: QUERY_KEYS.clientKeys('with-keys'),
    queryFn: () => api.getClientAPIKeys(true),
    staleTime: 30_000,
  });

  const usageQuery = useQuery({
    queryKey: QUERY_KEYS.clientKeyUsage,
    queryFn: () => api.getClientKeyUsage('preset=24h'),
    staleTime: 60_000,
  });

  const [searchQuery, setSearchQuery] = React.useState('');
  const [useFilter, setUseFilter] = React.useState<KeyUseFilter>('all');
  const [editor, setEditor] = React.useState<EditorState>(CLOSED_EDITOR);
  const [keyInput, setKeyInput] = React.useState('');
  const [aliasInput, setAliasInput] = React.useState('');
  const [isKeyVisible, setIsKeyVisible] = React.useState(false);
  const [isSavingEditor, setIsSavingEditor] = React.useState(false);

  const currentApiKeys: string[] = React.useMemo(
    () => (keysQuery.data?.keys ?? []).map((item) => item.key),
    [keysQuery.data],
  );

  const invalidateKeyReaders = React.useCallback(async () => {
    await Promise.all([
      invalidateQueriesSilently(queryClient, { queryKey: QUERY_KEYS.clientKeysPrefix }),
      invalidateQueriesSilently(queryClient, { queryKey: ['usage-events'] }),
      invalidateQueriesSilently(queryClient, { queryKey: ['usage-facets'] }),
      invalidateQueriesSilently(queryClient, { queryKey: ['usage-event'] }),
    ]);
  }, [queryClient]);

  const keyMutation = useOptimisticClientKeyMutation({
    formatError: (err) => {
      if (apiErrorCode(err) === 'resource_conflict') return t('keys.duplicate');
      return describeError(err);
    },
  });

  const closeEditor = React.useCallback(() => {
    setEditor(CLOSED_EDITOR);
    setKeyInput('');
    setAliasInput('');
    setIsKeyVisible(false);
  }, []);

  // A new key starts from a generated value, shown, because generating is what almost every
  // operator does next - and a value they typed themselves can still replace it.
  const openAddEditor = React.useCallback(() => {
    setEditor({ isOpen: true, index: null, originalKey: '' });
    setKeyInput(generateGatewayKey());
    setAliasInput('');
    setIsKeyVisible(true);
  }, []);

  const openKeyEditor = React.useCallback(
    (index: number) => {
      const key = currentApiKeys[index] ?? '';
      const stored = keysQuery.data?.keys?.find((item) => item.key === key);
      setEditor({ isOpen: true, index, originalKey: key });
      setKeyInput(key);
      setAliasInput(stored?.alias ?? '');
      setIsKeyVisible(false);
    },
    [currentApiKeys, keysQuery.data],
  );

  /**
   * Writes a key's name through the alias endpoint.
   *
   * The name is this console's own metadata and never touches CPA's document, so a name-only
   * edit writes nothing there. Returns false when the write failed, which leaves the editor open
   * rather than closing over a change that was not saved.
   */
  const saveKeyAlias = React.useCallback(
    async (key: string, alias: string): Promise<boolean> => {
      const stored = keysQuery.data?.keys?.find((item) => item.key === key);
      if (!stored?.usage_fingerprint) {
        toast.error(t('keys.alias_save_failed'));
        return false;
      }
      try {
        // Optimistically update the alias in cache on the click frame.
        queryClient.setQueryData<{ keys: ClientAPIKeyItem[]; total: number }>(
          QUERY_KEYS.clientKeys('with-keys'),
          (current) =>
            current
              ? {
                  ...current,
                  keys: current.keys.map((item) =>
                    item.key === key ? { ...item, alias: alias || undefined } : item,
                  ),
                }
              : current,
        );
        await api.setClientKeyAlias(stored.usage_fingerprint, alias, stored.alias_version ?? 0);
        toast.success(alias ? t('keys.renamed') : t('keys.rename_cleared'));
        await invalidateKeyReaders();
        return true;
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 409 || (error.data as Record<string, unknown>)?.code === 'alias_version_conflict')
        ) {
          toast.warning(t('keys.rename_conflict'));
          await invalidateQueriesSilently(queryClient, { queryKey: QUERY_KEYS.clientKeysPrefix });
          return false;
        }
        await invalidateQueriesSilently(queryClient, { queryKey: QUERY_KEYS.clientKeysPrefix });
        toast.error(describeError(error) || t('keys.rename_control'));
        return false;
      }
    },
    [keysQuery.data, toast, queryClient, t, invalidateKeyReaders],
  );

  const handleSaveKey = async () => {
    const trimmedKey = keyInput.trim();
    const trimmedAlias = aliasInput.trim();
    if (!trimmedKey) {
      toast.warning(t('cfg.api_key_empty_warning'));
      return;
    }
    if (trimmedAlias.length > MAX_ALIAS_LENGTH) {
      toast.error(t('keys.rename_too_long', { n: MAX_ALIAS_LENGTH }));
      return;
    }
    if (currentApiKeys.some((key, index) => key === trimmedKey && index !== editor.index)) {
      toast.error(t('keys.duplicate'));
      return;
    }

    setIsSavingEditor(true);
    try {
      if (editor.index !== null && editor.originalKey === trimmedKey) {
        // The name is the only thing that can have changed. Nothing about the key's value
        // moves, so CPA's configuration document is not touched at all.
        const stored = keysQuery.data?.keys?.find((item) => item.key === trimmedKey);
        if (trimmedAlias !== (stored?.alias ?? '')) {
          if (!(await saveKeyAlias(trimmedKey, trimmedAlias))) return;
        }
        closeEditor();
        return;
      }

      let res: { index: number; usage_fingerprint?: string };
      try {
        if (editor.index !== null) {
          const originalMeta = keysQuery.data?.keys?.find((item) => item.key === editor.originalKey);
          res = await keyMutation.mutateAsync({
            kind: 'update',
            index: editor.index,
            key: trimmedKey,
            alias: trimmedAlias,
            expectedFingerprint: originalMeta?.fingerprint || undefined,
          });
        } else {
          res = await keyMutation.mutateAsync({
            kind: 'create',
            key: trimmedKey,
            alias: trimmedAlias,
          });
        }
      } catch {
        return;
      }

      if (editor.index === null ? Boolean(trimmedAlias) : true) {
        const existingAlias = keysQuery.data?.keys?.find(
          (item) =>
            (item.usage_fingerprint && item.usage_fingerprint === res.usage_fingerprint) ||
            (editor.originalKey && item.key === editor.originalKey),
        );
        const fingerprint = res.usage_fingerprint;
        const shouldSaveAlias =
          Boolean(trimmedAlias) || Boolean(existingAlias?.alias);
        if (shouldSaveAlias) {
          if (!fingerprint) {
            toast.error(t('keys.alias_save_failed'));
            setEditor({ isOpen: true, index: res.index, originalKey: trimmedKey });
            return;
          }
          try {
            const targetAliasVersion =
              res.usage_fingerprint === existingAlias?.usage_fingerprint
                ? (existingAlias?.alias_version ?? 0)
                : 0;
            await api.setClientKeyAlias(fingerprint, trimmedAlias, targetAliasVersion);
            await invalidateKeyReaders();
          } catch (err: unknown) {
            toast.error(describeError(err) || t('keys.alias_save_failed'));
            setEditor({ isOpen: true, index: res.index, originalKey: trimmedKey });
            return;
          }
        }
      }
      toast.success(editor.index === null ? t('keys.created') : t('keys.saved'));
      closeEditor();
    } finally {
      setIsSavingEditor(false);
    }
  };

  const handleDeleteRecord = React.useCallback(
    async (record: ApiKeyRecord) => {
      try {
        await keyMutation.mutateAsync({
          kind: 'delete',
          index: record.index,
          expectedFingerprint: record.fingerprint,
        });
        toast.success(t('keys.deleted'));
      } catch {
        // Error toast and cache rollback are handled by useOptimisticClientKeyMutation.
      }
    },
    [keyMutation, toast, t],
  );

  const viewRequestsFor = React.useCallback(
    (record: ApiKeyRecord) => {
      if (!record.usageFingerprint) return;
      const search = new URLSearchParams();
      search.set('preset', '24h');
      search.append('api_key', record.usageFingerprint);
      navigate(`/usage/events?${search.toString()}`);
    },
    [navigate],
  );

  const usageByFingerprint = React.useMemo(() => {
    const indexed: Record<string, ClientKeyUsageItem> = {};
    for (const entry of usageQuery.data?.usage ?? []) indexed[entry.key_fingerprint] = entry;
    return indexed;
  }, [usageQuery.data]);

  const formatUsageTime = React.useCallback((ms: number) => dayjs(ms).format('YYYY-MM-DD HH:mm:ss'), [timeZone]);

  const keyCount = currentApiKeys.length;
  const records = React.useMemo(
    () => buildKeyRecords(currentApiKeys, keysQuery.data?.keys, usageByFingerprint),
    [currentApiKeys, keysQuery.data, usageByFingerprint],
  );
  // Traffic is joined by fingerprint, which the key read carries; until both are in, a use tile
  // would count every key as idle.
  const isUsageKnown = Boolean(usageQuery.data && keysQuery.data);
  const overview = summarizeKeys(records, useFilter, searchQuery, isUsageKnown);
  const isFiltered = useFilter !== 'all' || searchQuery.trim() !== '';
  const isBlocked = keysQuery.isError && !keysQuery.data;
  const isEditing = editor.index !== null;
  const isValueChanged = isEditing && keyInput.trim() !== '' && keyInput.trim() !== editor.originalKey;
  const canWrite = !isDemo && Boolean(keysQuery.data);

  const summary = keyCount > 0 ? (
    <SummaryStrip>
      <SummaryStrip.Total testId="keys-count">{t('cfg.api_keys_count', { n: keyCount })}</SummaryStrip.Total>
      {overview.counts && (
        <>
          <SummaryStrip.Divider />
          <SummaryStrip.Item tone="healthy">{t('keys.summary_active', { n: overview.counts.active })}</SummaryStrip.Item>
        </>
      )}
      {keyMutation.isPending && (
        <span className={styles['saving']} role="status">
          <SyncOutlined spin /> {t('keys.applying')}
        </span>
      )}
    </SummaryStrip>
  ) : undefined;

  const addButton = (
    <Button
      variant="primary"
      icon={<PlusOutlined />}
      disabled={!canWrite}
      data-tip={isDemo ? t('demo.blocked') : undefined}
      onClick={openAddEditor}
    >
      {t('cfg.api_keys_add')}
    </Button>
  );

  return (
    <div className="terminal-page terminal-page-stack keys-page">
      <PageHeader
        title={t('keys.title')}
        mobileActions={(
          <>
            {addButton}
          </>
        )}
        actions={(
          <>
            {addButton}
          </>
        )}
      >
        {/* On a phone the use tiles below state the same counts, one line further down. */}
        {!isPhone && summary}
      </PageHeader>

      {isBlocked && (
        <LoadFailure
          title={t('cfg.load_failed')}
          detail={t('cfg.load_failed_desc')}
          onRetry={() => void keysQuery.refetch()}
        />
      )}

      <section className={styles['overview']}>
        <StatTiles
          ariaLabel={t('keys.use_filter')}
          testId="key-stats"
          tileTestIdPrefix="key-stat"
          selected={useFilter}
          onSelect={setUseFilter}
          tiles={USE_TILES.map((tile) => ({
            key: tile.key,
            label: t(tile.labelKey),
            count: tile.key === 'all' && !overview.counts
              ? (keysQuery.data ? overview.visible.length : undefined)
              : overview.counts?.[tile.key],
            tone: tile.tone,
            hint: tile.hintKey ? t(tile.hintKey) : undefined,
          }))}
        />

        <Toolbar variant="ruled" className="logs-toolbar">
          <SearchInput
            className={styles['search']}
            label={t('keys.search_placeholder')}
            value={searchQuery}
            onChange={setSearchQuery}
          />
          {isFiltered && (
            <Button variant="link" size="sm" onClick={() => { setSearchQuery(''); setUseFilter('all'); }}>
              {t('pro.clear_filters')}
            </Button>
          )}
          {/* The window's totals over every key, whatever the filters show: the line answers "how
              busy is the gateway's front door", not "how busy is this view". */}
          <div className={styles['window-summary']} data-testid="key-window-summary">
            <span className={styles['window-label']}>{t('pro.window_24h')}</span>
            {overview.window ? (
              <>
                <span>{t('pro.traffic_requests', { n: overview.window.requests.toLocaleString() })}</span>
                {overview.window.successRate !== null && (
                  <StatusLabel tone={successRateTone(overview.window.successRate)}>
                    {t('pro.window_success_rate', { rate: overview.window.successRate.toFixed(1) })}
                  </StatusLabel>
                )}
              </>
            ) : (
              <span>{usageQuery.isPending ? '…' : t('pro.traffic_unknown')}</span>
            )}
          </div>
        </Toolbar>
      </section>

      <ApiKeysList
        records={overview.visible}
        isLoading={keysQuery.isPending}
        isBlocked={isBlocked}
        isUsageKnown={isUsageKnown}
        emptyText={keyCount > 0 ? t('keys.search_empty') : t('keys.empty_title')}
        formatTime={formatUsageTime}
        isBusy={false}
        isReadOnly={isDemo}
        onEdit={openKeyEditor}
        onDelete={(record) => void handleDeleteRecord(record)}
        onViewRequests={viewRequestsFor}
      />

      {/* One editor for both of a key's editable parts: the secret CPA authenticates it with,
          and the name this console shows it by. It is a side panel, as the provider editor is. */}
      <AppDrawer
        widthKey="api_key_editor"
        title={isEditing ? t('keys.modal_title_edit') : t('keys.modal_title_add')}
        open={editor.isOpen}
        onClose={closeEditor}
        width="narrow"
        destroyOnHidden
        footer={(
          <>
            <Button onClick={closeEditor}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={isSavingEditor}
              disabled={!keyInput.trim()}
              onClick={() => void handleSaveKey()}
            >
              {isEditing ? t('common.save') : t('keys.create')}
            </Button>
          </>
        )}
      >
        {/* The provider editor's form: the name a reader knows the key by, then the secret, with
            the two actions that produce and take it beside the field. */}
        <div>
          <Field label={t('keys.col_name')} htmlFor="gateway-key-alias">
            <Input
              id="gateway-key-alias"
              placeholder={t('keys.modal_alias_placeholder')}
              value={aliasInput}
              onChange={(e) => setAliasInput(e.target.value)}
              onPressEnter={() => void handleSaveKey()}
              maxLength={MAX_ALIAS_LENGTH}
              showCount
              autoFocus
            />
          </Field>
          <Field label={t('keys.modal_label')} htmlFor="gateway-key-value" required>
            <div className={styles['secret-field']}>
              <SecretInput
                id="gateway-key-value"
                placeholder={t('cfg.api_keys_placeholder')}
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onPressEnter={() => void handleSaveKey()}
                isVisible={isKeyVisible}
                onVisibleChange={setIsKeyVisible}
                className="config-mono-input"
              />
              <ToolButton
                variant="ghost"
                icon={<SyncOutlined />}
                label={t('cfg.api_keys_generate')}
                onClick={() => {
                  setKeyInput(generateGatewayKey());
                  setIsKeyVisible(true);
                }}
              />
              <CopyButton size="middle" text={keyInput.trim()} label={t('cfg.api_keys_copy')} disabled={!keyInput.trim()} />
            </div>
          </Field>
          {isValueChanged && (
            <Notice tone="warning" title={t('keys.value_change_warning')} />
          )}
        </div>
      </AppDrawer>
    </div>
  );
};
