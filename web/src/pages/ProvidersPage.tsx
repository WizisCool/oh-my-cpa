import React, { useState, useMemo } from 'react';
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
  Modal,
  Tooltip,
  Tabs,
  Popconfirm,
  Form,
  Select,
  Row,
  Col,
  App as AntdApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  SyncOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  CopyOutlined,
  KeyOutlined,
  ThunderboltOutlined,
  CloudServerOutlined,
  CloseOutlined,
  UpOutlined,
  DownOutlined,
  DownloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT } from '../i18n';
import { usePreference } from '../hooks/usePreference';
import { LobeIcon, getProviderDefaultIcon } from '../components/LobeIcon';
import { IconPickerModal } from '../components/IconPickerModal';
import type {
  ClientAPIKeyItem,
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


interface FormKeyItem {
  id: string;
  masked?: string;
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

  const [activeTab, setActiveTab] = useState<'providers' | 'keys'>('providers');

  // Provider Drawer state
  const [providerDrawerOpen, setProviderDrawerOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<ProviderItem | null>(null);
  const [formFamily, setFormFamily] = useState<string>('openai-compatibility');
  const [formName, setFormName] = useState<string>('');
  const [formBaseURL, setFormBaseURL] = useState<string>('');
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
    'provider_icons',
    {},
    (raw) => (typeof raw === 'object' && raw ? (raw as Record<string, string>) : {}),
  );
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [targetProviderForIcon, setTargetProviderForIcon] = useState<ProviderItem | null>(null);
  const [formIcon, setFormIcon] = useState<string>('OpenAI');
  const [iconManuallySelected, setIconManuallySelected] = useState<boolean>(false);

  // Endpoint models pull state & custom models expand state
  const [pullPanelOpen, setPullPanelOpen] = useState(false);
  const [isPullingModels, setIsPullingModels] = useState(false);
  const [endpointModels, setEndpointModels] = useState<string[]>([]);
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const [selectedEndpointModels, setSelectedEndpointModels] = useState<Set<string>>(new Set());
  const [expandedModelIds, setExpandedModelIds] = useState<Set<string>>(new Set());

  const filteredEndpointModels = useMemo(() => {
    const q = modelSearchQuery.trim().toLowerCase();
    if (!q) return endpointModels;
    return endpointModels.filter((m) => m.toLowerCase().includes(q));
  }, [endpointModels, modelSearchQuery]);

  const selectableModels = useMemo(() => {
    return filteredEndpointModels.filter((m) => !formModels.some((item) => item.name === m));
  }, [filteredEndpointModels, formModels]);

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

    setIsPullingModels(true);
    try {
      const res = await api.pullProviderModels({
        provider_id: editingProvider ? editingProvider.id : undefined,
        base_url: rawUrl,
        api_key: firstKey,
        proxy_url: firstProxy,
        headers: headersPayload,
      });
      setEndpointModels(res.models || []);
      setSelectedEndpointModels(new Set());
      if (res.models && res.models.length > 0) {
        message.success(t('pro.pull_models_success', { count: res.models.length }));
      } else {
        message.info(t('pro.pull_models_empty'));
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    } finally {
      setIsPullingModels(false);
    }
  };

  const handleOpenPullPanel = () => {
    setPullPanelOpen(true);
    if (endpointModels.length === 0) {
      void handlePullModels();
    }
  };

  const handleApplySelectedModels = () => {
    if (selectedEndpointModels.size === 0) return;
    const newItems: FormModelItem[] = [];
    for (const mName of selectedEndpointModels) {
      if (!formModels.some((item) => item.name === mName)) {
        newItems.push({
          id: `mdl-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: mName,
          alias: '',
          image: false,
          thinking: { levels: [] },
        });
      }
    }
    setFormModels((prev) => [...prev, ...newItems]);
    message.success(t('pro.models_applied', { count: newItems.length }));
    setSelectedEndpointModels(new Set());
    setPullPanelOpen(false);
  };

  const toggleModelExpanded = (id: string) => {
    setExpandedModelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
      setProviderIcons({
        ...providerIcons,
        [targetProviderForIcon.id]: selectedIconId,
        [targetProviderForIcon.name]: selectedIconId,
      });
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
    if (!k.masked && (!k.apiKey || !k.apiKey.trim())) {
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
    const hasAny = formKeys.some((k) => k.masked || (k.apiKey && k.apiKey.trim() !== ''));
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

  function maskPreview(key?: string, masked?: string): string {
    if (masked) return masked;
    if (!key) return '';
    const trimmed = key.trim();
    if (!trimmed) return '';
    if (trimmed.length <= 8) return '••••••••';
    const prefix = trimmed.slice(0, 2);
    const suffix = trimmed.slice(-2);
    return `${prefix}******${suffix}`;
  }

  // ── 1. Providers Query & Mutations ────────────────────────────────────────
  const {
    data: providersData,
    isLoading: providersLoading,
    isFetching: providersFetching,
    isError: providersError,
    error: providersErr,
    refetch: refetchProviders,
  } = useQuery({
    queryKey: ['management-providers'],
    queryFn: api.getManagementProviders,
    staleTime: 30000,
  });

  const providers = providersData?.providers || [];

  const statusMutation = useMutation({
    mutationFn: ({ family, index, disabled }: { family: string; index: number; disabled: boolean }) =>
      api.patchManagementProviderStatus(family, index, disabled),
    onSuccess: () => {
      message.success(t('pro.status_updated'));
      void queryClient.invalidateQueries({ queryKey: ['management-providers'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const createProviderMutation = useMutation({
    mutationFn: (payload: SaveProviderPayload) => api.createManagementProvider(payload),
    onSuccess: () => {
      message.success(t('pro.provider_created'));
      setProviderDrawerOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['management-providers'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const updateProviderMutation = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: SaveProviderPayload }) =>
      api.updateManagementProvider(id, payload),
    onSuccess: () => {
      message.success(t('pro.provider_updated'));
      setProviderDrawerOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['management-providers'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const deleteProviderMutation = useMutation({
    mutationFn: (id: string) => api.deleteManagementProvider(id),
    onSuccess: () => {
      message.success(t('pro.provider_deleted'));
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
    setFormModels([]);
    setEndpointModels([]);
    setSelectedEndpointModels(new Set());
    setPullPanelOpen(false);
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
    setFormPrefix(provider.prefix || '');
    setFormPriority(provider.priority != null ? provider.priority : null);
    setFormDisabled(provider.disabled);
    setFormDisableCooling(Boolean(provider.disable_cooling));

    setFormTestModel('auto');
    const existingIcon =
      providerIcons[provider.id] ||
      providerIcons[provider.name] ||
      getProviderDefaultIcon(provider.family, provider.name, provider.base_url);
    setFormIcon(existingIcon);
    setIconManuallySelected(Boolean(providerIcons[provider.id] || providerIcons[provider.name]));
    // Populate keys
    if (provider.key_entries && provider.key_entries.length > 0) {
      setFormKeys(
        provider.key_entries.map((k, i) => ({
          id: `key-edit-${i}`,
          masked: k.masked,
          proxyUrl: k.proxy_url,
          weight: k.weight ?? 1,
          isChanging: false,
        }))
      );
      setExpandedKeyIds(new Set());
    } else if (provider.key_masked) {
      setFormKeys([
        {
          id: 'key-edit-0',
          masked: provider.key_masked,
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
    setEndpointModels([]);
    setSelectedEndpointModels(new Set());
    setPullPanelOpen(false);
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
      prefix: formPrefix.trim(),
      priority: formPriority != null ? formPriority : undefined,
      disable_cooling: formDisableCooling,
      disabled: formDisabled,
      keys: keysPayload,
      model_entries: modelsPayload,
      headers: headersPayload,
    };

    if (editingProvider) {
      updateProviderMutation.mutate({ id: editingProvider.id, payload });
      setProviderIcons({
        ...providerIcons,
        [editingProvider.id]: formIcon,
        [formName.trim()]: formIcon,
      });
    } else {
      createProviderMutation.mutate(payload);
      setProviderIcons({
        ...providerIcons,
        [formName.trim()]: formIcon,
      });
    }
  };

  // ── 2. Client API Keys ────────────────────────────────────────────────────
  const {
    data: keysData,
    isLoading: keysLoading,
    isFetching: keysFetching,
    isError: keysError,
    error: keysErr,
    refetch: refetchKeys,
  } = useQuery({
    queryKey: ['management-client-api-keys'],
    queryFn: api.getClientAPIKeys,
    staleTime: 30000,
  });

  const keys = keysData?.keys || [];

  const [addKeyModalOpen, setAddKeyModalOpen] = useState(false);
  const [newKeyInput, setNewKeyInput] = useState('');
  const [createdKeyPlaintext, setCreatedKeyPlaintext] = useState<string | null>(null);

  const createKeyMutation = useMutation({
    mutationFn: (key: string) => api.createClientAPIKey(key),
    onSuccess: () => {
      message.success(t('pro.key_created'));
      setCreatedKeyPlaintext(newKeyInput);
      setNewKeyInput('');
      setAddKeyModalOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['management-client-api-keys'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const deleteKeyMutation = useMutation({
    mutationFn: (index: number) => api.deleteClientAPIKey(index),
    onSuccess: () => {
      message.success(t('pro.key_deleted'));
      void queryClient.invalidateQueries({ queryKey: ['management-client-api-keys'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.message : String(err);
      message.error(msg);
    },
  });

  const handleGenerateRandomKey = () => {
    const array = new Uint8Array(24);
    crypto.getRandomValues(array);
    const randomHex = Array.from(array, (b) => b.toString(16).padStart(2, '0')).join('');
    setNewKeyInput(`omc-sk-${randomHex}`);
  };

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      message.success(t('res.copied'));
    });
  };

  const familyDisplayNames: Record<string, string> = {
    'openai-compatibility': 'OpenAI 兼容',
    'codex': 'Codex / Responses',
    'claude': 'Anthropic Claude',
    'gemini': 'Google Gemini',
  };

  // Columns for Providers
  // Columns for Providers (matching CPAMC specifications)
  const providerColumns: ColumnsType<ProviderItem> = [
    // 1. 图标+显示名称
    {
      title: t('pro.col_provider'),
      key: 'name',
      render: (_, record) => {
        const iconId =
          providerIcons[record.id] ||
          providerIcons[record.name] ||
          getProviderDefaultIcon(record.family, record.name, record.base_url);
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
                transition: 'all 0.15s ease',
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
                {record.name}
              </div>
              {record.key_masked && (
                <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--meta)', marginTop: 2 }}>
                  {record.key_masked}
                </div>
              )}
            </div>
          </div>
        );
      },
    },

    // 2. 协议驱动
    {
      title: t('pro.col_protocol'),
      key: 'protocol',
      render: (_, record) => (
        <Tag color="blue" style={{ margin: 0 }}>
          {familyDisplayNames[record.family] || record.protocol || record.family}
        </Tag>
      ),
    },

    // 3. 服务地址 (过长自动截断)
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

    // 4. 前缀 (没有则显无)
    {
      title: t('pro.field_prefix'),
      key: 'prefix',
      render: (_, record) =>
        record.prefix ? (
          <Tag color="geekblue" style={{ fontFamily: 'monospace', margin: 0 }}>
            {record.prefix}
          </Tag>
        ) : (
          <span style={{ color: 'var(--meta)', fontSize: 13 }}>{t('pro.none_text')}</span>
        ),
    },

    // 5. 模型/请求头
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
                    borderRadius: 12,
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
                  borderRadius: 12,
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
                  borderRadius: 12,
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

    // 6. 状态
    {
      title: t('pro.col_status'),
      key: 'status',
      render: (_, record) =>
        record.disabled ? (
          <Tag color="warning" style={{ borderRadius: 4, padding: '2px 8px', margin: 0 }}>
            ⚠ {t('pro.status_disabled')}
          </Tag>
        ) : (
          <Tag color="success" style={{ borderRadius: 4, padding: '2px 8px', margin: 0 }}>
            {t('pro.status_active')}
          </Tag>
        ),
    },

    // 7. 开关
    {
      title: t('pro.col_switch'),
      key: 'switch',
      width: 70,
      render: (_, record) => (
        <Switch
          size="small"
          checked={!record.disabled}
          disabled={statusMutation.isPending}
          onChange={(checked) => {
            const idx = parseInt(record.id.split('-').pop() || '0', 10);
            statusMutation.mutate({ family: record.family, index: idx, disabled: !checked });
          }}
        />
      ),
    },

    // 8. 操作
    {
      title: t('common.actions'),
      key: 'actions',
      width: 100,
      align: 'right',
      render: (_, record) => (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4 }}>
          <Button
            size="small"
            type="text"
            icon={<EyeOutlined />}
            title={t('common.details')}
            onClick={() => handleOpenEdit(record)}
          />
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            title={t('common.edit')}
            onClick={() => handleOpenEdit(record)}
          />
          <Popconfirm
            title={t('pro.delete_provider_confirm')}
            onConfirm={() => deleteProviderMutation.mutate(record.id)}
            okText={t('common.confirm')}
            cancelText={t('common.cancel')}
          >
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              title={t('common.delete')}
              loading={deleteProviderMutation.isPending && deleteProviderMutation.variables === record.id}
            />
          </Popconfirm>
        </div>
      ),
    },
  ];

    // Client Key Columns
  const keyColumns: ColumnsType<ClientAPIKeyItem> = [
    {
      title: '#',
      key: 'index',
      width: 60,
      render: (_, r) => <span className="mono-num">#{r.index + 1}</span>,
    },
    {
      title: t('pro.col_key'),
      key: 'masked',
      render: (_, r) => <span className="mono-num" style={{ fontWeight: 600 }}>{r.masked}</span>,
    },
    {
      title: 'Fingerprint (HMAC)',
      key: 'fingerprint',
      render: (_, r) => (
        <span className="mono-num" style={{ fontSize: 11, color: 'var(--meta)' }}>
          {r.fingerprint}
        </span>
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 120,
      align: 'right',
      render: (_, r) => (
        <Popconfirm
          title={t('pro.delete_key_confirm')}
          onConfirm={() => deleteKeyMutation.mutate(r.index)}
          okText={t('common.confirm')}
          cancelText={t('common.cancel')}
        >
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            loading={deleteKeyMutation.isPending}
          />
        </Popconfirm>
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
          icon={<SyncOutlined spin={activeTab === 'providers' ? providersFetching : keysFetching} />}
          onClick={() => {
            if (activeTab === 'providers') void refetchProviders();
            else void refetchKeys();
          }}
        >
          {t('common.refresh')}
        </Button>
      </div>

      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'providers' | 'keys')}
        items={[
          {
            key: 'providers',
            label: (
              <span>
                <CloudServerOutlined style={{ marginRight: 6 }} />
                {t('pro.tab_providers')} ({providers.length})
              </span>
            ),
            children: (
              <div>
                <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-start' }}>
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
            ),
          },
          {
            key: 'keys',
            label: (
              <span>
                <KeyOutlined style={{ marginRight: 6 }} />
                {t('pro.tab_keys')} ({keys.length})
              </span>
            ),
            children: (
              <div>
                {keysError && (
                  <Alert
                    type="error"
                    showIcon
                    style={{ marginBottom: 16 }}
                    description={`${t('common.save_failed', { msg: keysErr instanceof Error ? keysErr.message : String(keysErr) })}`}
                  />
                )}

                <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={() => {
                      setNewKeyInput('');
                      setAddKeyModalOpen(true);
                    }}
                  >
                    {t('pro.add_key')}
                  </Button>
                </div>

                <Card>
                  <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                    <Table
                      columns={keyColumns}
                      dataSource={keys}
                      rowKey="index"
                      loading={keysLoading}
                      pagination={false}
                      locale={{ emptyText: t('pro.keys_empty') }}
                    />
                  </div>
                </Card>
              </div>
            ),
          },
        ]}
      />

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
        onClose={() => setProviderDrawerOpen(false)}
        size="large"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, padding: '4px 0' }}>
            <Button onClick={() => setProviderDrawerOpen(false)}>
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
                  options={[
                    { label: 'OpenAI 兼容 (openai-compatibility)', value: 'openai-compatibility' },
                    { label: 'Codex / Responses (codex)', value: 'codex' },
                    { label: 'Anthropic Claude (claude)', value: 'claude' },
                    { label: 'Google Gemini (gemini)', value: 'gemini' },
                  ]}
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
                if (!iconManuallySelected) {
                  setFormIcon(getProviderDefaultIcon(formFamily, formName, val));
                }
              }}
              placeholder={t('pro.field_base_url_ph')}
            />
          </Form.Item>

          {/* Prefix & Priority */}
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label={t('pro.field_prefix')}>
                <Input
                  value={formPrefix}
                  onChange={(e) => setFormPrefix(e.target.value)}
                  placeholder="e.g. glm"
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
              value={formTestModel}
              onChange={setFormTestModel}
              options={[
                {
                  label: t('pro.test_auto', {
                    model:
                      formModels[0]?.name ||
                      (formFamily === 'openai-compatibility' ? 'glm-5.3-flash' : 'default'),
                  }),
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
                    const displayMasked = maskPreview(k.apiKey, k.masked);

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
                            {displayMasked && (
                              <span
                                style={{
                                  fontFamily: 'monospace',
                                  fontWeight: 600,
                                  fontSize: 13,
                                  color: 'var(--fg)',
                                  letterSpacing: '0.5px',
                                }}
                              >
                                {displayMasked}
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
                                    color: '#ff4d4f',
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
                                placeholder={k.masked ? t('pro.key_ph_no_change') : t('pro.field_key_ph_create')}
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
                {/* Action Row: Pull from endpoint on right */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    marginBottom: 12,
                  }}
                >
                  <Button
                    icon={<DownloadOutlined />}
                    onClick={handleOpenPullPanel}
                  >
                    {t('pro.pull_from_endpoint')}
                  </Button>
                </div>

                {/* Endpoint Pull Panel (Card) */}
                {pullPanelOpen && (
                  <div
                    style={{
                      border: '1px solid var(--border)',
                      borderRadius: 6,
                      background: 'var(--bg)',
                      padding: 14,
                      marginBottom: 14,
                    }}
                  >
                    {/* Search & Reload */}
                    <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                      <Input
                        prefix={<SearchOutlined style={{ color: 'var(--meta)' }} />}
                        placeholder={t('pro.search_models')}
                        value={modelSearchQuery}
                        onChange={(e) => setModelSearchQuery(e.target.value)}
                        allowClear
                        style={{ flex: 1 }}
                      />
                      <Button
                        icon={<SyncOutlined spin={isPullingModels} />}
                        onClick={handlePullModels}
                        loading={isPullingModels}
                      >
                        {t('pro.reload')}
                      </Button>
                    </div>

                    {/* Select All & Counter */}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '4px 2px 8px 2px',
                        borderBottom: '1px solid var(--border)',
                        marginBottom: 8,
                      }}
                    >
                      <Checkbox
                        checked={
                          selectableModels.length > 0 &&
                          selectableModels.every((m) => selectedEndpointModels.has(m))
                        }
                        indeterminate={
                          selectableModels.some((m) => selectedEndpointModels.has(m)) &&
                          !selectableModels.every((m) => selectedEndpointModels.has(m))
                        }
                        disabled={selectableModels.length === 0}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedEndpointModels(new Set(selectableModels));
                          } else {
                            setSelectedEndpointModels(new Set());
                          }
                        }}
                      >
                        <span style={{ fontSize: 13 }}>{t('pro.select_all')}</span>
                      </Checkbox>
                      <span style={{ fontSize: 12, color: 'var(--meta)' }}>
                        {selectedEndpointModels.size} / {filteredEndpointModels.length}
                      </span>
                    </div>

                    {/* Endpoint Models List */}
                    <div
                      style={{
                        maxHeight: 220,
                        overflowY: 'auto',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      {filteredEndpointModels.length === 0 ? (
                        <div
                          style={{
                            textAlign: 'center',
                            color: 'var(--meta)',
                            padding: '20px 0',
                            fontSize: 13,
                          }}
                        >
                          {isPullingModels ? t('common.loading') : t('pro.pull_models_empty')}
                        </div>
                      ) : (
                        filteredEndpointModels.map((mName) => {
                          const isAlreadyAdded = formModels.some((item) => item.name === mName);
                          const isChecked = selectedEndpointModels.has(mName);

                          return (
                            <div
                              key={mName}
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                padding: '8px 10px',
                                background: 'var(--surface)',
                                borderRadius: 4,
                                border: '1px solid var(--border)',
                              }}
                            >
                              {isAlreadyAdded ? (
                                <>
                                  <span
                                    style={{
                                      fontFamily: 'monospace',
                                      fontSize: 13,
                                      color: 'var(--fg)',
                                    }}
                                  >
                                    {mName}
                                  </span>
                                  <Tag style={{ margin: 0, fontSize: 11 }}>
                                    {t('pro.model_added')}
                                  </Tag>
                                </>
                              ) : (
                                <Checkbox
                                  checked={isChecked}
                                  onChange={() => {
                                    setSelectedEndpointModels((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(mName)) next.delete(mName);
                                      else next.add(mName);
                                      return next;
                                    });
                                  }}
                                  style={{ width: '100%' }}
                                >
                                  <span style={{ fontFamily: 'monospace', fontSize: 13 }}>
                                    {mName}
                                  </span>
                                </Checkbox>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>

                    {/* Action buttons */}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'flex-end',
                        gap: 8,
                        marginTop: 12,
                      }}
                    >
                      <Button onClick={() => setPullPanelOpen(false)}>
                        {t('common.close')}
                      </Button>
                      <Button
                        type="primary"
                        disabled={selectedEndpointModels.size === 0}
                        onClick={handleApplySelectedModels}
                      >
                        {t('pro.apply_models', { n: selectedEndpointModels.size })}
                      </Button>
                    </div>
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

                      return (
                        <div
                          key={m.id}
                          style={{
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            background: 'var(--bg)',
                            overflow: 'hidden',
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
                            <Input
                              value={m.name}
                              onChange={(e) =>
                                setFormModels((prev) =>
                                  prev.map((item) =>
                                    item.id === m.id ? { ...item, name: e.target.value } : item
                                  )
                                )
                              }
                              placeholder={t('pro.model_name')}
                              style={{ flex: 1, fontFamily: 'monospace' }}
                            />
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
                                          onClick={() => toggleThinkingLevel(m.id, opt.value)}
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
                                            transition: 'all 0.15s ease',
                                            userSelect: 'none',
                                          }}
                                        >
                                          <Checkbox
                                            checked={isChecked}
                                            onChange={(e) => {
                                              e.stopPropagation();
                                              toggleThinkingLevel(m.id, opt.value);
                                            }}
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
                  onClick={() => {
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
                  }}
                >
                  {t('pro.add_model_entry')}
                </Button>
              </div>
            )}
          </div>
        </Form>
      </Drawer>

      {/* Add Client Key Modal */}
      <Modal
        title={t('pro.add_key_title')}
        open={addKeyModalOpen}
        onCancel={() => setAddKeyModalOpen(false)}
        onOk={() => createKeyMutation.mutate(newKeyInput)}
        confirmLoading={createKeyMutation.isPending}
        okButtonProps={{ disabled: !newKeyInput.trim() }}
        okText={t('common.confirm')}
        cancelText={t('common.cancel')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
          <Input
            value={newKeyInput}
            onChange={(e) => setNewKeyInput(e.target.value)}
            placeholder={t('pro.key_placeholder')}
          />
          <div>
            <Button
              icon={<ThunderboltOutlined />}
              onClick={handleGenerateRandomKey}
            >
              {t('pro.generate_key')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Single-view Key Display Modal */}
      <Modal
        title={t('pro.key_created_title')}
        open={!!createdKeyPlaintext}
        onOk={() => setCreatedKeyPlaintext(null)}
        onCancel={() => setCreatedKeyPlaintext(null)}
        okText={t('common.confirm')}
        cancelButtonProps={{ style: { display: 'none' } }}
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16, marginTop: 12 }}
          description={t('pro.key_created_desc')}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Input
            readOnly
            value={createdKeyPlaintext || ''}
            style={{ fontFamily: 'monospace', fontWeight: 600 }}
          />
          <Button
            icon={<CopyOutlined />}
            onClick={() => handleCopy(createdKeyPlaintext || '')}
          />
        </div>
      </Modal>
      {/* LobeHub Icon Picker Modal */}
      <IconPickerModal
        open={iconPickerOpen}
        currentIcon={
          targetProviderForIcon
            ? providerIcons[targetProviderForIcon.id] ||
              providerIcons[targetProviderForIcon.name] ||
              getProviderDefaultIcon(
                targetProviderForIcon.family,
                targetProviderForIcon.name,
                targetProviderForIcon.base_url,
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
