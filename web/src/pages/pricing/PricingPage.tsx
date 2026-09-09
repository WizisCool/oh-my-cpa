import React from 'react';
import { Alert, App as AntdApp, Button, Card, Descriptions, Empty, Form, Input, InputNumber, Modal, Popconfirm, Space, Table, Tag, Tooltip } from 'antd';
import { ReloadOutlined, SyncOutlined, PlusOutlined, EditOutlined, DeleteOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useT } from '../../i18n';
import type { ModelPrice } from '../../types/pricing';
import styles from './PricingPage.module.css';

/** Per-1M rates share one cell format: plain number, '$/1M' in the column header. */
function formatRate(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
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

export const PricingPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [search, setSearch] = React.useState('');
  const [editor, setEditor] = React.useState<EditorState>(CLOSED_EDITOR);
  const [form] = Form.useForm<PriceFormValues>();

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
  const filtered = models.filter((row) =>
    search ? row.model.toLowerCase().includes(search.toLowerCase()) : true,
  );

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
          // source is decided server-side: operator edits always land as manual.
          source: 'manual',
          synced_at_ms: 0,
          updated_at_ms: Date.now(),
        };
        saveMutation.mutate([row]);
      })
      .catch(() => undefined);
  };

  const sync = result.data?.sync;
  const state = sync?.state;

  const columns = [
    {
      title: t('pricing.col.model'),
      dataIndex: 'model',
      key: 'model',
      ellipsis: true,
    },
    {
      title: `${t('pricing.col.prompt')} ($/1M)`,
      dataIndex: 'prompt_price_per_1m',
      key: 'prompt',
      align: 'right' as const,
      render: (value: number) => <span className={styles['pricing-number']}>{formatRate(value)}</span>,
    },
    {
      title: `${t('pricing.col.completion')} ($/1M)`,
      dataIndex: 'completion_price_per_1m',
      key: 'completion',
      align: 'right' as const,
      render: (value: number) => <span className={styles['pricing-number']}>{formatRate(value)}</span>,
    },
    {
      title: `${t('pricing.col.cache_read')} ($/1M)`,
      dataIndex: 'cache_read_price_per_1m',
      key: 'cacheRead',
      align: 'right' as const,
      render: (value: number) => <span className={styles['pricing-number']}>{formatRate(value)}</span>,
    },
    {
      title: `${t('pricing.col.cache_write')} ($/1M)`,
      dataIndex: 'cache_write_price_per_1m',
      key: 'cacheWrite',
      align: 'right' as const,
      render: (value: number) => <span className={styles['pricing-number']}>{formatRate(value)}</span>,
    },
    {
      title: t('pricing.col.multiplier'),
      dataIndex: 'price_multiplier',
      key: 'multiplier',
      align: 'right' as const,
      render: (value: number) =>
        value === 1 ? '—' : <span className={styles['pricing-number']}>×{value}</span>,
    },
    {
      title: t('pricing.col.source'),
      dataIndex: 'source',
      key: 'source',
      width: 110,
      render: (value: string) => (
        <Tag color={value === 'manual' ? 'gold' : 'blue'}>
          {t(value === 'manual' ? 'pricing.source.manual' : 'pricing.source.modelsdev')}
        </Tag>
      ),
    },
    {
      title: t('pricing.col.updated'),
      dataIndex: 'updated_at_ms',
      key: 'updated',
      width: 140,
      render: (value: number) => dayjs(value).format('MM-DD HH:mm'),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 130,
      render: (_: unknown, row: ModelPrice) => (
        <Space size="small">
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
            {t('pricing.edit')}
          </Button>
          <Popconfirm
            title={t('pricing.delete_confirm', { model: row.model })}
            onConfirm={() => deleteMutation.mutate(row.model)}
          >
            <Button size="small" danger icon={<DeleteOutlined />} aria-label={t('pricing.remove')} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className={`terminal-page pricing-page ${styles['pricing-page']}`} data-testid="pricing-page">
      <header className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('pricing.title')}</h1>
          <p className="terminal-subtitle">{t('pricing.desc')}</p>
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
      {result.isError && (
        <Alert
          type="error"
          showIcon
          title={t('pricing.load_error')}
          description={result.error instanceof Error ? result.error.message : undefined}
          action={<Button onClick={invalidate}>{t('common.retry')}</Button>}
        />
      )}
      <Card
        title={<span className={styles['pricing-card-title']}>{t('pricing.table.title')}</span>}
        extra={
          <Button type="primary" ghost icon={<PlusOutlined />} onClick={() => openAdd()}>
            {t('pricing.add')}
          </Button>
        }
      >
        <div className={styles['pricing-toolbar']}>
          <Input
            className={styles['pricing-search']}
            aria-label={t('pricing.col.model')}
            placeholder={t('common.search')}
            prefix={<span>🔍</span>}
            value={search}
            allowClear
            onChange={(e) => setSearch(e.target.value)}
          />
          <span className={styles['pricing-perm-note']}>{t('pricing.per_1m')}</span>
        </div>
        <Table<ModelPrice>
          rowKey="model"
          size="small"
          loading={result.isLoading}
          columns={columns}
          dataSource={filtered}
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
      </Card>
      <Card title={t('pricing.sync.title')}>
        <Descriptions
          size="small"
          column={2}
          items={[
            {
              key: 'last',
              label: t('pricing.sync.last_success', {
                time: state?.last_success_at_ms
                  ? dayjs(state.last_success_at_ms).format('YYYY-MM-DD HH:mm')
                  : t('pricing.sync.never'),
              }),
              children: (
                <span>
                  {sync?.running
                    ? t('pricing.sync.running')
                    : `${t('pricing.sync.matched', { n: state?.last_matched ?? 0 })} · ${t('pricing.sync.unmatched', { n: state?.last_unmatched ?? 0 })}`}
                </span>
              ),
            },
            ...(state?.last_error
              ? [
                  {
                    key: 'error',
                    label: t('pricing.sync.error', { error: '' }),
                    children: <span>{state.last_error}</span>,
                  },
                ]
              : []),
          ]}
        />
      </Card>
      <Card title={t('pricing.unpriced.title')}>
        {(result.data?.unpriced?.length ?? 0) > 0 ? (
          <>
            <p className={styles['pricing-perm-note']}>{t('pricing.unpriced.hint')}</p>
            <div className={styles['pricing-unpriced']}>
              {(result.data?.unpriced ?? []).map((model) => (
                <Tooltip key={model} title={t('pricing.unpriced.add')}>
                  <Button size="small" onClick={() => openAdd(model)}>
                    {model} <PlusOutlined />
                  </Button>
                </Tooltip>
              ))}
            </div>
          </>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('pricing.unpriced.empty')} />
        )}
      </Card>
      <Modal
        open={editor.open}
        title={editor.editing ? t('pricing.editor.edit_title', { model: editor.editing.model }) : t('pricing.editor.new_title')}
        width={520}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={saveMutation.isPending}
        onOk={submitEditor}
        onCancel={() => setEditor(CLOSED_EDITOR)}
        destroyOnHidden
        // forceRender keeps the Form instance connected so prefill values set
        // while the modal is closed actually land in the fields.
        forceRender
      >
        {editor.editing ? (
          <div className={styles['pricing-editor-meta']}>
            <Tag color={editor.editing.source === 'manual' ? 'gold' : 'blue'}>
              {t(`pricing.source.${editor.editing.source}`)}
            </Tag>
            <span className={styles['pricing-perm-note']}>
              {t('pricing.editor.updated_at', {
                time: editor.editing.updated_at_ms ? dayjs(editor.editing.updated_at_ms).format('YYYY-MM-DD HH:mm') : '—',
              })}
            </span>
          </div>
        ) : null}
        {editor.editing && editor.editing.source !== 'manual' ? (
          <Alert
            type="info"
            showIcon
            className={styles['pricing-editor-note']}
            title={t('pricing.editor.convert_note')}
          />
        ) : null}
        <Form form={form} layout="vertical" className={`pricing-editor-form ${styles['pricing-editor-form']}`}>
          <Form.Item
            name="model"
            label={t('pricing.editor.model')}
            rules={[{ required: true, message: t('pricing.editor.model_required') }]}
          >
            <Input disabled={Boolean(editor.editing)} placeholder="gpt-5.6-luna" />
          </Form.Item>
          <div className={styles['pricing-editor-grid']}>
            <Form.Item name="prompt" label={t('pricing.editor.prompt')} rules={[{ required: true, message: t('pricing.editor.required') }]}>
              <InputNumber min={0} step={0.000001} style={{ width: '100%' }} suffix="$ / 1M" />
            </Form.Item>
            <Form.Item name="completion" label={t('pricing.editor.completion')} rules={[{ required: true, message: t('pricing.editor.required') }]}>
              <InputNumber min={0} step={0.000001} style={{ width: '100%' }} suffix="$ / 1M" />
            </Form.Item>
            <Form.Item name="cacheRead" label={t('pricing.editor.cache_read')} rules={[{ required: true, message: t('pricing.editor.required') }]}>
              <InputNumber min={0} step={0.000001} style={{ width: '100%' }} suffix="$ / 1M" />
            </Form.Item>
            <Form.Item name="cacheWrite" label={t('pricing.editor.cache_write')} rules={[{ required: true, message: t('pricing.editor.required') }]}>
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
        </Form>
      </Modal>
    </div>
  );
};





