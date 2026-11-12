import { EMPTY_CONNECTION_POOL_DRAFT, readConnectionPoolDraft, connectionPoolEdit, isConnectionPoolValid, type ConnectionPoolDraft } from './connectionPool';
import React, { useState, useRef } from 'react';

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, apiErrorCode, describeError } from '../../api/client';
import { useT } from '../../i18n';
import type { Toast } from '../feedback';
import { useOptimisticProviderStatusMutation } from '../../hooks/useConfigMutations';
import { resolveProviderPickerIcon } from '../../types/brandMark';
import { isSafeExternalURL } from '../../utils/externalUrl';
import { lookupProviderFamily } from '../../types/providerFamilies';
import { modelsToAdd } from '../../utils/modelOptions';
import { isMotionReduced } from '../../utils/motionPreference';
import { credentialNameProblem, MAX_CREDENTIAL_NAME_LENGTH } from '../authFiles/authFileLogic';
import type {
  ProviderItem,
  SaveProviderPayload,
  SaveProviderKeyItem,
  SaveProviderModelItem,
} from '../../types/providers';
import {
  EMPTY_BEHAVIOR_DRAFT,
  EMPTY_RUNTIME_POLICY_DRAFT,
  buildBehavior,
  buildRuntimePolicy,
  readBehaviorDraft,
  readRuntimePolicyDraft,
  runtimePolicyProblem,
  type BehaviorDraft,
  type RuntimePolicyDraft,
} from './runtimePolicy';
import {
  EMPTY_MODEL_OPTIONS_DRAFT,
  buildModelOptions,
  modelOptionsProblem,
  readModelOptionsDraft,
} from './modelOptions';
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
  toast,
  t,
  providerIcons,
  writeProviderIcon,
  shiftCachedProviderIcons,
}: {
  toast: Toast;
  t: ReturnType<typeof useT>;
  providerIcons: Record<string, string>;
  writeProviderIcon: (id: string, icon: string) => Promise<{ ok: boolean }>;
  shiftCachedProviderIcons: (id: string) => void;
  settleProviderRow?: (id: string, isEnabled: boolean) => void;
}) {
  const queryClient = useQueryClient();

  const invalidateProviderCatalogs = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['management-providers'] }),
      queryClient.invalidateQueries({ queryKey: ['management-providers-sanitized'] }),
    ]);
  };

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
  const [formConnectionPool, setFormConnectionPool] = useState<ConnectionPoolDraft>(EMPTY_CONNECTION_POOL_DRAFT);
  const [formPolicy, setFormPolicy] = useState<RuntimePolicyDraft>(EMPTY_RUNTIME_POLICY_DRAFT);
  const [formBehavior, setFormBehavior] = useState<BehaviorDraft>(EMPTY_BEHAVIOR_DRAFT);
  const [policySectionOpen, setPolicySectionOpen] = useState<boolean>(false);
  // Set by a refused save, so a rule still being typed is not marked wrong before that.
  const [isPolicyChecked, setIsPolicyChecked] = useState<boolean>(false);
  const [formKeys, setFormKeys] = useState<FormKeyItem[]>([]);
  const [formHeaders, setFormHeaders] = useState<FormHeaderItem[]>([]);
  const [formModels, setFormModels] = useState<FormModelItem[]>([]);
  const [keysSectionOpen, setKeysSectionOpen] = useState<boolean>(true);
  const [expandedKeyIds, setExpandedKeyIds] = useState<Set<string>>(new Set());
  const [headersSectionOpen, setHeadersSectionOpen] = useState<boolean>(false);
  const [modelsSectionOpen, setModelsSectionOpen] = useState<boolean>(false);
  const [formTestModel, setFormTestModel] = useState<string>('');

  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [targetProviderForIcon, setTargetProviderForIcon] = useState<ProviderItem | null>(null);
  const [formIcon, setFormIcon] = useState<string>('OpenAI');
  const [iconManuallySelected, setIconManuallySelected] = useState<boolean>(false);

  // Endpoint models pull state, per-key connectivity probe state & custom models expand state
  const modelFetchSeqRef = useRef<number>(0);
  const probeSessionRef = useRef<number>(0);
  const probeCountsRef = useRef<Map<string, number>>(new Map());
  const [isPullingModels, setIsPullingModels] = useState(false);
  const [testingKeyIds, setTestingKeyIds] = useState<Set<string>>(new Set());
  const [isTestingAllKeys, setIsTestingAllKeys] = useState(false);
  const [endpointModels, setEndpointModels] = useState<string[]>([]);
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [expandedModelIds, setExpandedModelIds] = useState<Set<string>>(new Set());

  const incrementProbeKeys = (ids: readonly string[]) => {
    for (const id of ids) {
      probeCountsRef.current.set(id, (probeCountsRef.current.get(id) ?? 0) + 1);
    }
    setTestingKeyIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  };

  const decrementProbeKeys = (ids: readonly string[]) => {
    const released: string[] = [];
    for (const id of ids) {
      const rem = (probeCountsRef.current.get(id) ?? 1) - 1;
      if (rem <= 0) {
        probeCountsRef.current.delete(id);
        released.push(id);
      } else {
        probeCountsRef.current.set(id, rem);
      }
    }
    if (released.length > 0) {
      setTestingKeyIds((prev) => {
        const next = new Set(prev);
        for (const id of released) next.delete(id);
        return next;
      });
    }
  };

  const handlePullModels = async () => {
    const rawUrl = formBaseURL.trim();
    if (!rawUrl) {
      toast.warning(t('pro.pull_requires_base_url'));
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
    setIsModelPickerOpen(false);
    try {
      const res = await api.pullProviderModels({
        provider_id: editingProvider?.family === formFamily ? editingProvider.id : undefined,
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
        // A fetch is almost always followed by choosing from it, so the list opens
        // as a picker rather than leaving the operator to add rows one by one.
        setIsModelPickerOpen(true);
      } else {
        toast.info(t('pro.model_list_empty'));
      }
    } catch (err) {
      if (seq !== modelFetchSeqRef.current) return;
      const msg = describeError(err);
      toast.error(msg);
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
            el.scrollIntoView({ behavior: isMotionReduced() ? 'instant' : 'smooth', block: 'nearest' });
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
        options: EMPTY_MODEL_OPTIONS_DRAFT,
      },
    ]);
    setTimeout(() => {
      const el = document.getElementById(`model-card-${newId}`);
      if (el) {
        el.scrollIntoView({ behavior: isMotionReduced() ? 'instant' : 'smooth', block: 'end' });
      }
    }, 80);
  };

  const handleAddPickedModels = (picked: string[]) => {
    const added = modelsToAdd(picked, formModels.map((m) => m.name));
    setIsModelPickerOpen(false);
    if (added.length === 0) return;
    const stamp = Date.now();
    setFormModels((prev) => [
      // A blank row the operator added by hand and never filled would otherwise sit
      // above the batch as an entry the save silently drops.
      ...prev.filter((m) => m.name.trim() !== ''),
      ...added.map((name, i) => ({
        id: `mdl-${stamp}-${i}`,
        name,
        alias: '',
        image: false,
        thinking: { levels: [] },
        options: EMPTY_MODEL_OPTIONS_DRAFT,
      })),
    ]);
    toast.success(t('pro.models_applied', { count: added.length }));
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

  const setThinkingLevels = (modelId: string, levels: string[]) => {
    setFormModels((prev) =>
      prev.map((item) => (item.id === modelId ? { ...item, thinking: { levels } } : item))
    );
  };

  const handleSelectIcon = async (selectedIconId: string): Promise<boolean> => {
    if (targetProviderForIcon) {
      const result = await writeProviderIcon(targetProviderForIcon.id, selectedIconId);
      if (!result.ok) return false;
      toast.success(t('pro.icon_updated'));
      setTargetProviderForIcon(null);
    } else {
      setFormIcon(selectedIconId);
      setIconManuallySelected(true);
    }
    return true;
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

  // The probe carries a real minimal inference request, not a model-list
  // fetch: a key that lists models may still fail to serve. The model is
  // the drawer's test choice, falling back to its first configured model.
  const resolveTestModel = (): string => {
    const trimmedTestModel = formTestModel.trim();
    if (trimmedTestModel !== '' && formModels.some((item) => item.name.trim() === trimmedTestModel)) return trimmedTestModel;
    return formModels.map((item) => item.name.trim()).find((name) => name !== '') ?? '';
  };

  const testProviderKey = async (k: FormKeyItem): Promise<{ ok: boolean; error?: unknown }> => {
    const apiKey = k.apiKey?.trim() || '';
    if (!apiKey) {
      toast.warning(t('pro.test_key_empty'));
      return { ok: false };
    }
    const model = resolveTestModel();
    if (!model) {
      toast.warning(t('pro.test_model_required'));
      return { ok: false };
    }
    try {
      const probed = await api.probeProvider({
        provider_id: editingProvider?.family === formFamily ? editingProvider.id : undefined,
        family: formFamily,
        base_url: formBaseURL.trim(),
        api_key: apiKey,
        proxy_url: k.proxyUrl?.trim() || '',
        model,
        headers: headersPayload(),
        // A vertex draft with Interactions enabled is served through that
        // dialect; the server falls back to the stored entry for saved ones.
        interactions: formFamily === 'vertex' ? formBehavior.interactions : undefined,
      });
      return probed.ok ? { ok: true } : { ok: false, error: probed.error || t('pro.test_key_failed') };
    } catch (error) {
      return { ok: false, error };
    }
  };

  const handleTestKey = async (k: FormKeyItem, idx: number) => {
    const session = probeSessionRef.current;
    incrementProbeKeys([k.id]);
    const hide = toast.pending(t('pro.testing_key', { n: idx + 1 }));
    try {
      const result = await testProviderKey(k);
      if (probeSessionRef.current !== session) return;
      if (result.ok) {
        toast.success(t('pro.test_key_ok', { n: idx + 1 }));
        return;
      }
      if (result.error) {
        toast.error(t('pro.test_key_failed'), { detail: describeError(result.error), isPersistent: true });
      }
    } finally {
      hide();
      if (probeSessionRef.current === session) {
        decrementProbeKeys([k.id]);
      }
    }
  };

  const handleTestAllKeys = async () => {
    const keys = formKeys.filter((k) => k.apiKey && k.apiKey.trim() !== '');
    const hasAny = keys.length > 0;
    if (!hasAny) {
      toast.warning(t('pro.test_key_empty'));
      return;
    }
    // Families without a base URL fall back to their official endpoint on the
    // server; only ones CPA would silently drop without it are gated here.
    if (lookupProviderFamily(formFamily)?.requiresBaseURL && !formBaseURL.trim()) {
      toast.warning(t('pro.pull_requires_base_url'));
      return;
    }
    // Resolve the model once up front: without one no probe can run, and
    // per-key warnings followed by a success toast would claim tests ran.
    if (!resolveTestModel()) {
      toast.warning(t('pro.test_model_required'));
      return;
    }
    const session = probeSessionRef.current;
    const keyIds = keys.map((key) => key.id);
    setIsTestingAllKeys(true);
    incrementProbeKeys(keyIds);
    const hide = toast.pending(t('pro.testing_all'));
    try {
      const results = await Promise.all(keys.map((key) => testProviderKey(key)));
      if (probeSessionRef.current !== session) return;
      // Every unsuccessful probe counts, including ones that warned instead of
      // erroring: the success toast must mean every key answered.
      const failed = results.filter((result) => !result.ok);
      if (failed.length === 0) {
        toast.success(t('pro.test_all_ok', { count: keys.length }));
        return;
      }
      const firstError = failed[0]?.error;
      toast.error(t('pro.test_key_failed'), { detail: describeError(firstError), isPersistent: true });
    } finally {
      hide();
      if (probeSessionRef.current === session) {
        setIsTestingAllKeys(false);
        decrementProbeKeys(keyIds);
      }
    }
  };

  const handleCloseProviderDrawer = () => {
    modelFetchSeqRef.current += 1;
    probeSessionRef.current += 1;
    probeCountsRef.current.clear();
    setEndpointModels([]);
    setIsPullingModels(false);
    setTestingKeyIds(new Set());
    setIsTestingAllKeys(false);
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
   * Provider enable/disable toggles mutate the shared TanStack Query caches on the
   * exact click frame via useOptimisticProviderStatusMutation and coalesce inside
   * the Go StateCoordinator's 250ms write-behind window. Per-provider sequence and
   * in-flight counters ensure overlapping multi-row or rapid single-row clicks
   * always clear busy indicators and never overwrite a newer click's state.
   */

  // Provider write refusals carry stable codes, so the toast names the problem
  // in the console's language instead of showing the facade's English prose.
  // Every code names one thing the operator has to change.
  const providerWriteMessage = (err: unknown): string => {
    switch (apiErrorCode(err)) {
      case 'provider_key_required': return t('pro.error_key_required');
      case 'provider_connection_pool_invalid': return t('pool.invalid');
      case 'provider_duplicate_key': return t('pro.error_duplicate_key');
      case 'provider_credential_exists': return t('pro.error_credential_exists');
      case 'provider_stale_identity': return t('pro.error_stale_identity');
      case 'write_busy': return t('pro.status_update_busy');
      case 'provider_commit_partial': return t('pro.error_partial_commit');
      default: return describeError(err);
    }
  };

  const [busyProviderIds, setBusyProviderIds] = useState<Set<string>>(new Set());
  const inFlightCountRef = useRef<Map<string, number>>(new Map());
  const providerToggleChainRef = useRef<Map<string, Promise<void>>>(new Map());

  const statusMutation = useOptimisticProviderStatusMutation({
    formatError: (err) => t('pro.status_update_failed', { msg: providerWriteMessage(err) }),
  });

  const toggleProviderStatus = (id: string, isEnabled: boolean) => {
    const row = queryClient
      .getQueryData<ManagementProvidersData>(['management-providers', true])
      ?.providers.find((provider) => provider.id === id);
    const expectedAuthIndex = row?.auth_index;
    const expectedName = row?.upstream_name || row?.name;

    // Paint the optimistic switch flip synchronously on the click frame even when an
    // earlier request for the same provider is still in flight on the wire.
    for (const includeKeys of [true, false] as const) {
      queryClient.setQueryData<ManagementProvidersData>(
        ['management-providers', includeKeys],
        (current) =>
          current
            ? {
                ...current,
                providers: current.providers.map((p) =>
                  p.id === id ? { ...p, disabled: !isEnabled } : p,
                ),
              }
            : current,
      );
    }

    const nextInFlight = (inFlightCountRef.current.get(id) ?? 0) + 1;
    inFlightCountRef.current.set(id, nextInFlight);
    setBusyProviderIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));

    const previous = providerToggleChainRef.current.get(id) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await statusMutation.mutateAsync({
            id,
            isEnabled,
            expectedAuthIndex,
            expectedName,
          });
        } catch {
          // Snapshot rollback and localized toast are handled by useOptimisticProviderStatusMutation.
        }
      })
      .finally(() => {
        if (providerToggleChainRef.current.get(id) === run) {
          providerToggleChainRef.current.delete(id);
        }
        const remaining = (inFlightCountRef.current.get(id) ?? 1) - 1;
        if (remaining <= 0) {
          inFlightCountRef.current.delete(id);
          setBusyProviderIds((prev) => {
            if (!prev.has(id)) return prev;
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        } else {
          inFlightCountRef.current.set(id, remaining);
        }
      });
    providerToggleChainRef.current.set(id, run);
  };


  const createProviderMutation = useMutation({
    mutationFn: ({ payload }: { payload: SaveProviderPayload; icon: string }) =>
      api.createManagementProvider(payload),
    // The icon is written only once the create has named the row it added. A
    // create stores a positional id server-side, and the table resolves an id
    // key before a name key, so an override stored under the display name alone
    // could be shadowed by whatever id the new row landed on.
    onSuccess: async (data, variables) => {
      for (const id of data.ids ?? [data.id]) {
        const result = await writeProviderIcon(id, variables.icon);
        if (!result.ok) { handleCloseProviderDrawer(); void invalidateProviderCatalogs(); return; }
      }
      toast.success(t('pro.provider_created'));
      handleCloseProviderDrawer();
      void invalidateProviderCatalogs();
    },
    onError: (err: unknown) => {
      toast.error(providerWriteMessage(err));
    },
  });

  const updateProviderMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: SaveProviderPayload; icon: string }) =>
      api.updateManagementProvider(id, payload),
    onSuccess: async (data, variables) => {
      if (data.id !== variables.id) {
        // Refresh the overlays moved by the server before merging an icon pick,
        // or the cached source ids would be written back over the new positions.
        handleCloseProviderDrawer();
        void invalidateProviderCatalogs();
        await queryClient.fetchQuery({ queryKey: ['preferences'], queryFn: api.getPreferences, staleTime: 0 });
      }
      for (const id of data.ids ?? [data.id]) {
        const result = await writeProviderIcon(id, variables.icon);
        if (!result.ok) { handleCloseProviderDrawer(); void invalidateProviderCatalogs(); return; }
      }
      toast.success(t('pro.provider_updated'));
      handleCloseProviderDrawer();
      void invalidateProviderCatalogs();
    },
    onError: (err: unknown) => {
      if (apiErrorCode(err) === 'provider_commit_partial') {
        handleCloseProviderDrawer();
        void invalidateProviderCatalogs();
        void queryClient.invalidateQueries({ queryKey: ['preferences'] });
      }
      toast.error(providerWriteMessage(err));
    },
  });

  const deleteProviderMutation = useMutation({    mutationFn: (id: string) => api.deleteManagementProvider(id),
    onSuccess: (_data, id) => {
      toast.success(t('pro.provider_deleted'));
      shiftCachedProviderIcons(id);
      void queryClient.invalidateQueries({ queryKey: ['custom-icons'] });
      // The server re-keyed the positional overlays, among them the provider and routing-card
      // orders, which the preference cache would otherwise keep under the pre-delete ids.
      void queryClient.invalidateQueries({ queryKey: ['preferences'] });
      void invalidateProviderCatalogs();
    },
    onError: (err: unknown) => {
      toast.error(providerWriteMessage(err));
    },
  });

  /**
   * Names a row from the list, or clears its name, without opening the editor. The outcome is a
   * toast; the promise answers whether the name was saved, so the field stays open over one that
   * was not. A row another session shifted is refused and the list re-read.
   */
  const renameProvider = async (provider: ProviderItem, name: string): Promise<boolean> => {
    const next = name.trim();
    // The server counts code points and refuses control characters under the credential-name
    // rules; checking here gives the refusal the same localized message.
    const problem = credentialNameProblem(next);
    if (problem) {
      toast.warning(problem === 'too_long'
        ? t('af.rename_too_long', { n: MAX_CREDENTIAL_NAME_LENGTH })
        : t('af.rename_control'));
      return false;
    }
    try {
      await api.setManagementProviderName(provider.id, next, {
        expectedAuthIndex: provider.auth_index,
        expectedName: provider.upstream_name,
      });
      toast.success(t(next ? 'af.renamed' : 'af.rename_cleared'));
      await invalidateProviderCatalogs();
      return true;
    } catch (err) {
      toast.error(providerWriteMessage(err));
      if (apiErrorCode(err) === 'provider_stale_identity') {
        await invalidateProviderCatalogs();
      }
      return false;
    }
  };

  const handleOpenCreate = () => {
    setEditingProvider(null);
    setFormFamily('openai-compatibility');
    setFormName('');
    setFormBaseURL('');
    setFormWebsite('');
    setFormPrefix('');
    setFormPriority(null);
    setFormDisabled(false);
    setFormConnectionPool(EMPTY_CONNECTION_POOL_DRAFT);
    setFormPolicy(EMPTY_RUNTIME_POLICY_DRAFT);
    setFormBehavior(EMPTY_BEHAVIOR_DRAFT);
    setPolicySectionOpen(false);
    setIsPolicyChecked(false);
    setFormTestModel('');
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
    setFormConnectionPool(readConnectionPoolDraft(provider.connection_pool?.defaults));
    setFormPolicy(readRuntimePolicyDraft(provider));
    setFormBehavior(readBehaviorDraft(provider));
    setPolicySectionOpen(false);
    setIsPolicyChecked(false);

    setFormTestModel(provider.test_model || '');
    const existingIcon = resolveProviderPickerIcon(provider, { providerIcons });
    setFormIcon(existingIcon);
    setIconManuallySelected(Boolean(providerIcons[provider.id] || providerIcons[provider.name]));
    // Populate keys (plaintext — the tool mirrors the CPA config file as-is)
    if (provider.key_entries && provider.key_entries.length > 0) {
      setFormKeys(
        provider.key_entries.map((k, i) => ({
          id: `key-edit-${i}`,
          connectionPool: readConnectionPoolDraft(k.connection_pool),
          storedConnectionPool: k.connection_pool,
          storedIndex: k.index,
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
          options: readModelOptionsDraft(m.options),
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
          options: EMPTY_MODEL_OPTIONS_DRAFT,
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
    if (lookupProviderFamily(formFamily)?.requiresBaseURL && !formBaseURL.trim()) {
      toast.warning(t('pro.base_url_required'));
      return;
    }

    const hasGroupPoolEdit = connectionPoolEdit(formConnectionPool, editingProvider?.connection_pool?.defaults) !== undefined;
    const isGroupPoolInvalid = hasGroupPoolEdit && !isConnectionPoolValid(formConnectionPool);
    const invalidPoolKey = formKeys.find(key =>
      key.connectionPool && connectionPoolEdit(key.connectionPool, key.storedConnectionPool) !== undefined && !isConnectionPoolValid(key.connectionPool));
    if (isGroupPoolInvalid || invalidPoolKey) {
      if (isGroupPoolInvalid) setPolicySectionOpen(true);
      if (invalidPoolKey) {
        setKeysSectionOpen(true);
        setExpandedKeyIds(previous => new Set([...previous, invalidPoolKey.id]));
      }
      toast.warning(t('pool.invalid'));
      return;
    }
    const family = lookupProviderFamily(formFamily);
    const supportsErrorRules = family?.supportsErrorRules ?? false;
    const policyProblem = runtimePolicyProblem(formPolicy, supportsErrorRules);
    if (policyProblem) {
      // The section opens on the problem: a refusal pointing into a collapsed group cannot be acted on.
      setIsPolicyChecked(true);
      setPolicySectionOpen(true);
      toast.warning(
        policyProblem.kind === 'retry'
          ? t('policy.retry_invalid')
          : t('policy.rule_invalid', { n: policyProblem.position + 1 }),
      );
      return;
    }

    const modelOptionFields = family?.modelOptionFields ?? [];
    const invalidModel = formModels.find(
      (model) => model.name.trim() !== '' && modelOptionsProblem(model.options, modelOptionFields) !== null,
    );
    if (invalidModel) {
      // The row opens on the problem, which it states beside the field at fault.
      setExpandedModelIds((prev) => new Set([...prev, invalidModel.id]));
      toast.warning(t('pro.model_options_invalid', { model: invalidModel.name.trim() }));
      return;
    }

    const keysPayload: SaveProviderKeyItem[] = formKeys.map((k) => ({
      api_key: k.apiKey || '',
      connection_pool: k.connectionPool ? connectionPoolEdit(k.connectionPool, k.storedConnectionPool) : undefined,
      proxy_url: k.proxyUrl || '',
      source_index: k.storedIndex,
      weight: k.weight,
    }));

    const supportsModelImage = lookupProviderFamily(formFamily)?.supportsModelImage ?? false;
    const modelsPayload: SaveProviderModelItem[] = formModels
      .filter((m) => m.name.trim() !== '')
      .map((m) => ({
        name: m.name.trim(),
        alias: m.alias.trim() || undefined,
        image: supportsModelImage && (m.image || false),
        thinking:
          m.thinking && m.thinking.levels && m.thinking.levels.length > 0
            ? { levels: m.thinking.levels }
            : undefined,
        options: buildModelOptions(m.options, modelOptionFields),
      }));

    const headersPayload: Record<string, string> = {};
    for (const h of formHeaders) {
      if (h.key.trim() !== '') {
        headersPayload[h.key.trim()] = h.value.trim();
      }
    }

    const payload: SaveProviderPayload = {
      family: formFamily,
      connection_pool: connectionPoolEdit(formConnectionPool, editingProvider?.connection_pool?.defaults),
      expected_auth_index: editingProvider?.auth_index,
      expected_name: editingProvider?.upstream_name || editingProvider?.name,
      name: formName.trim() || 'Custom Provider',
      base_url: formBaseURL.trim(),
      website: formWebsite.trim(),
      test_model: formModels.some((model) => model.name.trim() === formTestModel.trim()) ? formTestModel.trim() : '',
      prefix: formPrefix.trim(),
      priority: formPriority != null ? formPriority : undefined,
      runtime_policy: buildRuntimePolicy(formPolicy, supportsErrorRules),
      behavior: buildBehavior(formBehavior, family?.behaviorSwitches),
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
    renameProvider,
    toggleProviderStatus,
    busyProviderIds,
    testingKeyIds,
    isTestingAllKeys,
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
    formConnectionPool,
    setFormConnectionPool,
    formPolicy,
    setFormPolicy,
    formBehavior,
    setFormBehavior,
    policySectionOpen,
    setPolicySectionOpen,
    isPolicyChecked,
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
    isModelPickerOpen,
    setIsModelPickerOpen,
    handleAddPickedModels,
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
    setThinkingLevels,
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
