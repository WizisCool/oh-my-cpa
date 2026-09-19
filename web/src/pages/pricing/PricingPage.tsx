import React from 'react';
import { Alert, App as AntdApp, Button, Empty, Form, Input, InputNumber, Modal, Pagination, Popconfirm, Select, Spin, Table, Tooltip } from 'antd';
import {
  ReloadOutlined,
  SyncOutlined,
  PlusOutlined,
  EditOutlined,
  DeleteOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import type { ModelPrice } from '../../types/pricing';
import { PricingLeaderboard } from './PricingLeaderboard';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { useIsPhoneViewport } from '../../hooks/useIsPhoneViewport';
import { PhoneRow } from '../../components/common/PhoneRow';
import { phoneRowFields, renderedCell } from '../../components/common/phoneRowFields';

/** One page of the price list, shared by both renderings so a page means the same thing at
 *  either width. */
const PAGE_SIZE = 50;
import styles from './PricingPage.module.css';

/** Per-1M rates share one cell format: plain number with up to 6 decimal places. */
function formatRate(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

/** Form values for the manual price editor; every rate is USD per 1M tokens. */
interface PriceFormValues {
  model: string;
  prompt?: number | string;
  completion?: number | string;
  cacheRead?: number | string;
  cacheWrite?: number | string;
  multiplier?: number | string;
}

interface EditorState {
  open: boolean;
  editing: ModelPrice | null;
}

const CLOSED_EDITOR: EditorState = { open: false, editing: null };
type FilterTabKey = 'all' | 'modelsdev' | 'manual' | 'unpriced';

export const PricingPage: React.FC = () => {
  const t = useT();
  const isDemo = isDemoMode();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState('');
  const [activeTab, setActiveTab] = React.useState<FilterTabKey>('all');
  const [editor, setEditor] = React.useState<EditorState>(CLOSED_EDITOR);
  useOverlayHistory({ isOpen: editor.open, onClose: () => setEditor(CLOSED_EDITOR) });
  const [form] = Form.useForm<PriceFormValues>();

  const watchedPrompt = Number(Form.useWatch('prompt', form) ?? 0) || 0;
  const watchedCompletion = Number(Form.useWatch('completion', form) ?? 0) || 0;
  const watchedMultiplier = Number(Form.useWatch('multiplier', form) ?? 1) || 1;

  const result = useQuery({
    queryKey: ['pricing'],
    queryFn: api.getPricing,
    staleTime: 30_000,
    refetchInterval: (query) => (query.state.data?.sync.running ? 2_500 : false),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['pricing'] });
  };

  const saveMutation = useMutation({
    // `updated_at_ms` is omitted rather than sent: the server stamps its own clock
    // on every write, so a value from the browser would be ignored anyway and is
    // better not transmitted at all.
    mutationFn: async (rows: Array<Omit<ModelPrice, 'updated_at_ms'>>) => {
      await api.updatePricingModels({ models: rows });
    },
    onSuccess: () => {
      message.success(t('pricing.saved'));
      setEditor(CLOSED_EDITOR);
      form.resetFields();
      invalidate();
    },
    onError: (err) => {
      message.error(t('pricing.save_failed', { msg: err instanceof ApiError ? err.message : String(err) }));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (model: string) => api.deletePricingModel(model),
    onSuccess: invalidate,
    onError: (err) => {
      message.error(t('pricing.delete_failed', { msg: err instanceof ApiError ? err.message : String(err) }));
    },
  });

  const syncMutation = useMutation({
    mutationFn: () => api.startPricingSync(),
    onSuccess: () => {
      message.info(t('pricing.sync_started'));
      invalidate();
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        message.info(t('pricing.sync_conflict'));
        invalidate();
      } else {
        message.error(t('pricing.sync_failed', { msg: err instanceof ApiError ? err.message : String(err) }));
      }
    },
  });

  const updateScheduleMutation = useMutation({
    mutationFn: (intervalHours: number) => api.updatePricingSyncSchedule(intervalHours),
    onSuccess: () => {
      message.success(t('pricing.sync.schedule_updated'));
      invalidate();
    },
    onError: (err) => {
      message.error(err instanceof ApiError ? err.message : String(err));
    },
  });

  const models = result.data?.models ?? [];
  const unpricedList = result.data?.unpriced ?? [];
  const availableModels = React.useMemo(
    () => [...new Set([...models.map((row) => row.model), ...unpricedList])].sort(),
    [models, unpricedList],
  );
  const sync = result.data?.sync;
  const state = sync?.state;

  const modelsDevCount = models.filter((m) => m.source === 'modelsdev').length;
  const manualCount = models.filter((m) => m.source === 'manual').length;
  const unpricedCount = unpricedList.length;

  const openAdd = (model = '') => {
    form.setFieldsValue({
      model,
      prompt: undefined,
      completion: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
      multiplier: 1,
    });
    setEditor({ open: true, editing: null });
  };

  const openEdit = (row: ModelPrice) => {
    form.setFieldsValue({
      model: row.model,
      prompt: row.prompt_price_per_1m,
      completion: row.completion_price_per_1m,
      cacheRead: row.cache_read_price_per_1m,
      cacheWrite: row.cache_write_price_per_1m,
      multiplier: row.price_multiplier,
    });
    setEditor({ open: true, editing: row });
  };

  const submitEditor = () => {
    void form
      .validateFields()
      .then((values) => {
        const parseRate = (val: unknown) => {
          if (val === undefined || val === null || val === '') return 0;
          const num = Number(val);
          return Number.isFinite(num) && num >= 0 ? num : 0;
        };
        const row: Omit<ModelPrice, 'updated_at_ms'> = {
          model: values.model.trim(),
          prompt_price_per_1m: parseRate(values.prompt),
          completion_price_per_1m: parseRate(values.completion),
          cache_read_price_per_1m: parseRate(values.cacheRead),
          cache_write_price_per_1m: parseRate(values.cacheWrite),
          price_multiplier: parseRate(values.multiplier) || 1,
          source: 'manual',
          synced_at_ms: 0,
        };
        saveMutation.mutate([row]);
      })
      .catch(() => undefined);
  };

  // Filter datasource
  const filteredData = React.useMemo(() => {
    const query = search.trim().toLowerCase();

    if (activeTab === 'unpriced') {
      return unpricedList
        .filter((model) => (query ? model.toLowerCase().includes(query) : true))
        .map(
          (model): ModelPrice => ({
            model,
            prompt_price_per_1m: 0,
            completion_price_per_1m: 0,
            cache_read_price_per_1m: 0,
            cache_write_price_per_1m: 0,
            price_multiplier: 1,
            source: 'manual',
            synced_at_ms: 0,
            updated_at_ms: 0,
          }),
        );
    }

    return models.filter((row) => {
      const matchSearch = query ? row.model.toLowerCase().includes(query) : true;
      if (!matchSearch) return false;
      if (activeTab === 'modelsdev') return row.source === 'modelsdev';
      if (activeTab === 'manual') return row.source === 'manual';
      return true;
    });
  }, [models, unpricedList, search, activeTab]);

  const isPhone = useIsPhoneViewport();
  const [phonePage, setPhonePage] = React.useState(1);
  // Clamped rather than trusted: the list is filtered by the search box and the tabs, so a page
  // past the end would render an empty table with no way back.
  const lastPhonePage = Math.max(1, Math.ceil(filteredData.length / PAGE_SIZE));
  const safePhonePage = Math.min(phonePage, lastPhonePage);
  // A filter change starts the reader at the first page. The clamp above keeps an out-of-range page
  // from rendering empty, but it left the *remembered* page untouched - so clearing the filter the
  // page was chosen under jumped the reader back to a page they had left.
  React.useEffect(() => {
    setPhonePage(1);
  }, [search, activeTab]);
  const pagedPrices = filteredData.slice((safePhonePage - 1) * PAGE_SIZE, safePhonePage * PAGE_SIZE);

  // Table Columns
  const columns = [
    {
      title: t('pricing.col.model'),
      dataIndex: 'model',
      key: 'model',
      ellipsis: true,
      render: (model: string) => (
        <div className={styles['model-cell']}>
          <span>{model}</span>
        </div>
      ),
    },
    {
      title: t('pricing.col.prompt'),
      dataIndex: 'prompt_price_per_1m',
      key: 'prompt',
      align: 'right' as const,
      render: (val: number, row: ModelPrice) =>
        row.updated_at_ms === 0 ? (
          <span className={styles['price-dimmed']}>—</span>
        ) : (
          <span className={`${styles['price-number']} ${val === 0 ? styles['price-dimmed'] : ''}`}>
            ${formatRate(val)}
          </span>
        ),
    },
    {
      title: t('pricing.col.completion'),
      dataIndex: 'completion_price_per_1m',
      key: 'completion',
      align: 'right' as const,
      render: (val: number, row: ModelPrice) =>
        row.updated_at_ms === 0 ? (
          <span className={styles['price-dimmed']}>—</span>
        ) : (
          <span className={`${styles['price-number']} ${val === 0 ? styles['price-dimmed'] : ''}`}>
            ${formatRate(val)}
          </span>
        ),
    },
    {
      title: t('pricing.col.cache_read'),
      dataIndex: 'cache_read_price_per_1m',
      key: 'cacheRead',
      align: 'right' as const,
      render: (val: number, row: ModelPrice) =>
        row.updated_at_ms === 0 ? (
          <span className={styles['price-dimmed']}>—</span>
        ) : (
          <span className={`${styles['price-number']} ${val === 0 ? styles['price-dimmed'] : ''}`}>
            ${formatRate(val)}
          </span>
        ),
    },
    {
      title: t('pricing.col.cache_write'),
      dataIndex: 'cache_write_price_per_1m',
      key: 'cacheWrite',
      align: 'right' as const,
      render: (val: number, row: ModelPrice) =>
        row.updated_at_ms === 0 ? (
          <span className={styles['price-dimmed']}>—</span>
        ) : (
          <span className={`${styles['price-number']} ${val === 0 ? styles['price-dimmed'] : ''}`}>
            {val === 0 ? '—' : `$${formatRate(val)}`}
          </span>
        ),
    },
    {
      title: <span style={{ whiteSpace: 'nowrap' }}>{t('pricing.col.multiplier')}</span>,
      dataIndex: 'price_multiplier',
      key: 'multiplier',
      align: 'center' as const,
      width: 115,
      render: (val: number, row: ModelPrice) =>
        row.updated_at_ms === 0 ? (
          <span className={styles['price-dimmed']}>—</span>
        ) : val === 1 ? (
          <span className={styles['price-dimmed']}>1.0×</span>
        ) : (
          <span className={styles['multiplier-badge']}>×{val}</span>
        ),
    },
    {
      title: t('pricing.col.source'),
      dataIndex: 'source',
      key: 'source',
      width: 120,
      render: (source: string, row: ModelPrice) =>
        row.updated_at_ms === 0 ? (
          <span
            style={{
              fontSize: 11,
              fontFamily: 'monospace',
              color: 'var(--warn)',
              padding: '2px 6px',
              borderRadius: 4,
              background: 'color-mix(in srgb, var(--warn) 12%, var(--surface))',
              border: '1px solid color-mix(in srgb, var(--warn) 30%, var(--border))',
            }}
          >
            {t('pricing.source.unpriced')}
          </span>
        ) : source === 'manual' ? (
          <span className={`${styles['source-badge']} ${styles['source-manual']}`}>
            <EditOutlined style={{ fontSize: 10 }} />
            {t('pricing.source.manual')}
          </span>
        ) : (
          <span className={`${styles['source-badge']} ${styles['source-models-dev']}`}>
            <ThunderboltOutlined style={{ fontSize: 10 }} />
            {t('pricing.source.modelsdev')}
          </span>
        ),
    },
    {
      title: t('pricing.col.updated'),
      dataIndex: 'updated_at_ms',
      key: 'updated',
      width: 120,
      render: (val: number) => (
        <span className={styles['price-dimmed']}>
          {val ? dayjs(val).format('MM-DD HH:mm') : '—'}
        </span>
      ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 100,
      align: 'right' as const,
      render: (_: unknown, row: ModelPrice) =>
        row.updated_at_ms === 0 ? (
          <Button
            size="small"
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => openAdd(row.model)}
            style={{ fontSize: 12, height: 26, borderRadius: 'var(--radius-sm, 4px)' }}
          >
            {t('pricing.add')}
          </Button>
        ) : (
          <div className={styles['action-group']}>
            <Tooltip title={t('pricing.edit')}>
              <Button
                size="small"
                className={styles['action-btn']}
                icon={<EditOutlined />}
                onClick={() => openEdit(row)}
                /* Named for assistive tech, not only for the pointer: the tooltip names it for a
                   mouse, and the phone row reuses this cell, so it is the row's control too. */
                aria-label={`${t('pricing.edit')}: ${row.model}`}
              />
            </Tooltip>
            <Popconfirm
              title={t('pricing.delete_confirm', { model: row.model })}
              onConfirm={() => deleteMutation.mutate(row.model)}
              okText={t('common.confirm')}
              cancelText={t('common.cancel')}
            >
              <Tooltip title={t('pricing.remove')}>
                <Button
                  size="small"
                  className={`${styles['action-btn']} ${styles['action-btn-danger']}`}
                  danger
                  icon={<DeleteOutlined />}
                  loading={deleteMutation.isPending && deleteMutation.variables === row.model}
                  aria-label={`${t('pricing.remove')}: ${row.model}`}
                />
              </Tooltip>
            </Popconfirm>
          </div>
        ),
    },
  ];

  return (
    <div className={`terminal-page ${styles['pricing-page']}`} data-testid="pricing-page">
      {/* 1. Header Block */}
      <header className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('pricing.title')}</h1>
          <p className="terminal-subtitle">
            {models.length > 0
              ? t('pricing.subtitle_count', { count: models.length })
              : t('pricing.desc')}
          </p>
        </div>
        <div className={styles['header-actions']}>
          <Button
            icon={<ReloadOutlined spin={result.isFetching} />}
            disabled={result.isFetching}
            onClick={invalidate}
          >
            {t('common.refresh')}
          </Button>
          <Button
            type="primary"
            icon={<SyncOutlined spin={Boolean(sync?.running)} />}
            loading={syncMutation.isPending}
            // The catalogue sync fetches models.dev. The demonstration prices its own
            // fixture instead, so the server refuses this and the button says so.
            disabled={isDemo}
            title={isDemo ? t('demo.blocked') : undefined}
            onClick={() => syncMutation.mutate()}
          >
            {t('pricing.sync_now')}
          </Button>
        </div>
      </header>

      {/* 2. Error Alert if any */}
      {result.isError && (
        <Alert
          type="error"
          showIcon
          title={t('pricing.load_error')}
          description={result.error instanceof Error ? result.error.message : undefined}
          action={<Button onClick={invalidate}>{t('common.retry')}</Button>}
        />
      )}

      {/* 3. Integrated Top Sync Telemetry Strip */}
      <div className={styles['telemetry-strip']}>
        <div className={styles['telemetry-left']}>
          <span className={styles['telemetry-status']}>
            <span
              className={`${styles['status-pip']} ${
                sync?.running
                  ? styles['pip-running']
                  : state?.last_error
                  ? styles['pip-danger']
                  : styles['pip-success']
              }`}
            />
            <span>
              {sync?.running
                ? t('pricing.sync.running')
                : state?.last_error
                ? `${t('pricing.sync.error', { error: state.last_error })}`
                : t('pricing.sync.title')}
            </span>
          </span>
          <div className={styles['telemetry-divider']} />
          <div className={styles['telemetry-metrics']}>
            <span className={styles['telemetry-item']}>
              {t('pricing.sync.manual', { n: manualCount })}
            </span>
            <div className={styles['telemetry-divider']} />
            <span className={styles['telemetry-item']}>
              {t('pricing.sync.last_success', {
                time: state?.last_success_at_ms
                  ? dayjs(state.last_success_at_ms).format('YYYY-MM-DD HH:mm')
                  : t('pricing.sync.never'),
              })}
            </span>
            <div className={styles['telemetry-divider']} />
            <span className={styles['telemetry-item']}>
              {t('pricing.sync.matched', { n: state?.last_matched ?? 0 })}
            </span>
            <span className={styles['telemetry-item']}>
              {t('pricing.sync.unmatched', { n: state?.last_unmatched ?? 0 })}
            </span>
          </div>
        </div>
        <div className={styles['telemetry-right']}>
          <span className={styles['auto-sync-label']}>{t('pricing.sync.auto_label')}:</span>
          <Select
            size="small"
            className={styles['auto-sync-select']}
            value={state?.auto_sync_interval_hours ?? 24}
            onChange={(val) => updateScheduleMutation.mutate(val)}
            loading={updateScheduleMutation.isPending}
            options={[
              { label: t('pricing.sync.off'), value: 0 },
              { label: t('pricing.sync.every_1h'), value: 1 },
              { label: t('pricing.sync.every_6h'), value: 6 },
              { label: t('pricing.sync.every_12h'), value: 12 },
              { label: t('pricing.sync.every_24h'), value: 24 },
            ]}
          />
          {state?.auto_sync_interval_hours !== 0 && state?.next_sync_at_ms && (
            <span className={styles['next-sync-text']}>
              {t('pricing.sync.next', {
                time: dayjs(state.next_sync_at_ms).format('MM-DD HH:mm'),
              })}
            </span>
          )}
        </div>
      </div>

      {/* 4. Unpriced Models Alert Ribbon (if any detected) */}
      {unpricedList.length > 0 && (
        <div className={styles['unpriced-ribbon']}>
          <div className={styles['unpriced-head']}>
            <span className={styles['unpriced-title']}>
              <WarningOutlined style={{ color: 'var(--warn)' }} />
              {t('pricing.unpriced.title')} ({unpricedList.length})
              <span className={styles['unpriced-hint']}>{t('pricing.unpriced.hint')}</span>
            </span>
          </div>
          <div className={styles['unpriced-chips']}>
            {unpricedList.map((model) => (
              <Tooltip key={model} title={t('pricing.unpriced.add')}>
                <div className={styles['unpriced-chip']} onClick={() => openAdd(model)}>
                  <span className={styles['unpriced-chip-plus']}>+</span>
                  <span>{model}</span>
                </div>
              </Tooltip>
            ))}
          </div>
        </div>
      )}

      {/* 5. Master Console Workbench Container */}
      <div className={styles.workbench}>
        {/* Integrated Toolbar */}
        <div className={styles['workbench-toolbar']}>
          <div className={styles['toolbar-left']}>
            {/* Filter Segmented Tabs */}
            <div className={styles['filter-tabs']}>
              <button
                type="button"
                className={`${styles['filter-tab']} ${activeTab === 'all' ? styles['filter-tab-active'] : ''}`}
                onClick={() => setActiveTab('all')}
              >
                {t('pricing.tab.all')}
                <span className={styles['filter-count']}>{models.length}</span>
              </button>
              <button
                type="button"
                className={`${styles['filter-tab']} ${activeTab === 'modelsdev' ? styles['filter-tab-active'] : ''}`}
                onClick={() => setActiveTab('modelsdev')}
              >
                {t('pricing.source.modelsdev')}
                <span className={styles['filter-count']}>{modelsDevCount}</span>
              </button>
              <button
                type="button"
                className={`${styles['filter-tab']} ${activeTab === 'manual' ? styles['filter-tab-active'] : ''}`}
                onClick={() => setActiveTab('manual')}
              >
                {t('pricing.source.manual')}
                <span className={styles['filter-count']}>{manualCount}</span>
              </button>
              {unpricedCount > 0 && (
                <button
                  type="button"
                  className={`${styles['filter-tab']} ${activeTab === 'unpriced' ? styles['filter-tab-active'] : ''}`}
                  onClick={() => setActiveTab('unpriced')}
                >
                  {t('pricing.tab.unpriced')}
                  <span className={styles['filter-count']}>{unpricedCount}</span>
                </button>
              )}
            </div>

            {/* Monospace Search Input */}
            <Input
              className={styles['search-box']}
              placeholder={t('pricing.search_placeholder')}
              prefix={<SearchOutlined style={{ color: 'var(--meta)' }} />}
              value={search}
              allowClear
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className={styles['toolbar-right']}>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openAdd()}>
              {t('pricing.add')}
            </Button>
          </div>
        </div>

        {/* Dense Data Table, or one row per model on a phone (ADR 0012) */}
        {isPhone ? (
          /* Loading before emptiness: the empty copy is a claim about the catalog, and it is not
             true while the first read is still in flight. */
          result.isLoading && filteredData.length === 0 ? (
            <div className="phone-list-loading">
              <Spin />
            </div>
          ) : filteredData.length === 0 ? (
            <p className="empty-copy">{t('pricing.table.empty')}</p>
          ) : (
            <>
              {pagedPrices.map((price, index) => (
                <PhoneRow
                  key={price.model}
                  identity={renderedCell(columns, 'model', price, index)}
                  fields={phoneRowFields(columns, price, { skip: ['model', 'actions'], index })}
                  actions={renderedCell(columns, 'actions', price, index)}
                />
              ))}
              {filteredData.length > PAGE_SIZE && (
                <Pagination
                  size="small"
                  simple
                  current={safePhonePage}
                  pageSize={PAGE_SIZE}
                  total={filteredData.length}
                  onChange={setPhonePage}
                />
              )}
            </>
          )
        ) : (
          <Table<ModelPrice>
            rowKey="model"
            size="small"
            loading={result.isLoading}
            columns={columns}
            dataSource={filteredData}
            pagination={{ pageSize: PAGE_SIZE, showSizeChanger: false, hideOnSinglePage: true }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={t('pricing.table.empty')}
                />
              ),
            }}
          />
        )}

        {/* Workbench Footer Status */}
        <div className={styles['workbench-footer']}>
          <span>
            {t('pricing.footer_count', { current: filteredData.length, total: models.length })}
          </span>
          {sync?.running && (
            <span className={styles['sync-running-text']}>
              <SyncOutlined spin />
              {t('pricing.sync.running')}
            </span>
          )}
        </div>
      </div>

      {/* 6. Opencode Style Model Capacity Leaderboard */}
      <PricingLeaderboard models={models} />

      {/* 7. Price Editor Modal */}
      <Modal
        open={editor.open}
        title={
          editor.editing
            ? t('pricing.editor.edit_title', { model: editor.editing.model })
            : t('pricing.editor.new_title')
        }
        width={520}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={saveMutation.isPending}
        onOk={submitEditor}
        onCancel={() => setEditor(CLOSED_EDITOR)}
        destroyOnHidden
        forceRender
      >
        {editor.editing ? (
          <div className={styles['editor-meta']}>
            <span
              className={`${styles['source-badge']} ${
                editor.editing.source === 'manual' ? styles['source-manual'] : styles['source-models-dev']
              }`}
            >
              {t(`pricing.source.${editor.editing.source}`)}
            </span>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              {t('pricing.editor.updated_at', {
                time: editor.editing.updated_at_ms
                  ? dayjs(editor.editing.updated_at_ms).format('YYYY-MM-DD HH:mm')
                  : '—',
              })}
            </span>
          </div>
        ) : null}

        {editor.editing && editor.editing.source !== 'manual' ? (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            title={t('pricing.editor.convert_note')}
          />
        ) : null}

        <Form form={form} layout="vertical">
          <Form.Item
            name="model"
            label={t('pricing.editor.model')}
            rules={[{ required: true, message: t('pricing.editor.model_required') }]}
          >
            <Select
              disabled={Boolean(editor.editing)}
              showSearch={{ optionFilterProp: 'label' }}
              allowClear
              placeholder={t('pricing.editor.model_placeholder')}
              options={availableModels.map((model) => ({ label: model, value: model }))}
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </Form.Item>

          <div className={styles['editor-grid']}>
            <Form.Item
              name="prompt"
              label={t('pricing.editor.prompt')}
              rules={[{ required: true, message: t('pricing.editor.required') }]}
            >
              <InputNumber
                placeholder="0.00"
                min={0}
                step={0.000001}
                controls={false}
                stringMode
                style={{ width: '100%' }}
                suffix="$ / 1M"
              />
            </Form.Item>
            <Form.Item
              name="completion"
              label={t('pricing.editor.completion')}
              rules={[{ required: true, message: t('pricing.editor.required') }]}
            >
              <InputNumber
                placeholder="0.00"
                min={0}
                step={0.000001}
                controls={false}
                stringMode
                style={{ width: '100%' }}
                suffix="$ / 1M"
              />
            </Form.Item>
            <Form.Item
              name="cacheRead"
              label={t('pricing.editor.cache_read')}
            >
              <InputNumber
                placeholder="0.00"
                min={0}
                step={0.000001}
                controls={false}
                stringMode
                style={{ width: '100%' }}
                suffix="$ / 1M"
              />
            </Form.Item>
            <Form.Item
              name="cacheWrite"
              label={t('pricing.editor.cache_write')}
            >
              <InputNumber
                placeholder="0.00"
                min={0}
                step={0.000001}
                controls={false}
                stringMode
                style={{ width: '100%' }}
                suffix="$ / 1M"
              />
            </Form.Item>
          </div>

          <Form.Item
            name="multiplier"
            label={t('pricing.editor.multiplier')}
            initialValue={1}
            rules={[{ required: true, message: t('pricing.editor.required') }]}
          >
            <InputNumber min={0.01} step={0.01} controls={false} style={{ width: '100%' }} suffix="×" />
          </Form.Item>

          {/* Live Estimation Sample Preview */}
          <div className={styles['live-estimate-box']}>
            <div className={styles['live-estimate-title']}>{t('pricing.editor.live_sample_title')}</div>
            <div className={styles['live-estimate-value']}>
              ${(((watchedPrompt * 0.1) + (watchedCompletion * 0.02)) * watchedMultiplier).toFixed(6)}
            </div>
          </div>
        </Form>
      </Modal>
    </div>
  );
};




