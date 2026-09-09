import React from 'react';
import { Alert, App as AntdApp, Button, Empty, Form, Input, InputNumber, Modal, Popconfirm, Table, Tooltip } from 'antd';
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
import type { ModelPrice } from '../../types/pricing';
import styles from './PricingPage.module.css';

/** Per-1M rates share one cell format: plain number with up to 6 decimal places. */
function formatRate(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

/** Form values for the manual price editor; every rate is USD per 1M tokens. */
interface PriceFormValues {
  model: string;
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
  multiplier: number;
}

interface EditorState {
  open: boolean;
  editing: ModelPrice | null;
}

const CLOSED_EDITOR: EditorState = { open: false, editing: null };
type FilterTabKey = 'all' | 'modelsdev' | 'manual' | 'unpriced';

export const PricingPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState('');
  const [activeTab, setActiveTab] = React.useState<FilterTabKey>('all');
  const [editor, setEditor] = React.useState<EditorState>(CLOSED_EDITOR);
  const [form] = Form.useForm<PriceFormValues>();

  const watchedPrompt = Form.useWatch('prompt', form) ?? 0;
  const watchedCompletion = Form.useWatch('completion', form) ?? 0;
  const watchedMultiplier = Form.useWatch('multiplier', form) ?? 1;

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
    mutationFn: async (rows: ModelPrice[]) => {
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

  const models = result.data?.models ?? [];
  const unpricedList = result.data?.unpriced ?? [];
  const sync = result.data?.sync;
  const state = sync?.state;

  const modelsDevCount = models.filter((m) => m.source === 'modelsdev').length;
  const manualCount = models.filter((m) => m.source === 'manual').length;
  const unpricedCount = unpricedList.length;

  const openAdd = (model = '') => {
    form.setFieldsValue({ model, prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, multiplier: 1 });
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
        const row: ModelPrice = {
          model: values.model.trim(),
          prompt_price_per_1m: values.prompt,
          completion_price_per_1m: values.completion,
          cache_read_price_per_1m: values.cacheRead,
          cache_write_price_per_1m: values.cacheWrite,
          price_multiplier: values.multiplier,
          source: 'manual',
          synced_at_ms: 0,
          updated_at_ms: Date.now(),
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

  // Table Columns
  const columns = [
    {
      title: t('pricing.col.model'),
      dataIndex: 'model',
      key: 'model',
      ellipsis: true,
      render: (model: string) => (
        <div className={styles.modelCell}>
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
          <span className={styles.priceDimmed}>—</span>
        ) : (
          <span className={`${styles.priceNumber} ${val === 0 ? styles.priceDimmed : ''}`}>
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
          <span className={styles.priceDimmed}>—</span>
        ) : (
          <span className={`${styles.priceNumber} ${val === 0 ? styles.priceDimmed : ''}`}>
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
          <span className={styles.priceDimmed}>—</span>
        ) : (
          <span className={`${styles.priceNumber} ${val === 0 ? styles.priceDimmed : ''}`}>
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
          <span className={styles.priceDimmed}>—</span>
        ) : (
          <span className={`${styles.priceNumber} ${val === 0 ? styles.priceDimmed : ''}`}>
            {val === 0 ? '—' : `$${formatRate(val)}`}
          </span>
        ),
    },
    {
      title: t('pricing.col.multiplier'),
      dataIndex: 'price_multiplier',
      key: 'multiplier',
      align: 'center' as const,
      width: 90,
      render: (val: number, row: ModelPrice) =>
        row.updated_at_ms === 0 ? (
          <span className={styles.priceDimmed}>—</span>
        ) : val === 1 ? (
          <span className={styles.priceDimmed}>1.0×</span>
        ) : (
          <span className={styles.multiplierBadge}>×{val}</span>
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
            未定价
          </span>
        ) : source === 'manual' ? (
          <span className={`${styles.sourceBadge} ${styles.sourceManual}`}>
            <EditOutlined style={{ fontSize: 10 }} />
            {t('pricing.source.manual')}
          </span>
        ) : (
          <span className={`${styles.sourceBadge} ${styles.sourceModelsDev}`}>
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
        <span className={styles.priceDimmed}>
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
          <div className={styles.actionGroup}>
            <Tooltip title={t('pricing.edit')}>
              <Button
                size="small"
                className={styles.actionBtn}
                icon={<EditOutlined />}
                onClick={() => openEdit(row)}
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
                  className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
                  danger
                  icon={<DeleteOutlined />}
                  loading={deleteMutation.isPending && deleteMutation.variables === row.model}
                />
              </Tooltip>
            </Popconfirm>
          </div>
        ),
    },
  ];

  return (
    <div className={`terminal-page ${styles.pricingPage}`} data-testid="pricing-page">
      {/* 1. Header Block */}
      <header className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('pricing.title')}</h1>
          <p className="terminal-subtitle">
            {models.length > 0
              ? `共 ${models.length} 个模型已定价 · 数据源 models.dev · 手动价格优先`
              : t('pricing.desc')}
          </p>
        </div>
        <div className="request-actions">
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
      <div className={styles.telemetryStrip}>
        <div className={styles.telemetryLeft}>
          <span className={styles.telemetryStatus}>
            <span
              className={`${styles.statusPip} ${
                sync?.running
                  ? styles.pipRunning
                  : state?.last_error
                  ? styles.pipDanger
                  : styles.pipSuccess
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
          <div className={styles.telemetryDivider} />
          <div className={styles.telemetryMetrics}>
            <span className={styles.telemetryItem}>
              {t('pricing.sync.last_success', {
                time: state?.last_success_at_ms
                  ? dayjs(state.last_success_at_ms).format('YYYY-MM-DD HH:mm')
                  : t('pricing.sync.never'),
              })}
            </span>
            <div className={styles.telemetryDivider} />
            <span className={styles.telemetryItem}>
              {t('pricing.sync.matched', { n: state?.last_matched ?? 0 })}
            </span>
            <span className={styles.telemetryItem}>
              {t('pricing.sync.unmatched', { n: state?.last_unmatched ?? 0 })}
            </span>
            <div className={styles.telemetryDivider} />
            <span className={styles.telemetryItem}>
              手动定制 <strong>{manualCount}</strong> 个
            </span>
          </div>
        </div>
      </div>

      {/* 4. Unpriced Models Alert Ribbon (if any detected) */}
      {unpricedList.length > 0 && (
        <div className={styles.unpricedRibbon}>
          <div className={styles.unpricedHead}>
            <span className={styles.unpricedTitle}>
              <WarningOutlined style={{ color: 'var(--warn)' }} />
              {t('pricing.unpriced.title')} ({unpricedList.length})
              <span className={styles.unpricedHint}>{t('pricing.unpriced.hint')}</span>
            </span>
          </div>
          <div className={styles.unpricedChips}>
            {unpricedList.map((model) => (
              <Tooltip key={model} title={t('pricing.unpriced.add')}>
                <div className={styles.unpricedChip} onClick={() => openAdd(model)}>
                  <span className={styles.unpricedChipPlus}>+</span>
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
        <div className={styles.workbenchToolbar}>
          <div className={styles.toolbarLeft}>
            {/* Filter Segmented Tabs */}
            <div className={styles.filterTabs}>
              <button
                type="button"
                className={`${styles.filterTab} ${activeTab === 'all' ? styles.filterTabActive : ''}`}
                onClick={() => setActiveTab('all')}
              >
                全部
                <span className={styles.filterCount}>{models.length}</span>
              </button>
              <button
                type="button"
                className={`${styles.filterTab} ${activeTab === 'modelsdev' ? styles.filterTabActive : ''}`}
                onClick={() => setActiveTab('modelsdev')}
              >
                {t('pricing.source.modelsdev')}
                <span className={styles.filterCount}>{modelsDevCount}</span>
              </button>
              <button
                type="button"
                className={`${styles.filterTab} ${activeTab === 'manual' ? styles.filterTabActive : ''}`}
                onClick={() => setActiveTab('manual')}
              >
                {t('pricing.source.manual')}
                <span className={styles.filterCount}>{manualCount}</span>
              </button>
              {unpricedCount > 0 && (
                <button
                  type="button"
                  className={`${styles.filterTab} ${activeTab === 'unpriced' ? styles.filterTabActive : ''}`}
                  onClick={() => setActiveTab('unpriced')}
                >
                  未定价
                  <span className={styles.filterCount}>{unpricedCount}</span>
                </button>
              )}
            </div>

            {/* Monospace Search Input */}
            <Input
              className={styles.searchBox}
              placeholder="搜索模型名称..."
              prefix={<SearchOutlined style={{ color: 'var(--meta)' }} />}
              value={search}
              allowClear
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          <div className={styles.toolbarRight}>
            <span className={styles.unitTag}>{t('pricing.per_1m')}</span>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openAdd()}>
              {t('pricing.add')}
            </Button>
          </div>
        </div>

        {/* Dense Data Table */}
        <Table<ModelPrice>
          rowKey="model"
          size="small"
          loading={result.isLoading}
          columns={columns}
          dataSource={filteredData}
          pagination={{ pageSize: 50, showSizeChanger: false, hideOnSinglePage: true }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={t('pricing.table.empty')}
              />
            ),
          }}
        />

        {/* Workbench Footer Status */}
        <div className={styles.workbenchFooter}>
          <span>
            显示 {filteredData.length} / {models.length} 个模型价格条目
          </span>
          <span>
            {sync?.running ? '正在与 models.dev 保持同步' : '计费系统就绪 · 精度最高支持 6 位小数'}
          </span>
        </div>
      </div>

      {/* 6. Price Editor Modal */}
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
          <div className={styles.editorMeta}>
            <span
              className={`${styles.sourceBadge} ${
                editor.editing.source === 'manual' ? styles.sourceManual : styles.sourceModelsDev
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
            <Input
              disabled={Boolean(editor.editing)}
              placeholder="gpt-5.6-luna"
              style={{ fontFamily: 'monospace' }}
            />
          </Form.Item>

          <div className={styles.editorGrid}>
            <Form.Item
              name="prompt"
              label={t('pricing.editor.prompt')}
              rules={[{ required: true, message: t('pricing.editor.required') }]}
            >
              <InputNumber min={0} step={0.000001} style={{ width: '100%' }} suffix="$ / 1M" />
            </Form.Item>
            <Form.Item
              name="completion"
              label={t('pricing.editor.completion')}
              rules={[{ required: true, message: t('pricing.editor.required') }]}
            >
              <InputNumber min={0} step={0.000001} style={{ width: '100%' }} suffix="$ / 1M" />
            </Form.Item>
            <Form.Item
              name="cacheRead"
              label={t('pricing.editor.cache_read')}
              rules={[{ required: true, message: t('pricing.editor.required') }]}
            >
              <InputNumber min={0} step={0.000001} style={{ width: '100%' }} suffix="$ / 1M" />
            </Form.Item>
            <Form.Item
              name="cacheWrite"
              label={t('pricing.editor.cache_write')}
              rules={[{ required: true, message: t('pricing.editor.required') }]}
            >
              <InputNumber min={0} step={0.000001} style={{ width: '100%' }} suffix="$ / 1M" />
            </Form.Item>
          </div>

          <Form.Item
            name="multiplier"
            label={t('pricing.editor.multiplier')}
            initialValue={1}
            rules={[{ required: true, message: t('pricing.editor.required') }]}
            extra={t('pricing.editor.multiplier_hint')}
          >
            <InputNumber min={0} step={0.01} style={{ width: '100%' }} suffix="×" />
          </Form.Item>

          {/* Live Estimation Sample Preview */}
          <div className={styles.liveEstimateBox}>
            <div className={styles.liveEstimateTitle}>成本试算示例 (100K Prompt + 20K Completion)</div>
            <div className={styles.liveEstimateValue}>
              ${(((watchedPrompt * 0.1) + (watchedCompletion * 0.02)) * watchedMultiplier).toFixed(6)}
            </div>
          </div>
        </Form>
      </Modal>
    </div>
  );
};






