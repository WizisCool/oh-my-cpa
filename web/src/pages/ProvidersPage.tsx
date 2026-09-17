import React, { useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Card,
  Table,
  Tag,
  Button,
  Input,
  InputNumber,
  Checkbox,
  Switch,
  Alert,
  Drawer,
  Tooltip,
  Popconfirm,
  Form,
  Select,
  Row,
  Col,
  AutoComplete,
  App as AntdApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  SyncOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  CloseOutlined,
  UpOutlined,
  DownOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, apiErrorCode, isRetryableWriteFailure } from '../api/client';
import { useT } from '../i18n';
import { usePreference } from '../hooks/usePreference';
import { useLastIntentQueue, LastIntentTimeoutError } from '../hooks/useLastIntentQueue';
import { LobeIcon, getProviderDefaultIcon } from '../components/LobeIcon';
import { IconPickerModal } from '../components/IconPickerModal';
import {
  EMPTY_PROVIDER_ICONS,
  PROVIDER_ICONS_PREFERENCE,
  parseProviderIcons,
  providerIconIdPrefix,
  resolveProviderIcon,
  shiftProviderIconsAfterDelete,
} from '../types/providerIcons';
import { maskKeyText } from '../utils/maskKey';
import { isSafeExternalURL, safeExternalURL } from '../utils/externalUrl';
import { modelOptionsFor } from '../utils/modelOptions';
import { providerStatusPayload } from '../types/providerId';
import { PROVIDER_FAMILIES, matchProviderFamily } from '../types/providerFamilies';
import type {
  ProviderItem,
  SaveProviderPayload,
  SaveProviderKeyItem,
  SaveProviderModelItem,
} from '../types/providers';


const THINKING_LEVEL_OPTIONS = [
  { value: 'none', labelKey: 'pro.level_none' },
  { value: 'minimal', labelKey: 'pro.level_minimal' },
  { value: 'low', labelKey: 'pro.level_low' },
  { value: 'medium', labelKey: 'pro.level_medium' },
  { value: 'high', labelKey: 'pro.level_high' },
  { value: 'xhigh', labelKey: 'pro.level_xhigh' },
  { value: 'max', labelKey: 'pro.level_max' },
  { value: 'auto', labelKey: 'pro.level_auto' },
];

/**
 * ManagementProvidersData is the cached shape of the providers list. It is named
 * because the toggle's confirmation writes into this cache directly.
 */
interface ManagementProvidersData {
  providers: ProviderItem[];
  total: number;
}


interface FormKeyItem {
  id: string;
  apiKey?: string;
  proxyUrl?: string;
  weight?: number;
  isChanging?: boolean;
}

interface FormHeaderItem {
  id: string;
  key: string;
  value: string;
}

interface FormModelItem {
  id: string;
  name: string;
  alias: string;
  image?: boolean;
  thinking?: {
    levels?: string[];
  };
}

