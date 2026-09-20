import React, { useState, useRef } from 'react';

import { App as AntdApp } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, ApiError, apiErrorCode, isRetryableWriteFailure } from '../../api/client';
import { useT } from '../../i18n';
import { useLastIntentQueue, LastIntentTimeoutError } from '../../hooks/useLastIntentQueue';
import { getProviderDefaultIcon } from '../LobeIcon';
import { resolveProviderIcon } from '../../types/providerIcons';
import { isSafeExternalURL } from '../../utils/externalUrl';
import { providerStatusPayload } from '../../types/providerId';
import type {
  ProviderItem,
  SaveProviderPayload,
  SaveProviderKeyItem,
  SaveProviderModelItem,
} from '../../types/providers';
import type {
  FormKeyItem,
  FormHeaderItem,
  FormModelItem,
  ManagementProvidersData,
} from './managementProviders';

/**
 * The provider editor: the form the drawer edits, the drawer's actions, and the
 * three writes that form produces.
 *
 * They are one hook because they are one mechanism. A save has to close the
 * drawer it was issued from, a create has to name the row it added before its
 * icon override can be keyed to it, and an edit has to repopulate every section
 * from the record it was opened on - so splitting them by "state" and "mutation"
 * would only move the same couplings across two files.
 */
export function useProviderManagement({
  message,
  t,
  providerIcons,
  writeProviderIcon,
  shiftCachedProviderIcons,
  settleProviderRow,
}: {
  message: ReturnType<typeof AntdApp.useApp>['message'];
  t: ReturnType<typeof useT>;
  providerIcons: Record<string, string>;
  writeProviderIcon: (id: string, icon: string) => void;
  shiftCachedProviderIcons: (id: string) => void;
  settleProviderRow: (id: string, isEnabled: boolean) => void;
}) {
  const queryClient = useQueryClient();

  // Provider Drawer state
  const [providerDrawerOpen, setProviderDrawerOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderItem | null>(null);
  const [formFamily, setFormFamily] = useState<string>('openai-compatibility');
  const [formName, setFormName] = useState<string>('');
  const [formBaseURL, setFormBaseURL] = useState<string>('');
  /**
   * The provider homepage, which is console metadata rather than a CPA field.
   * Empty means "no website", which the save path sends as an explicit empty
   * string so clearing one is a real instruction and not an omission.
   */
  const [formWebsite, setFormWebsite] = useState<string>('');
  const [formPrefix, setFormPrefix] = useState<string>('');
  const [formPriority, setFormPriority] = useState<number | null>(null);
  const [formDisabled, setFormDisabled] = useState<boolean>(false);
  const [formDisableCooling, setFormDisableCooling] = useState<boolean>(false);
  const [formKeys, setFormKeys] = useState<FormKeyItem[]>([]);
  const [formHeaders, setFormHeaders] = useState<FormHeaderItem[]>([]);
  const [formModels, setFormModels] = useState<FormModelItem[]>([]);
  const [keysSectionOpen, setKeysSectionOpen] = useState<boolean>(true);
  const [expandedKeyIds, setExpandedKeyIds] = useState<Set<string>>(new Set());
  const [headersSectionOpen, setHeadersSectionOpen] = useState<boolean>(false);
  const [modelsSectionOpen, setModelsSectionOpen] = useState<boolean>(false);
  const [formTestModel, setFormTestModel] = useState<string>('auto');

  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [targetProviderForIcon, setTargetProviderForIcon] = useState<ProviderItem | null>(null);
  const [formIcon, setFormIcon] = useState<string>('OpenAI');
  const [iconManuallySelected, setIconManuallySelected] = useState<boolean>(false);

  // Endpoint models pull state & custom models expand state
  const modelFetchSeqRef = useRef<number>(0);
  const [isPullingModels, setIsPullingModels] = useState(false);
  const [endpointModels, setEndpointModels] = useState<string[]>([]);
  const [expandedModelIds, setExpandedModelIds] = useState<Set<string>>(new Set());

  const handlePullModels = async () => {
    const rawUrl = formBaseURL.trim();
    if (!rawUrl) {
      message.warning(t('pro.pull_requires_base_url'));
      return;
    }

    const firstKey = formKeys.find((k) => k.apiKey && k.apiKey.trim() !== '')?.apiKey || '';
    const firstProxy = formKeys.find((k) => k.proxyUrl && k.proxyUrl.trim() !== '')?.proxyUrl || '';

    const headersPayload: Record<string, string> = {};
    for (const h of formHeaders) {
      if (h.key.trim() !== '') {
        headersPayload[h.key.trim()] = h.value.trim();
      }
    }

    const seq = ++modelFetchSeqRef.current;
    setIsPullingModels(true);
    setEndpointModels([]);
    try {
      const res = await api.pullProviderModels({
        provider_id: editingProvider ? editingProvider.id : undefined,
        family: formFamily,
        base_url: rawUrl,
        api_key: firstKey,
        proxy_url: firstProxy,
        headers: headersPayload,
      });

      if (seq !== modelFetchSeqRef.current) return;

      const rawModels = res.models || [];
      const models = Array.from(
        new Set(
          rawModels
            .filter((name): name is string => typeof name === 'string')
            .map((name) => name.trim())
            .filter(Boolean)
        )
      ).sort((a, b) => a.localeCompare(b));
      setEndpointModels(models);
      if (models.length > 0) {
        message.success(t('pro.pull_models_success', { count: models.length }));
      } else {
        message.info(t('pro.model_list_empty'));
      }
    } catch (err) {
      if (seq !== modelFetchSeqRef.current) return;
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    } finally {
      if (seq === modelFetchSeqRef.current) {
        setIsPullingModels(false);
      }
    }
  };

  const toggleModelExpanded = (id: string) => {
    setExpandedModelIds((prev) => {
      const next = new Set(prev);
      const willExpand = !next.has(id);
      if (willExpand) {
        next.add(id);
        setTimeout(() => {
          const el = document.getElementById(`model-card-${id}`);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }, 80);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  const handleAddModel = () => {
    const newId = `mdl-${Date.now()}-${formModels.length}`;
    setFormModels((prev) => [
      ...prev,
      {
        id: newId,
        name: '',
        alias: '',
        image: false,
        thinking: { levels: [] },
      },
    ]);
    setExpandedModelIds((prev) => new Set([...prev, newId]));
    setTimeout(() => {
      const el = document.getElementById(`model-card-${newId}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }
    }, 80);
  };

  const updateModelImage = (id: string, image: boolean) => {
    setFormModels((prev) =>
      prev.map((item) => (item.id === id ? { ...item, image } : item))
    );
  };

  const toggleThinkingLevel = (modelId: string, level: string) => {
    setFormModels((prev) =>
      prev.map((item) => {
        if (item.id !== modelId) return item;
        const currentLevels = item.thinking?.levels || [];
        const nextLevels = currentLevels.includes(level)
          ? currentLevels.filter((l) => l !== level)
          : [...currentLevels, level];
        return {
          ...item,
          thinking: { levels: nextLevels },
        };
      })
    );
  };

  const handleSelectIcon = (selectedIconId: string) => {
    if (targetProviderForIcon) {
      writeProviderIcon(targetProviderForIcon.id, selectedIconId);
      message.success(t('pro.icon_updated'));
      setTargetProviderForIcon(null);
    } else {
      setFormIcon(selectedIconId);
      setIconManuallySelected(true);
    }
  };

  const toggleKeyExpanded = (id: string) => {
    setExpandedKeyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleKeyAdd = () => {
    const newId = `key-${Date.now()}-${formKeys.length}`;
    setFormKeys((prev) => [
      ...prev,
      { id: newId, apiKey: '', proxyUrl: '', weight: 1, isChanging: true },
    ]);
    setExpandedKeyIds((prev) => {
      const next = new Set(prev);
      next.add(newId);
      return next;
    });
  };

  const headersPayload = () => {
    const payload: Record<string, string> = {};
    for (const header of formHeaders) {
      if (header.key.trim() !== '') {
        payload[header.key.trim()] = header.value.trim();
      }
    }
    return payload;
  };

  const testProviderKey = async (k: FormKeyItem): Promise<{ ok: boolean; error?: unknown }> => {
    const apiKey = k.apiKey?.trim() || '';
    if (!apiKey) {
      message.warning(t('pro.test_key_empty'));
      return { ok: false };
    }
    const baseURL = formBaseURL.trim();
    if (!baseURL) {
      message.warning(t('pro.pull_requires_base_url'));
      return { ok: false };
    }
    try {
      await api.pullProviderModels({
        provider_id: editingProvider ? editingProvider.id : undefined,
        family: formFamily,
        base_url: baseURL,
        api_key: apiKey,
        proxy_url: k.proxyUrl?.trim() || '',
        headers: headersPayload(),
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  };

  const handleTestKey = async (k: FormKeyItem, idx: number) => {
    const hide = message.loading(t('pro.testing_key', { n: idx + 1 }), 0);
    const result = await testProviderKey(k);
    hide();
    if (result.ok) {
      message.success(t('pro.test_key_ok', { n: idx + 1 }));
      return;
    }
    if (result.error) {
      message.error(result.error instanceof ApiError ? result.error.message : String(result.error));
    }
  };

  const handleTestAllKeys = async () => {
    const keys = formKeys.filter((k) => k.apiKey && k.apiKey.trim() !== '');
    const hasAny = keys.length > 0;
    if (!hasAny) {
      message.warning(t('pro.test_key_empty'));
      return;
    }
    if (!formBaseURL.trim()) {
      message.warning(t('pro.pull_requires_base_url'));
      return;
    }
    const hide = message.loading(t('pro.testing_all'), 0);
    const results = await Promise.all(keys.map((key) => testProviderKey(key)));
    hide();
    const failed = results.filter((result) => !result.ok && result.error);
    if (failed.length === 0) {
      message.success(t('pro.test_all_ok', { count: keys.length }));
      return;
    }
    const firstError = failed[0]?.error;
    message.error(firstError instanceof ApiError ? firstError.message : String(firstError));
  };

  const handleCloseProviderDrawer = () => {
    modelFetchSeqRef.current += 1;
    setEndpointModels([]);
    setIsPullingModels(false);
    setProviderDrawerOpen(false);
  };

  /**
   * Inline feedback for the website field.
   *
   * The server refuses any scheme it cannot render as a link, so the field says
   * so before the save rather than turning the refusal into a failed request. An
   * empty field is valid: it means the provider has no website.
   */
  const websiteInputState = React.useMemo(() => {
    const trimmed = formWebsite.trim();
    if (!trimmed || isSafeExternalURL(trimmed)) return { status: undefined, help: undefined };
    return {
      status: 'error' as const,
      help: t('pro.field_website_invalid'),
    };
  }, [formWebsite, t]);

  /**
   * The enable/disable toggle runs through a per-provider last-intent queue.
   *
   * Clicking a switch twice in quick succession used to lose the second click:
   * the write and the list re-read are separated by a round trip, so the second
   * click either raced the first request or was ignored while it was pending,
   * and the row could settle showing the opposite of what was last asked for.
   * Serialising per provider keeps the fast path fast - one provider's update
   * never blocks another - while guaranteeing the gateway ends up on the value
   * of the last click.
   *
   * A confirmed write is settled from the write's own response rather than by
   * re-reading the list. The response already names the provider and its new
   * state, so re-reading spends a second round trip to learn what the first one
   * said, and that second read can resolve after a newer write and put the older
   * value back on screen. The list is still re-read when a write fails, because
   * then the console does need to know what the gateway actually holds.
   */

  const statusQueue = useLastIntentQueue<boolean>({
    // The queued value is the enabled state the switch shows, not the field the
    // endpoint takes. Inverting it once here, through the named helper, is what
    // keeps the two from being confused for each other; the confusion inverts
    // every toggle, so switching a provider off would ask for it on.
    apply: async (id, isEnabled, signal) => {
      const payload = providerStatusPayload(id, isEnabled);
      if (!payload) throw new Error(`unaddressable provider id: ${id}`);
      // The row's identity is read from the cache at write time rather than from a
      // captured render: a retry runs after the first attempt and must describe
      // the row as it is now, or its identity precondition would be checked
      // against values the console has already replaced.
      const row = queryClient
        .getQueryData<ManagementProvidersData>(['management-providers', true])
        ?.providers.find((provider) => provider.id === id);
      await api.patchManagementProviderStatus(payload.family, payload.index, payload.disabled, {
        signal,
        expectedAuthIndex: row?.auth_index,
        expectedName: row?.upstream_name || row?.name,
      });
    },
    // Only failures the operator cannot fix by waiting are worth repeating. The
    // classification lives beside the HTTP client, which is where the facade's
    // error codes are known.
    isRetryable: isRetryableWriteFailure,
    onConfirmed: (id, isEnabled) => {
      // The confirmed intent is exactly what the gateway now holds: the write is
      // only reported as confirmed once CPA accepted it, and the value sent is
      // the one the switch displays. Settled here, before the key is released, so
      // the row never renders a released key against a pre-write server value.
      settleProviderRow(id, isEnabled);
    },
    onError: (_id, err) => {
      // A timeout is reported differently from a refusal on purpose: abandoning a
      // request proves only that this console stopped waiting, not that the
      // gateway did not commit, so claiming the update failed would be as
      // misleading as claiming it succeeded. The busy refusal is named too: its
      // message arrives from the server in English, and a user-visible string must
      // come from the dictionary like every other one.
      const msg = err instanceof LastIntentTimeoutError
        ? t('pro.status_update_timeout')
        : apiErrorCode(err) === 'write_busy'
          ? t('pro.status_update_busy')
          : err instanceof ApiError
            ? err.message
            : String(err);
      message.error(t('pro.status_update_failed', { msg }));
      // The write did not confirm, so the row's displayed state is unknown rather
      // than merely stale: the list is re-read so the switch shows what the
      // gateway actually holds instead of the value that was attempted.
      void queryClient.invalidateQueries({ queryKey: ['management-providers'] });
    },
  });


  const createProviderMutation = useMutation({
    mutationFn: ({ payload }: { payload: SaveProviderPayload; icon: string }) =>
      api.createManagementProvider(payload),
    // The icon is written only once the create has named the row it added. A
    // create stores a positional id server-side, and the table resolves an id
    // key before a name key, so an override stored under the display name alone
    // could be shadowed by whatever id the new row landed on.
    onSuccess: (data, variables) => {
      message.success(t('pro.provider_created'));
      writeProviderIcon(data.id, variables.icon);
      handleCloseProviderDrawer();
      void queryClient.invalidateQueries({ queryKey: ['management-providers'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const updateProviderMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: SaveProviderPayload; icon: string }) =>
      api.updateManagementProvider(id, payload),
    onSuccess: (data, variables) => {
      message.success(t('pro.provider_updated'));
      writeProviderIcon(data.id, variables.icon);
      handleCloseProviderDrawer();
      void queryClient.invalidateQueries({ queryKey: ['management-providers'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const deleteProviderMutation = useMutation({
    mutationFn: (id: string) => api.deleteManagementProvider(id),
    onSuccess: (_data, id) => {
      message.success(t('pro.provider_deleted'));
      shiftCachedProviderIcons(id);
      void queryClient.invalidateQueries({ queryKey: ['management-providers'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const handleOpenCreate = () => {
    setEditingProvider(null);
    setFormFamily('openai-compatibility');
    setFormName('');
    setFormBaseURL('');
    setFormWebsite('');
    setFormPrefix('');
    setFormPriority(null);
    setFormDisabled(false);
    setFormDisableCooling(false);
    setFormTestModel('auto');
    setFormIcon('OpenAI');
    setIconManuallySelected(false);
    const initKeyId = 'key-init-1';
    setFormKeys([{ id: initKeyId, apiKey: '', proxyUrl: '', weight: 1, isChanging: true }]);
    setExpandedKeyIds(new Set([initKeyId]));
    setFormHeaders([]);
    modelFetchSeqRef.current++;
    setFormModels([]);
    setEndpointModels([]);
    setIsPullingModels(false);
    setExpandedModelIds(new Set());
    setKeysSectionOpen(true);
    setHeadersSectionOpen(false);
    setModelsSectionOpen(false);
    setProviderDrawerOpen(true);
  };

  const handleOpenEdit = (provider: ProviderItem) => {
    setEditingProvider(provider);
    setFormFamily(provider.family);
    setFormName(provider.name);
    setFormBaseURL(provider.base_url || '');
    setFormWebsite(provider.website || '');
    setFormPrefix(provider.prefix || '');
    setFormPriority(provider.priority != null ? provider.priority : null);
    setFormDisabled(provider.disabled);
    setFormDisableCooling(Boolean(provider.disable_cooling));

    setFormTestModel('auto');
    const existingIcon = resolveProviderIcon(
      providerIcons,
      provider,
      getProviderDefaultIcon(provider.family, provider.name, provider.base_url),
    );
    setFormIcon(existingIcon);
    setIconManuallySelected(Boolean(providerIcons[provider.id] || providerIcons[provider.name]));
    // Populate keys (plaintext — the tool mirrors the CPA config file as-is)
    if (provider.key_entries && provider.key_entries.length > 0) {
      setFormKeys(
        provider.key_entries.map((k, i) => ({
          id: `key-edit-${i}`,
          apiKey: k.api_key || '',
          proxyUrl: k.proxy_url,
          weight: k.weight ?? 1,
          isChanging: false,
        }))
      );
      setExpandedKeyIds(new Set());
    } else if (provider.api_key) {
      setFormKeys([
        {
          id: 'key-edit-0',
          apiKey: provider.api_key,
          weight: 1,
          isChanging: false,
        },
      ]);
      setExpandedKeyIds(new Set());
    } else {
      const initKeyId = 'key-new-0';
      setFormKeys([{ id: initKeyId, apiKey: '', proxyUrl: '', weight: 1, isChanging: true }]);
      setExpandedKeyIds(new Set([initKeyId]));
    }

    setKeysSectionOpen(true);
    setHeadersSectionOpen(false);
    setModelsSectionOpen(false);

    // Populate headers
    if (provider.headers && Object.keys(provider.headers).length > 0) {
      setFormHeaders(
        Object.entries(provider.headers).map(([k, v], i) => ({
          id: `hdr-edit-${i}`,
          key: k,
          value: v,
        }))
      );
    } else {
      setFormHeaders([]);
    }

    // Populate models
    if (provider.model_entries && provider.model_entries.length > 0) {
      setFormModels(
        provider.model_entries.map((m, i) => ({
          id: `model-edit-${i}`,
          name: m.name,
          alias: m.alias || '',
          image: m.image || false,
          thinking: m.thinking ? { levels: m.thinking.levels || [] } : { levels: [] },
        }))
      );
    } else if (provider.models && provider.models.length > 0) {
      setFormModels(
        provider.models.map((m, i) => ({
          id: `model-edit-${i}`,
          name: m,
          alias: '',
          image: false,
          thinking: { levels: [] },
        }))
      );
    } else {
      setFormModels([]);
    }
    modelFetchSeqRef.current++;
    setEndpointModels([]);
    setIsPullingModels(false);
    setExpandedModelIds(new Set());

    setProviderDrawerOpen(true);
  };

  const handleSaveProvider = () => {
    const keysPayload: SaveProviderKeyItem[] = formKeys.map((k) => ({
      api_key: k.apiKey || '',
      proxy_url: k.proxyUrl || '',
      weight: k.weight,
    }));

    const modelsPayload: SaveProviderModelItem[] = formModels
      .filter((m) => m.name.trim() !== '')
      .map((m) => ({
        name: m.name.trim(),
        alias: m.alias.trim() || undefined,
        image: m.image || false,
        thinking:
          m.thinking && m.thinking.levels && m.thinking.levels.length > 0
            ? { levels: m.thinking.levels }
            : undefined,
      }));

    const headersPayload: Record<string, string> = {};
    for (const h of formHeaders) {
      if (h.key.trim() !== '') {
        headersPayload[h.key.trim()] = h.value.trim();
      }
    }

    const payload: SaveProviderPayload = {
      family: formFamily,
      name: formName.trim() || 'Custom Provider',
      base_url: formBaseURL.trim(),
      website: formWebsite.trim(),
      prefix: formPrefix.trim(),
      priority: formPriority != null ? formPriority : undefined,
      disable_cooling: formDisableCooling,
      disabled: formDisabled,
      keys: keysPayload,
      model_entries: modelsPayload,
      headers: headersPayload,
    };

    // The icon travels with the write rather than being stored here: it is keyed
    // by the id the server answers with, and for a create that id does not exist
    // until the row does.
    if (editingProvider) {
      updateProviderMutation.mutate({ id: editingProvider.id, payload, icon: formIcon });
    } else {
      createProviderMutation.mutate({ payload, icon: formIcon });
    }
  };

  return {
    createProviderMutation,
    deleteProviderMutation,
    updateProviderMutation,
    statusQueue,
    providerDrawerOpen,
    editingProvider,
    formFamily,
    setFormFamily,
    formName,
    setFormName,
    formBaseURL,
    setFormBaseURL,
    formWebsite,
    setFormWebsite,
    formPrefix,
    setFormPrefix,
    formPriority,
    setFormPriority,
    formDisabled,
    setFormDisabled,
    formDisableCooling,
    setFormDisableCooling,
    formKeys,
    setFormKeys,
    formHeaders,
    setFormHeaders,
    formModels,
    setFormModels,
    formTestModel,
    setFormTestModel,
    formIcon,
    setFormIcon,
    iconManuallySelected,
    setIconManuallySelected,
    iconPickerOpen,
    setIconPickerOpen,
    targetProviderForIcon,
    setTargetProviderForIcon,
    keysSectionOpen,
    setKeysSectionOpen,
    headersSectionOpen,
    setHeadersSectionOpen,
    modelsSectionOpen,
    setModelsSectionOpen,
    expandedKeyIds,
    setExpandedKeyIds,
    expandedModelIds,
    setExpandedModelIds,
    endpointModels,
    setEndpointModels,
    isPullingModels,
    setIsPullingModels,
    modelFetchSeqRef,
    websiteInputState,
    handlePullModels,
    toggleModelExpanded,
    handleAddModel,
    updateModelImage,
    toggleThinkingLevel,
    handleSelectIcon,
    toggleKeyExpanded,
    handleKeyAdd,
    handleTestKey,
    handleTestAllKeys,
    handleCloseProviderDrawer,
    handleOpenCreate,
    handleOpenEdit,
    handleSaveProvider,
  };
}
