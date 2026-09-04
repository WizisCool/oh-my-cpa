import React, { useState, useMemo, useCallback } from 'react';
import {
  Card,
  Descriptions,
  Table,
  Tag,
  Button,
  Input,
  Select,
  Radio,
  Typography,
  Tooltip,
  Alert,
  Popover,
  Badge,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  SearchOutlined,
  SyncOutlined,
  CopyOutlined,
  InfoCircleOutlined,
  RightOutlined,
  LeftOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { api } from '../api/client';
import { useT } from '../i18n';
import {
  UsageEvent,
  UsageResultFilter,
  usageEventParams,
} from '../types/usageEvents';
import { UsageEventDrawer } from '../components/usage/UsageEventDrawer';

const { Text } = Typography;

interface IngestPipelineStatusDTO {
  enabled?: boolean;
  healthy?: boolean;
  collector?: {
    mode?: string;
    running?: boolean;
    captured?: number;
    coverage_gaps?: number;
    last_error?: string;
  };
  stats?: {
    events?: number;
    pending?: number;
    processed?: number;
    discarded?: number;
  };
  recent_gaps?: Array<{
    id: number;
    source_mode: string;
    estimated_count: number;
    reason_code: string;
    summary: string;
    started_at_ms: number;
  }>;
}

export const UsageEventsPage: React.FC = () => {
  const t = useT();
  const [searchParams, setSearchParams] = useSearchParams();

  // URL search params sync
  const initialPreset = searchParams.get('preset') || '1h';
  const initialResult = (searchParams.get('result') as UsageResultFilter) || 'all';
  const initialModel = searchParams.get('model') || '';
  const initialProvider = searchParams.get('provider') || '';
  const initialRequestId = searchParams.get('request_id') || '';
  const initialLimit = parseInt(searchParams.get('limit') || '50', 10);

  const [preset, setPreset] = useState<string>(initialPreset);
  const [resultFilter, setResultFilter] = useState<UsageResultFilter>(initialResult);
  const [modelFilter, setModelFilter] = useState<string>(initialModel);
  const [providerFilter, setProviderFilter] = useState<string>(initialProvider);
  const [requestIdSearch, setRequestIdSearch] = useState<string>(initialRequestId);
  const [limit, setLimit] = useState<number>(initialLimit);

  // Pagination state: cursor stack for previous/next keyset navigation
  const [cursorStack, setCursorStack] = useState<string[]>([]);
  const currentCursor = cursorStack.length > 0 ? cursorStack[cursorStack.length - 1] : '';

  const [selectedEventId, setSelectedEventId] = useState<number | null>(null);

  // Sync URL search params
  const updateParams = useCallback((newParams: Record<string, string | number | undefined>) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      Object.entries(newParams).forEach(([k, v]) => {
        if (v === undefined || v === '' || (k === 'result' && v === 'all') || (k === 'preset' && v === '1h')) {
          next.delete(k);
        } else {
          next.set(k, String(v));
        }
      });
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Facets query
  const facetsQueryStr = useMemo(() => {
    return usageEventParams({ preset });
  }, [preset]);

  const { data: facetsData } = useQuery({
    queryKey: ['usage-facets', facetsQueryStr],
    queryFn: () => api.getUsageFacets(facetsQueryStr),
    staleTime: 30000,
  });

  // Ingest status query
  const { data: rawIngestStatus } = useQuery({
    queryKey: ['usage-ingest-status'],
    queryFn: api.getUsageIngestStatus,
    refetchInterval: 15000,
  });
  const ingestStatus = rawIngestStatus as IngestPipelineStatusDTO | undefined;

  // Events query
  const queryStr = useMemo(() => {
    return usageEventParams({
      preset,
      result: resultFilter,
      model: modelFilter || undefined,
      provider: providerFilter || undefined,
      request_id: requestIdSearch.trim() || undefined,
      cursor: currentCursor || undefined,
      limit,
    });
  }, [preset, resultFilter, modelFilter, providerFilter, requestIdSearch, currentCursor, limit]);

  const {
    data: pageData,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['usage-events', queryStr],
    queryFn: () => api.getUsageEvents(queryStr),
    staleTime: 10000,
  });

  const events = pageData?.items || [];
  const hasMore = Boolean(pageData?.has_more);
  const nextCursor = pageData?.next_cursor;

  const handleNextPage = () => {
    if (nextCursor) {
      setCursorStack((prev) => [...prev, nextCursor]);
    }
  };

  const handlePrevPage = () => {
    setCursorStack((prev) => (prev.length > 0 ? prev.slice(0, -1) : []));
  };

  const handleResetFilters = () => {
    setCursorStack([]);
    setModelFilter('');
    setProviderFilter('');
    setRequestIdSearch('');
    setResultFilter('all');
    updateParams({ model: '', provider: '', request_id: '', result: 'all' });
  };

  const handleCopy = (text: string) => {
    void navigator.clipboard.writeText(text);
  };

  // Ingest Status Popover content
  const ingestPopoverContent = (
    <div style={{ maxWidth: 320 }}>
      <div style={{ marginBottom: 8 }}>
        <Text strong>{t('events.delivery_semantics_hint')}</Text>
      </div>
      <Descriptions size="small" column={1} bordered>
        <Descriptions.Item label="Collector Mode">
          <code>{ingestStatus?.collector?.mode || 'auto'}</code>
        </Descriptions.Item>
        <Descriptions.Item label="Captured Requests">
          <span className="mono-num">{ingestStatus?.collector?.captured ?? 0}</span>
        </Descriptions.Item>
        <Descriptions.Item label="Coverage Gaps">
          <span className="mono-num" style={{ color: (ingestStatus?.collector?.coverage_gaps ?? 0) > 0 ? 'var(--danger)' : undefined }}>
            {ingestStatus?.collector?.coverage_gaps ?? 0}
          </span>
        </Descriptions.Item>
        <Descriptions.Item label="Inbox Backlog">
          <span className="mono-num">{ingestStatus?.stats?.pending ?? 0}</span>
        </Descriptions.Item>
      </Descriptions>
      {(ingestStatus?.recent_gaps?.length ?? 0) > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--danger)' }}>
          {t('events.ingest_gaps', { n: ingestStatus!.recent_gaps!.length })}
        </div>
      )}
    </div>
  );

  const columns: ColumnsType<UsageEvent> = [
    {
      title: t('events.col_time'),
      key: 'timestamp',
      width: 130,
      render: (_, r) => (
        <span className="mono-num" style={{ fontSize: 12 }}>
          {dayjs(r.timestamp_ms).format('HH:mm:ss.SSS')}
        </span>
      ),
    },
    {
      title: t('events.col_result'),
      key: 'result',
      width: 100,
      render: (_, r) => (
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {r.failed ? (
            <Tag color="error">{t('events.filter_failed')}</Tag>
          ) : (
            <Tag color="success">{t('events.filter_success')}</Tag>
          )}
          {r.generate === false && <Tag style={{ fontSize: 10 }}>Pre</Tag>}
        </div>
      ),
    },
    {
      title: t('events.col_model'),
      key: 'model',
      render: (_, r) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{r.model}</Text>
          {r.model_alias && (
            <div style={{ fontSize: 11, color: 'var(--meta)' }}>
              alias: {r.model_alias}
            </div>
          )}
        </div>
      ),
    },
    {
      title: t('events.col_provider_cred'),
      key: 'provider',
      render: (_, r) => (
        <div>
          <Tag color="blue">{r.provider || '-'}</Tag>
          {r.auth_index && (
            <div style={{ fontSize: 10, color: 'var(--meta)', fontFamily: 'monospace' }}>
              idx: {r.auth_index}
            </div>
          )}
        </div>
      ),
    },
    {
      title: t('events.col_latency'),
      key: 'latency',
      width: 130,
      render: (_, r) => (
        <div>
          <span className="mono-num" style={{ fontSize: 12 }}>{r.latency_ms} ms</span>
          {r.ttft_ms != null && (
            <div style={{ fontSize: 10, color: 'var(--meta)' }} className="mono-num">
              TTFT: {r.ttft_ms} ms
            </div>
          )}
        </div>
      ),
    },
    {
      title: t('events.col_tokens'),
      key: 'tokens',
      width: 120,
      render: (_, r) => (
        <Tooltip
          title={`In: ${r.tokens.input} · Out: ${r.tokens.output} · Reasoning: ${r.tokens.reasoning} · Cache: ${r.tokens.cached}`}
        >
          <Text strong className="mono-num" style={{ fontSize: 12 }}>
            {r.tokens.total}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: t('events.col_request_id'),
      key: 'request_id',
      width: 160,
      render: (_, r) =>
        r.request_id ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              className="mono-num"
              style={{ fontSize: 11, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {r.request_id}
            </span>
            <Button
              size="small"
              type="text"
              icon={<CopyOutlined style={{ fontSize: 11 }} />}
              onClick={() => handleCopy(r.request_id!)}
            />
          </div>
        ) : (
          <span style={{ color: 'var(--meta)' }}>-</span>
        ),
    },
    {
      title: t('common.actions'),
      key: 'actions',
      width: 80,
      align: 'right',
      render: (_, r) => (
        <Button size="small" type="link" onClick={() => setSelectedEventId(r.id)}>
          {t('common.details')}
        </Button>
      ),
    },
  ];

  return (
    <div className="terminal-page usage-events-page">
      {/* Head */}
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('events.title')}</h1>
          <p className="terminal-subtitle">{t('events.subtitle')}</p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* Ingest Status Badge */}
          <Popover content={ingestPopoverContent} title="Ingestion Health & Semantics" trigger="click">
            <Button size="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {(ingestStatus?.collector?.coverage_gaps ?? 0) > 0 ? (
                <Badge status="warning" text={t('events.ingest_gaps', { n: ingestStatus!.collector!.coverage_gaps! })} />
              ) : ingestStatus?.healthy ? (
                <Badge status="success" text={t('events.ingest_healthy')} />
              ) : (
                <Badge status="default" text="Ingest Off" />
              )}
              <InfoCircleOutlined style={{ color: 'var(--muted)' }} />
            </Button>
          </Popover>

          <Button
            size="small"
            icon={<SyncOutlined spin={isFetching} />}
            onClick={() => void refetch()}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {isError && (
        <Alert
          type="error"
          showIcon
          description={`${t('events.load_error')} — ${error instanceof Error ? error.message : String(error)}`}
          action={
            <Button size="small" type="primary" onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Filter Toolbar */}
      <Card size="small" className="terminal-panel" style={{ marginBottom: 16 }} styles={{ body: { padding: '12px 16px' } }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            {/* Time Presets */}
            <Radio.Group
              size="small"
              value={preset}
              onChange={(e) => {
                setPreset(e.target.value);
                setCursorStack([]);
                updateParams({ preset: e.target.value });
              }}
              buttonStyle="solid"
            >
              <Radio.Button value="15m">{t('dash.range.15m')}</Radio.Button>
              <Radio.Button value="1h">{t('dash.range.1h')}</Radio.Button>
              <Radio.Button value="6h">6h</Radio.Button>
              <Radio.Button value="24h">24h</Radio.Button>
              <Radio.Button value="7d">7d</Radio.Button>
            </Radio.Group>

            {/* Result Filter */}
            <Radio.Group
              size="small"
              value={resultFilter}
              onChange={(e) => {
                setResultFilter(e.target.value);
                setCursorStack([]);
                updateParams({ result: e.target.value });
              }}
              buttonStyle="solid"
            >
              <Radio.Button value="all">{t('events.filter_all')}</Radio.Button>
              <Radio.Button value="success">{t('events.filter_success')}</Radio.Button>
              <Radio.Button value="failed">{t('events.filter_failed')}</Radio.Button>
            </Radio.Group>

            {/* Model Facet Selector */}
            <Select
              size="small"
              style={{ width: 160 }}
              placeholder={t('events.col_model')}
              allowClear
              value={modelFilter || undefined}
              onChange={(val) => {
                setModelFilter(val || '');
                setCursorStack([]);
                updateParams({ model: val || '' });
              }}
              options={(facetsData?.facets.models || []).map((m) => ({
                value: m.value,
                label: `${m.value} (${m.requests})`,
              }))}
            />

            {/* Provider Facet Selector */}
            <Select
              size="small"
              style={{ width: 140 }}
              placeholder="Provider"
              allowClear
              value={providerFilter || undefined}
              onChange={(val) => {
                setProviderFilter(val || '');
                setCursorStack([]);
                updateParams({ provider: val || '' });
              }}
              options={(facetsData?.facets.providers || []).map((p) => ({
                value: p.value,
                label: `${p.value} (${p.requests})`,
              }))}
            />

            {/* Request ID Search */}
            <Input
              size="small"
              placeholder={t('events.col_request_id')}
              prefix={<SearchOutlined style={{ color: 'var(--muted)' }} />}
              style={{ width: 170 }}
              value={requestIdSearch}
              allowClear
              onChange={(e) => {
                setRequestIdSearch(e.target.value);
                setCursorStack([]);
                updateParams({ request_id: e.target.value });
              }}
            />
          </div>

          {(modelFilter || providerFilter || requestIdSearch || resultFilter !== 'all' || preset !== '1h') && (
            <Button size="small" onClick={handleResetFilters}>
              {t('res.reset')}
            </Button>
          )}
        </div>
      </Card>

      {/* Events Table Container */}
      <Card size="small" className="terminal-panel" styles={{ body: { padding: 0 } }}>
        <div className="table-responsive-wrapper" style={{ width: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <Table<UsageEvent>
            columns={columns}
            dataSource={events}
            rowKey="id"
            loading={isLoading}
            pagination={false}
            scroll={{ x: 'max-content' }}
            size="small"
          />
        </div>

        {/* Keyset Pagination Bar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '12px 16px',
            borderTop: '1px solid var(--border-soft)',
          }}
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            {cursorStack.length > 0
              ? `Page ${cursorStack.length + 1} (${events.length} records)`
              : `${events.length} records loaded`}
          </Text>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Select
              size="small"
              value={limit}
              onChange={(val) => {
                setLimit(val);
                setCursorStack([]);
                updateParams({ limit: val });
              }}
              options={[
                { value: 20, label: '20 / page' },
                { value: 50, label: '50 / page' },
                { value: 100, label: '100 / page' },
              ]}
            />
            <Button
              size="small"
              icon={<LeftOutlined />}
              disabled={cursorStack.length === 0 || isLoading}
              onClick={handlePrevPage}
            >
              {t('events.prev_page')}
            </Button>
            <Button
              size="small"
              icon={<RightOutlined />}
              disabled={!hasMore || isLoading}
              onClick={handleNextPage}
            >
              {t('events.next_page')}
            </Button>
          </div>
        </div>
      </Card>

      {/* Detail Drawer */}
      <UsageEventDrawer
        eventId={selectedEventId}
        onClose={() => setSelectedEventId(null)}
      />
    </div>
  );
};