export const ProvidersPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
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

  // Stored icon preferences
  const { value: providerIcons, set: setProviderIcons } = usePreference<Record<string, string>>(
    PROVIDER_ICONS_PREFERENCE,
    EMPTY_PROVIDER_ICONS,
    parseProviderIcons,
  );
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [targetProviderForIcon, setTargetProviderForIcon] = useState<ProviderItem | null>(null);
  const [formIcon, setFormIcon] = useState<string>('OpenAI');
  const [iconManuallySelected, setIconManuallySelected] = useState<boolean>(false);

  /**
   * currentProviderIcons reads the icon map as the preference cache holds it
   * now.
   *
   * A write that happens on a mutation's confirmation runs several renders
   * after the drawer that started it, so merging into this render's
   * `providerIcons` would drop an override another control stored in between.
   * Reading the cache is what keeps the merge additive.
   */
  const currentProviderIcons = React.useCallback(
    () =>
      parseProviderIcons(
        queryClient.getQueryData<Record<string, unknown>>(['preferences'])?.[PROVIDER_ICONS_PREFERENCE],
      ),
    [queryClient],
  );

  /**
   * writeProviderIcon stores one override under one provider id.
   *
   * The id is the row's own positional one: the table resolves an id key first,
   * so an override stored only under a display name could be shadowed by the id
   * the row reads first - and a display name is not unique, so two credentials
   * sharing one would overwrite each other's mark.
   */
  const writeProviderIcon = React.useCallback(
    (id: string, icon: string) => {
      if (!id) return;
      setProviderIcons({ ...currentProviderIcons(), [id]: icon });
    },
    [currentProviderIcons, setProviderIcons],
  );

  /**
   * shiftCachedProviderIcons replays a provider delete's re-keying of the icon
   * overlay into this console's cache, without writing it back.
   *
   * The stored document is already re-keyed server-side as part of the delete,
   * so keeping the deleted row's override in this cache would only matter as the
   * baseline of the next icon write, which would then restore the key the delete
   * removed. Writing only the cache - rather than PUTting the whole document from
   * a client that may not be the one that authored it - is what keeps this from
   * overwriting an override another console stored in the meantime.
   */
  const shiftCachedProviderIcons = React.useCallback(
    (id: string) => {
      const idPrefix = providerIconIdPrefix(id);
      if (!idPrefix) return;
      // Evaluated only against a document that is already loaded: creating the
      // cache entry here would publish it as fresh, and every other preference
      // would then read as unset until the page was reloaded.
      const cached = queryClient.getQueryData<Record<string, unknown>>(['preferences']);
      if (!cached) return;
      const deletedIndex = Number(id.slice(idPrefix.length));
      queryClient.setQueryData<Record<string, unknown>>(['preferences'], {
        ...cached,
        [PROVIDER_ICONS_PREFERENCE]: shiftProviderIconsAfterDelete(
          parseProviderIcons(cached[PROVIDER_ICONS_PREFERENCE]),
          idPrefix,
          deletedIndex,
        ),
      });
    },
    [queryClient],
  );

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

  const handleTestKey = (k: FormKeyItem, idx: number) => {
    if (!k.apiKey || !k.apiKey.trim()) {
      message.warning(t('pro.test_key_empty'));
      return;
    }
    const hide = message.loading(t('pro.testing_key', { n: idx + 1 }), 0);
    setTimeout(() => {
      hide();
      message.success(t('pro.test_key_ok', { n: idx + 1 }));
    }, 450);
  };

  const handleTestAllKeys = () => {
    const hasAny = formKeys.some((k) => k.apiKey && k.apiKey.trim() !== '');
    if (!hasAny) {
      message.warning(t('pro.test_key_empty'));
      return;
    }
    const hide = message.loading(t('pro.testing_all'), 0);
    setTimeout(() => {
      hide();
      message.success(t('pro.test_all_ok', { count: formKeys.length }));
    }, 550);
  };

  // ── 1. Providers Query & Mutations ────────────────────────────────────────
  const {
    data: providersData,
    isLoading: providersLoading,
    isFetching: providersFetching,
    isError: providersError,
    error: providersErr,
    refetch: refetchProviders,
  } = useQuery({
    queryKey: ['management-providers', true],
    // The providers page owns key management, so it is the one consumer that
    // opts back into plaintext key material (display is masked client-side).
    queryFn: async () => {
      const generation = providersListReadsRef.current;
      const data = await api.getManagementProviders(true);
      // A confirmation that landed while this read was in flight has already
      // written the newer state into the cache. Publishing this read's older data
      // would undo that confirmation, so the cache is returned as it stands. It is
      // returned rather than thrown so the read does not put the page into an
      // error state over data that is merely superseded.
      if (generation !== providersListReadsRef.current) {
        return queryClient.getQueryData<ManagementProvidersData>(['management-providers', true]) ?? data;
      }
      return data;
    },
    staleTime: 30000,
  });

  const providers = providersData?.providers || [];

  const [searchParams] = useSearchParams();
  const targetProviderParam = searchParams.get('provider');
  const handledTargetRef = useRef<string | null>(null);

  React.useEffect(() => {
    if (!targetProviderParam || providersLoading || providers.length === 0) return;
    if (handledTargetRef.current === targetProviderParam) return;
    handledTargetRef.current = targetProviderParam;
    const norm = targetProviderParam.toLowerCase().trim();
    const matched = providers.find(
      (p) =>
        p.id.toLowerCase() === norm ||
        p.name?.toLowerCase() === norm ||
        p.upstream_name?.toLowerCase() === norm ||
        p.family?.toLowerCase() === norm
    );
    if (matched) {
      handleOpenEdit(matched);
    }
  }, [targetProviderParam, providersLoading, providers]);

  /**
   * providersListReads is the revision of the provider list's confirmed state.
   *
   * A read records this before it starts and compares it afterwards. It advances
   * when a write confirms a new state, so a read that began before that
   * confirmation can tell that the data it just received describes a state which
   * has since been replaced. Without it, such a read would resolve afterwards and
   * put the pre-write value back on screen.
   */
  const providersListReadsRef = useRef(0);

  /**
   * settleProviderRow writes one confirmed provider state into the cached list.
   *
   * The read generation is advanced first: any list read already in flight was
   * issued before this confirmation, so its data describes a state that has since
   * been superseded. Re-reading on every toggle was the other way a stale
   * response could win, so it is avoided rather than reconciled.
   */
  const settleProviderRow = React.useCallback(
    (id: string, isEnabled: boolean) => {
      providersListReadsRef.current += 1;
      queryClient.setQueryData<ManagementProvidersData>(
        ['management-providers', true],
        (previous) => {
          if (!previous) return previous;
          let didChange = false;
          const providers = previous.providers.map((provider) => {
            if (provider.id !== id || provider.disabled === !isEnabled) return provider;
            didChange = true;
            return { ...provider, disabled: !isEnabled };
          });
          // A new object only when a row really changed: an identical list would
          // still re-render every row while a burst is in flight.
          return didChange ? { ...previous, providers } : previous;
        },
      );
    },
    [queryClient],
  );

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

  // ── 2. Shared helpers ─────────────────────────────────────────────────────
  /**
   * resolveEnabled is the row's single answer to "is this provider on?".
   *
   * The status label and the switch both render it, so a burst can never leave
   * one saying on and the other off: the intent wins while the queue is working,
   * and the gateway's own value is the answer at rest.
   */
  const resolveEnabled = (record: ProviderItem): boolean => {
    const target = statusQueue.targetFor(record.id);
    return target === undefined ? !record.disabled : target;
  };

  // Family labels and the picker's options both come from the family registry,
  // so a family the console manages cannot appear in one and not the other.
  const familyDisplayNames: Record<string, string> = Object.fromEntries(
    PROVIDER_FAMILIES.map((family) => [family.id, t(family.labelKey)]),
  );
  const familyOptions = PROVIDER_FAMILIES.map((family) => ({
    label: `${t(family.labelKey)} (${family.id})`,
    value: family.id,
  }));

  // Column order mirrors the CPAMC provider table so operators moving between
  // the two consoles find the same facts in the same sequence.
  const providerColumns: ColumnsType<ProviderItem> = [
    // 1. icon + display name
    {
      title: t('pro.col_provider'),
      key: 'name',
      render: (_, record) => {
        const iconId = resolveProviderIcon(
          providerIcons,
          record,
          getProviderDefaultIcon(record.family, record.name, record.base_url),
        );
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              title={t('pro.change_icon')}
              onClick={() => {
                setTargetProviderForIcon(record);
                setIconPickerOpen(true);
              }}
            >
              <LobeIcon iconId={iconId} size={22} />
            </div>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg)' }}>
                {safeExternalURL(record.website) ? (
                  // The name is the link when a website is known: the operator's
                  // own label is what they look for on the row, so making it the
                  // target avoids a column for one URL. rel/target keep the
                  // destination from reaching back through window.opener.
                  <a
                    href={safeExternalURL(record.website)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--accent)' }}
                  >
                    {record.name}
                  </a>
                ) : (
                  record.name
                )}
              </div>
              {record.api_key && (
                <div
                  title={record.api_key}
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 11,
                    color: 'var(--meta)',
                    marginTop: 2,
                    maxWidth: 220,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {maskKeyText(record.api_key)}
                </div>
              )}
            </div>
          </div>
        );
      },
    },

    // 2. protocol driver
    {
      title: t('pro.col_protocol'),
      key: 'protocol',
      render: (_, record) => {
        const meta = matchProviderFamily(record.family, record.protocol);
        if (!meta) {
          return (
            <Tag style={{ margin: 0 }}>
              {record.protocol || record.family || t('pro.none_text')}
            </Tag>
          );
        }
        return (
          <Tag
            style={{
              margin: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '2px 8px',
              borderRadius: 4,
              color: meta.color,
              borderColor: `${meta.color}66`,
              backgroundColor: `${meta.color}18`,
              fontWeight: 500,
              fontSize: 12,
              lineHeight: '18px',
            }}
          >
            <LobeIcon
              iconId={meta.iconId}
              size={13}
              variant="mono"
              style={{ color: meta.color, flexShrink: 0, display: 'inline-flex' }}
            />
            <span>{t(meta.labelKey)}</span>
          </Tag>
        );
      },
    },

    // 3. endpoint (truncated when too long)
    {
      title: t('pro.col_endpoint'),
      key: 'base_url',
      render: (_, record) => {
        if (!record.base_url) return <span style={{ color: 'var(--meta)' }}>{t('pro.none_text')}</span>;
        return (
          <Tooltip title={record.base_url}>
            <div
              style={{
                maxWidth: 240,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'monospace',
                fontSize: 12,
                color: 'var(--fg)',
              }}
            >
              {record.base_url}
            </div>
          </Tooltip>
        );
      },
    },

    // 4. prefix (shows "none" when absent)
    {
      title: t('pro.field_prefix'),
      key: 'prefix',
      render: (_, record) =>
        record.prefix ? (
          <Tag color="geekblue" style={{ fontFamily: 'monospace', margin: 0, borderRadius: 'var(--radius-sm, 4px)' }}>
            {record.prefix}
          </Tag>
        ) : (
          <span style={{ color: 'var(--meta)', fontSize: 13 }}>{t('pro.none_text')}</span>
        ),
    },

    // 5. models / request headers
    {
      title: t('pro.col_models_headers'),
      key: 'models_headers',
      render: (_, record) => {
        const modelCount = record.model_entries?.length || record.models?.length || 0;
        const keyCount = record.key_entries?.length || (record.key_configured ? 1 : 0);
        const headerCount = record.headers ? Object.keys(record.headers).length : 0;
        const modelNames =
          record.model_entries?.map((m) => m.name).join(', ') ||
          record.models?.join(', ') ||
          '';

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <Tooltip title={modelNames || undefined}>
                <Tag
                  style={{
                    borderRadius: 'var(--radius-sm, 4px)',
                    fontSize: 11,
                    margin: 0,
                    padding: '0 8px',
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                  }}
                >
                  {t('pro.model_count_pill', { n: modelCount })}
                </Tag>
              </Tooltip>
              <Tag
                style={{
                  borderRadius: 'var(--radius-sm, 4px)',
                  fontSize: 11,
                  margin: 0,
                  padding: '0 8px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                }}
              >
                {t('pro.key_count_pill', { n: keyCount })}
              </Tag>
            </div>
            <div>
              <Tag
                style={{
                  borderRadius: 'var(--radius-sm, 4px)',
                  fontSize: 11,
                  margin: 0,
                  padding: '0 8px',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                }}
              >
                {t('pro.header_count_pill', { n: headerCount })}
              </Tag>
            </div>
          </div>
        );
      },
    },

    // 6. status
    {
      title: t('pro.col_status'),
      key: 'status',
      width: 100,
      render: (_, record) => {
        // Read through the same resolution the switch uses. During a burst the
        // row shows the operator's newest intent in both places, so the label
        // and the control can never contradict each other on the same line while
        // the gateway catches up.
        const isEnabled = resolveEnabled(record);
        return isEnabled ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: 'var(--success)', flexShrink: 0 }} />
            <span style={{ color: 'var(--text)' }}>{t('pro.status_active')}</span>
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ width: 7, height: 7, borderRadius: 2, background: 'var(--warn)', flexShrink: 0 }} />
            <span style={{ color: 'var(--text-muted)' }}>{t('pro.status_disabled')}</span>
          </span>
        );
      },
    },

    // 7. enable switch
    {
      title: t('pro.col_switch'),
      key: 'switch',
      width: 70,
      render: (_, record) => {
        // The switch shows the operator's newest intent while a toggle is in
        // flight, so a second click is visible immediately instead of the row
        // flicking back to the state the server has not updated yet. Do not use
        // antd's loading prop here: it forces the switch disabled and swallows
        // the rapid reversal the queue exists to preserve. Keep the pending
        // state available to assistive tech without blocking input.
        return (
          <Switch
            size="small"
            checked={resolveEnabled(record)}
            aria-busy={statusQueue.isBusy(record.id)}
            onChange={(checked) => statusQueue.request(record.id, checked)}
          />
        );
      },
    },

    // 8. row actions
    {
      title: t('common.actions'),
      key: 'actions',
      width: 110,
      align: 'right',
      render: (_, record) => (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
          <Tooltip title={t('common.details')}>
            <Button
              size="small"
              icon={<EyeOutlined />}
              onClick={() => handleOpenEdit(record)}
              style={{
                width: 28,
                height: 28,
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'var(--radius-sm, 4px)',
                borderColor: 'var(--border)',
                background: 'var(--surface)',
                color: 'var(--text-muted)',
              }}
            />
          </Tooltip>
          <Tooltip title={t('common.edit')}>
            <Button
              size="small"
              icon={<EditOutlined />}
              onClick={() => handleOpenEdit(record)}
              style={{
                width: 28,
                height: 28,
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'var(--radius-sm, 4px)',
                borderColor: 'var(--border)',
                background: 'var(--surface)',
                color: 'var(--text-muted)',
              }}
            />
          </Tooltip>
          <Popconfirm
            title={t('pro.delete_provider_confirm')}
            onConfirm={() => deleteProviderMutation.mutate(record.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Tooltip title={t('common.delete')}>
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                loading={deleteProviderMutation.isPending && deleteProviderMutation.variables === record.id}
                style={{
                  width: 28,
                  height: 28,
                  padding: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 'var(--radius-sm, 4px)',
                  borderColor: 'var(--border)',
                  background: 'var(--surface)',
                }}
              />
            </Tooltip>
          </Popconfirm>
        </div>
      ),
    },
  ];

  return (
    <div className="terminal-page providers-page">
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('pro.title')}</h1>
          <p className="terminal-subtitle">{t('pro.subtitle')}</p>
        </div>

        <Button
          size="small"
          icon={<SyncOutlined spin={providersFetching} />}
          onClick={() => void refetchProviders()}
        >
          {t('common.refresh')}
        </Button>
      </div>

      <div>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleOpenCreate}
          >
            {t('pro.add_provider')}
          </Button>
        </div>

        {providersError && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            description={`${t('common.save_failed', { msg: providersErr instanceof Error ? providersErr.message : String(providersErr) })}`}
          />
        )}

        <Card>
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
            <Table
              columns={providerColumns}
              dataSource={providers}
              rowKey="id"
              loading={providersLoading}
              pagination={false}
              locale={{ emptyText: t('pro.providers_empty') }}
            />
          </div>
        </Card>
      </div>

      {/* Provider Rich Drawer */}
      <Drawer
        title={
          <div>
            <div style={{ fontSize: 12, color: 'var(--meta)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {editingProvider ? t('common.edit') : t('pro.add_provider')}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--fg)', marginTop: 2 }}>
              {editingProvider
                ? `${t('common.edit')} · ${familyDisplayNames[formFamily] || formFamily}`
                : `${t('pro.add_provider')} · ${familyDisplayNames[formFamily] || formFamily}`}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {t('pro.manage_resource_subtitle', { path: `/ai-providers/${formFamily}` })}
            </div>
          </div>
        }
        open={providerDrawerOpen}
        onClose={handleCloseProviderDrawer}
        size="large"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, padding: '4px 0' }}>
            <Button onClick={handleCloseProviderDrawer}>
              {t('common.cancel')}
            </Button>
            <Button
              type="primary"
              loading={createProviderMutation.isPending || updateProviderMutation.isPending}
              onClick={handleSaveProvider}
            >
              {t('common.save')}
            </Button>
          </div>
        }
      >
        <Form layout="vertical">
          {/* Provider Icon Card */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              marginBottom: 16,
              padding: '12px 14px',
              background: 'var(--surface)',
              borderRadius: 6,
              border: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              onClick={() => {
                setTargetProviderForIcon(null);
                setIconPickerOpen(true);
              }}
              title={t('pro.change_icon')}
            >
              <LobeIcon iconId={formIcon} size={30} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: 'var(--meta)', marginBottom: 2 }}>
                {t('pro.field_icon')}
              </div>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg)' }}>
                {formIcon}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                size="small"
                onClick={() => {
                  setTargetProviderForIcon(null);
                  setIconPickerOpen(true);
                }}
              >
                {t('pro.change_icon')}
              </Button>
              {formIcon !== getProviderDefaultIcon(formFamily, formName, formBaseURL) && (
                <Button
                  size="small"
                  type="link"
                  onClick={() => {
                    setFormIcon(getProviderDefaultIcon(formFamily, formName, formBaseURL));
                    setIconManuallySelected(false);
                  }}
                >
                  {t('pro.reset_icon')}
                </Button>
              )}
            </div>
          </div>

          {/* Driver & Name */}
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label={t('pro.field_family')} required>
                <Select
                  value={formFamily}
                  onChange={(val) => {
                  setFormFamily(val);
                  if (!iconManuallySelected) {
                    setFormIcon(getProviderDefaultIcon(val, formName, formBaseURL));
                  }
                }}
                  disabled={!!editingProvider}
                  options={familyOptions}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label={t('pro.field_name')} required>
                <Input
                  value={formName}
                  onChange={(e) => {
                  const val = e.target.value;
                  setFormName(val);
                  if (!iconManuallySelected) {
                    setFormIcon(getProviderDefaultIcon(formFamily, val, formBaseURL));
                  }
                }}
                  placeholder={t('pro.field_name_ph')}
                />
              </Form.Item>
            </Col>
          </Row>

          {/* Base URL */}
          <Form.Item
            label={
              <span>
                {t('pro.field_base_url')}{' '}
                <span style={{ fontSize: 12, color: 'var(--meta)', fontWeight: 400 }}>
                  · {t('pro.field_base_url_desc')}
                </span>
              </span>
            }
          >
            <Input
              value={formBaseURL}
              onChange={(e) => {
                const val = e.target.value;
                setFormBaseURL(val);
                modelFetchSeqRef.current += 1;
                setEndpointModels([]);
                setIsPullingModels(false);
                if (!iconManuallySelected) {
                  setFormIcon(getProviderDefaultIcon(formFamily, formName, val));
                }
              }}
              placeholder={t('pro.field_base_url_ph')}
            />
          </Form.Item>

          {/* Website: console metadata, deliberately not a CPA field. */}
          <Form.Item
            label={
              <span>
                {t('pro.field_website')}{' '}
                <span style={{ fontSize: 12, color: 'var(--meta)', fontWeight: 400 }}>
                  · {t('pro.field_website_desc')}
                </span>
              </span>
            }
            validateStatus={websiteInputState.status}
            help={websiteInputState.help}
          >
            <Input
              value={formWebsite}
              onChange={(e) => setFormWebsite(e.target.value)}
              placeholder="https://example.com"
              className="config-mono-input"
              allowClear
            />
          </Form.Item>

          {/* Prefix & Priority */}
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label={t('pro.field_prefix')}>
                <Input
                  value={formPrefix}
                  onChange={(e) => setFormPrefix(e.target.value)}
                  placeholder="e.g. prefix"
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label={t('pro.field_priority')}>
                <InputNumber
                  value={formPriority}
                  onChange={(val) => setFormPriority(val)}
                  placeholder="e.g. 1"
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
          </Row>

          {/* Test Model */}
          <Form.Item label={t('pro.field_test_model')}>
            <Select
              value={
                formTestModel === 'auto' || formModels.some((m) => m.name === formTestModel)
                  ? formTestModel
                  : 'auto'
              }
              onChange={setFormTestModel}
              options={[
                {
                  label: formModels[0]?.name
                    ? t('pro.test_auto', { model: formModels[0].name })
                    : t('pro.test_auto_default'),
                  value: 'auto',
                },
                ...formModels
                  .filter((m) => !!m.name.trim())
                  .map((m) => ({
                    label: m.alias ? `${m.name} (${m.alias})` : m.name,
                    value: m.name,
                  })),
              ]}
            />
          </Form.Item>

          {/* Flags: Disabled & Disable Cooling */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ marginBottom: 12 }}>
              <Checkbox
                checked={formDisabled}
                onChange={(e) => setFormDisabled(e.target.checked)}
              >
                <span style={{ fontWeight: 500 }}>{t('pro.field_disabled')}</span>
              </Checkbox>
              <div style={{ fontSize: 12, color: 'var(--meta)', marginLeft: 24, marginTop: 2 }}>
                {t('pro.field_disabled_desc')}
              </div>
            </div>

            <div>
              <Checkbox
                checked={formDisableCooling}
                onChange={(e) => setFormDisableCooling(e.target.checked)}
              >
                <span style={{ fontWeight: 500 }}>{t('pro.field_disable_cooling')}</span>
              </Checkbox>
              <div style={{ fontSize: 12, color: 'var(--meta)', marginLeft: 24, marginTop: 2 }}>
                {t('pro.field_disable_cooling_desc')}
              </div>
            </div>
          </div>

          {/* Section: API Key Entries */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
              marginBottom: 16,
              overflow: 'hidden',
            }}
          >
            {/* Section Header */}
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'pointer',
                userSelect: 'none',
              }}
              onClick={() => setKeysSectionOpen((prev) => !prev)}
            >
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {t('pro.section_keys')}{' '}
                <span style={{ color: 'var(--meta)', fontWeight: 400, marginLeft: 6 }}>
                  {formKeys.length}
                </span>
              </div>
              <div style={{ color: 'var(--meta)', fontSize: 12 }}>
                {keysSectionOpen ? <UpOutlined /> : <DownOutlined />}
              </div>
            </div>

            {keysSectionOpen && (
              <div style={{ padding: '0 16px 16px 16px' }}>
                {/* Top Action Row */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 12,
                  }}
                >
                  <Button
                    style={{ borderStyle: 'dashed' }}
                    icon={<PlusOutlined />}
                    onClick={handleKeyAdd}
                  >
                    {t('pro.add_key_entry')}
                  </Button>
                  <Button onClick={handleTestAllKeys}>
                    {t('pro.test_all')}
                  </Button>
                </div>

                {/* Key Cards List */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {formKeys.map((k, idx) => {
                    const isExpanded = expandedKeyIds.has(k.id);
                    const displayKey = (k.apiKey || '').trim();

                    return (
                      <div
                        key={k.id}
                        style={{
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          background: 'var(--bg)',
                          overflow: 'hidden',
                        }}
                      >
                        {/* Key Item Header */}
                        <div
                          style={{
                            padding: '10px 14px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            cursor: 'pointer',
                            userSelect: 'none',
                          }}
                          onClick={() => toggleKeyExpanded(k.id)}
                        >
                          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg)' }}>
                            {t('pro.key_label', { n: idx + 1 })}
                          </div>

                          <div
                            style={{ display: 'flex', alignItems: 'center', gap: 12 }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {displayKey && (
                              <span
                                title={displayKey}
                                style={{
                                  fontFamily: 'monospace',
                                  fontWeight: 600,
                                  fontSize: 13,
                                  color: 'var(--fg)',
                                  letterSpacing: '0.5px',
                                  maxWidth: 220,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  display: 'inline-block',
                                  verticalAlign: 'middle',
                                }}
                              >
                                {maskKeyText(displayKey)}
                              </span>
                            )}
                            <Button
                              type="link"
                              size="small"
                              style={{ padding: '0 4px', height: 'auto', fontSize: 13 }}
                              onClick={() => handleTestKey(k, idx)}
                            >
                              {t('pro.test_single')}
                            </Button>
                            <span
                              style={{ cursor: 'pointer', color: 'var(--meta)', display: 'inline-flex' }}
                              onClick={() => toggleKeyExpanded(k.id)}
                            >
                              {isExpanded ? <UpOutlined /> : <DownOutlined />}
                            </span>
                            {formKeys.length > 1 && (
                              <Popconfirm
                                title={t('pro.delete_key_confirm')}
                                onConfirm={() => {
                                  setFormKeys((prev) => prev.filter((item) => item.id !== k.id));
                                  setExpandedKeyIds((prev) => {
                                    const next = new Set(prev);
                                    next.delete(k.id);
                                    return next;
                                  });
                                }}
                                okText={t('common.confirm')}
                                cancelText={t('common.cancel')}
                              >
                                <CloseOutlined
                                  style={{
                                    cursor: 'pointer',
                                    color: 'var(--danger)',
                                    fontSize: 12,
                                    marginLeft: 2,
                                  }}
                                />
                              </Popconfirm>
                            )}
                          </div>
                        </div>

                        {/* Key Item Body (when expanded) */}
                        {isExpanded && (
                          <div
                            style={{
                              padding: '14px 16px',
                              borderTop: '1px solid var(--border)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 14,
                            }}
                          >
                            {/* API Key */}
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--fg)' }}>
                                {t('pro.api_key_label')}
                              </div>
                              <Input.Password
                                value={k.apiKey || ''}
                                onChange={(e) =>
                                  setFormKeys((prev) =>
                                    prev.map((item) =>
                                      item.id === k.id ? { ...item, apiKey: e.target.value } : item
                                    )
                                  )
                                }
                                placeholder={t('pro.field_key_ph_create')}
                                style={{ width: '100%' }}
                              />
                            </div>

                            {/* Proxy URL */}
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--fg)' }}>
                                {t('pro.proxy_url_label')}
                              </div>
                              <Input
                                value={k.proxyUrl || ''}
                                onChange={(e) =>
                                  setFormKeys((prev) =>
                                    prev.map((item) =>
                                      item.id === k.id ? { ...item, proxyUrl: e.target.value } : item
                                    )
                                  )
                                }
                                placeholder="http://127.0.0.1:7890"
                                style={{ width: '100%' }}
                              />
                            </div>

                            {/* Schedule Weight */}
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--fg)' }}>
                                {t('pro.weight_label')}
                              </div>
                              <InputNumber
                                value={k.weight ?? 1}
                                onChange={(val) =>
                                  setFormKeys((prev) =>
                                    prev.map((item) =>
                                      item.id === k.id ? { ...item, weight: val ?? 1 } : item
                                    )
                                  )
                                }
                                min={0}
                                max={1000000}
                                style={{ width: '100%' }}
                                placeholder="1"
                              />
                              <div style={{ fontSize: 12, color: 'var(--meta)', marginTop: 4 }}>
                                {t('pro.weight_desc')}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Section: Custom Headers */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
              marginBottom: 16,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'pointer',
                userSelect: 'none',
              }}
              onClick={() => setHeadersSectionOpen((prev) => !prev)}
            >
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {t('pro.section_headers')}{' '}
                {formHeaders.length > 0 && (
                  <span style={{ color: 'var(--meta)', fontWeight: 400, marginLeft: 6 }}>
                    {formHeaders.length}
                  </span>
                )}
              </div>
              <div style={{ color: 'var(--meta)', fontSize: 12 }}>
                {headersSectionOpen ? <UpOutlined /> : <DownOutlined />}
              </div>
            </div>

            {headersSectionOpen && (
              <div style={{ padding: '0 16px 16px 16px' }}>
                {formHeaders.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                    {formHeaders.map((h) => (
                      <div key={h.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Input
                          value={h.key}
                          onChange={(e) =>
                            setFormHeaders((prev) =>
                              prev.map((item) =>
                                item.id === h.id ? { ...item, key: e.target.value } : item
                              )
                            )
                          }
                          placeholder="X-Custom-Header"
                          style={{ flex: 1, fontFamily: 'monospace' }}
                        />
                        <Input
                          value={h.value}
                          onChange={(e) =>
                            setFormHeaders((prev) =>
                              prev.map((item) =>
                                item.id === h.id ? { ...item, value: e.target.value } : item
                              )
                            )
                          }
                          placeholder="value"
                          style={{ flex: 1 }}
                        />
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<CloseOutlined />}
                          onClick={() =>
                            setFormHeaders((prev) => prev.filter((item) => item.id !== h.id))
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
                <Button
                  style={{ borderStyle: 'dashed' }}
                  icon={<PlusOutlined />}
                  onClick={() =>
                    setFormHeaders((prev) => [
                      ...prev,
                      { id: `hdr-${Date.now()}-${formKeys.length}`, key: '', value: '' },
                    ])
                  }
                >
                  {t('pro.add_header_entry')}
                </Button>
              </div>
            )}
          </div>

          {/* Section: Custom Models */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
              marginBottom: 20,
              overflow: 'hidden',
            }}
          >
            {/* Header row */}
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'pointer',
                userSelect: 'none',
              }}
              onClick={() => setModelsSectionOpen((prev) => !prev)}
            >
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {t('pro.section_models')}{' '}
                {formModels.length > 0 && (
                  <span style={{ color: 'var(--meta)', fontWeight: 400, marginLeft: 6 }}>
                    {formModels.length}
                  </span>
                )}
              </div>
              <div style={{ color: 'var(--meta)', fontSize: 12 }}>
                {modelsSectionOpen ? <UpOutlined /> : <DownOutlined />}
              </div>
            </div>

            {modelsSectionOpen && (
              <div style={{ padding: '0 16px 16px 16px' }}>
                {/* Action Row: Fetch model list on right */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 12,
                  }}
                >
                  <div style={{ fontSize: 12, color: 'var(--meta)' }}>
                    {endpointModels.length > 0 && (
                      <span style={{ color: 'var(--accent)', fontWeight: 500 }}>
                        {t('pro.model_list_fetched', { n: endpointModels.length })}
                      </span>
                    )}
                  </div>
                  <Button
                    icon={<SyncOutlined spin={isPullingModels} />}
                    loading={isPullingModels}
                    onClick={handlePullModels}
                  >
                    {endpointModels.length > 0
                      ? t('pro.refresh_model_list')
                      : t('pro.fetch_model_list')}
                  </Button>
                </div>

                {/* Column Titles */}
                {formModels.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      padding: '0 12px 6px 12px',
                      fontSize: 12,
                      color: 'var(--meta)',
                      fontWeight: 500,
                    }}
                  >
                    <div style={{ flex: 1 }}>{t('pro.actual_request_model')}</div>
                    <div style={{ flex: 1 }}>{t('pro.alias_optional')}</div>
                    <div style={{ width: 56 }} />
                  </div>
                )}

                {/* Configured Models List */}
                {formModels.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      marginBottom: 12,
                    }}
                  >
                    {formModels.map((m) => {
                      const isExpanded = expandedModelIds.has(m.id);
                      const otherSelected = new Set(
                        formModels
                          .filter((item) => item.id !== m.id && item.name.trim() !== '')
                          .map((item) => item.name)
                      );
                      // Filtered as the operator types, with models already
                      // configured on this provider suppressed. The list is
                      // pre-filtered rather than left to AutoComplete's own
                      // `filterOption`, whose combobox default is "do not
                      // filter" - the dropdown used to show the whole catalog
                      // no matter what was typed.
                      const modelOptions = modelOptionsFor(
                        endpointModels,
                        m.name,
                        otherSelected,
                      ).map((name) => ({ label: name, value: name }));

                      return (
                        <div
                          key={m.id}
                          id={`model-card-${m.id}`}
                          style={{
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            background: 'var(--bg)',
                            overflow: 'hidden',
                            scrollMarginBottom: 24,
                          }}
                        >
                          {/* Model Card Header */}
                          <div
                            style={{
                              padding: '10px 12px',
                              display: 'flex',
                              gap: 8,
                              alignItems: 'center',
                              background: 'rgba(255, 255, 255, 0.02)',
                            }}
                          >
                            <AutoComplete
                              value={m.name}
                              options={modelOptions}
                              // The options are already narrowed by the typed
                              // text above, so the popup must not apply a second,
                              // differently-scoped filter on top of them. Stated
                              // explicitly rather than left to the combobox
                              // default, which is what silently made this
                              // dropdown unfiltered in the first place.
                              showSearch={{ filterOption: false }}
                              onSelect={(val) => {
                                setFormModels((prev) =>
                                  prev.map((item) =>
                                    item.id === m.id
                                      ? {
                                          ...item,
                                          name: val,
                                          alias: item.alias.trim() ? item.alias : val,
                                        }
                                      : item
                                  )
                                );
                              }}
                              onChange={(val) => {
                                setFormModels((prev) =>
                                  prev.map((item) =>
                                    item.id === m.id ? { ...item, name: val } : item
                                  )
                                );
                              }}
                              style={{ flex: 1 }}
                            >
                              <Input
                                placeholder={t('pro.actual_request_model')}
                                suffix={
                                  endpointModels.length > 0 ? (
                                    <DownOutlined
                                      style={{ fontSize: 11, color: 'var(--meta)' }}
                                    />
                                  ) : undefined
                                }
                                style={{ fontFamily: 'monospace' }}
                              />
                            </AutoComplete>
                            <Input
                              value={m.alias}
                              onChange={(e) =>
                                setFormModels((prev) =>
                                  prev.map((item) =>
                                    item.id === m.id ? { ...item, alias: e.target.value } : item
                                  )
                                )
                              }
                              placeholder={t('pro.alias_optional')}
                              style={{ flex: 1 }}
                            />
                            <Button
                              type="text"
                              size="small"
                              icon={isExpanded ? <UpOutlined /> : <DownOutlined />}
                              onClick={() => toggleModelExpanded(m.id)}
                            />
                            <Button
                              size="small"
                              type="text"
                              danger
                              icon={<CloseOutlined />}
                              onClick={() => {
                                setFormModels((prev) => prev.filter((item) => item.id !== m.id));
                                setExpandedModelIds((prev) => {
                                  const next = new Set(prev);
                                  next.delete(m.id);
                                  return next;
                                });
                              }}
                            />
                          </div>

                          {/* Model Card Body (expanded) */}
                          {isExpanded && (
                            <div
                              style={{
                                padding: '14px 16px',
                                borderTop: '1px solid var(--border)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 14,
                              }}
                            >
                              {/* Option: Allow Image Endpoint */}
                              <div>
                                <Checkbox
                                  checked={m.image || false}
                                  onChange={(e) => updateModelImage(m.id, e.target.checked)}
                                >
                                  <span style={{ fontWeight: 500 }}>
                                    {t('pro.allow_image_endpoint')}
                                  </span>
                                </Checkbox>
                                <div
                                  style={{
                                    fontSize: 12,
                                    color: 'var(--meta)',
                                    marginLeft: 24,
                                    marginTop: 2,
                                  }}
                                >
                                  {t('pro.allow_image_endpoint_desc')}
                                </div>
                              </div>

                              {/* Option: Allowed Thinking Levels */}
                              <div>
                                <div
                                  style={{
                                    fontWeight: 500,
                                    fontSize: 13,
                                    marginBottom: 8,
                                    color: 'var(--fg)',
                                  }}
                                >
                                  {t('pro.allowed_thinking_levels')}
                                </div>
                                <Row gutter={[10, 10]}>
                                  {THINKING_LEVEL_OPTIONS.map((opt) => {
                                    const isChecked =
                                      m.thinking?.levels?.includes(opt.value) || false;
                                    return (
                                      <Col xs={24} sm={12} key={opt.value}>
                                        <div
                                          role="button"
                                          tabIndex={0}
                                          onClick={() => toggleThinkingLevel(m.id, opt.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === ' ' || e.key === 'Enter') {
                                              e.preventDefault();
                                              toggleThinkingLevel(m.id, opt.value);
                                            }
                                          }}
                                          style={{
                                            border: isChecked
                                              ? '1px solid var(--accent, #1677ff)'
                                              : '1px solid var(--border)',
                                            borderRadius: 6,
                                            padding: '8px 12px',
                                            background: isChecked
                                              ? 'rgba(22, 119, 255, 0.08)'
                                              : 'var(--surface)',
                                            cursor: 'pointer',
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            transition: 'border-color var(--motion-fast), background var(--motion-fast)',
                                            userSelect: 'none',
                                          }}
                                        >
                                          <Checkbox
                                            checked={isChecked}
                                            tabIndex={-1}
                                            style={{ pointerEvents: 'none' }}
                                          >
                                            <span style={{ fontWeight: isChecked ? 600 : 400 }}>
                                              {t(opt.labelKey)}
                                            </span>
                                          </Checkbox>
                                          <span
                                            style={{
                                              fontSize: 11,
                                              fontFamily: 'monospace',
                                              color: 'var(--meta)',
                                            }}
                                          >
                                            {opt.value}
                                          </span>
                                        </div>
                                      </Col>
                                    );
                                  })}
                                </Row>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <Button
                  style={{ borderStyle: 'dashed' }}
                  icon={<PlusOutlined />}
                  onClick={handleAddModel}
                >
                  {t('pro.add_model_entry')}
                </Button>
              </div>
            )}
          </div>
        </Form>
      </Drawer>

      {/* LobeHub Icon Picker Modal */}
      <IconPickerModal
        open={iconPickerOpen}
        currentIcon={
          targetProviderForIcon
            ? resolveProviderIcon(
                providerIcons,
                targetProviderForIcon,
                getProviderDefaultIcon(
                  targetProviderForIcon.family,
                  targetProviderForIcon.name,
                  targetProviderForIcon.base_url,
                ),
              )
            : formIcon
        }
        onSelect={handleSelectIcon}
        onClose={() => {
          setIconPickerOpen(false);
          setTargetProviderForIcon(null);
        }}
      />
    </div>
  );
};
