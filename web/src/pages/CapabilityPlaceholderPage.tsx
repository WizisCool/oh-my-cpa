import React from 'react';
import { Alert, Button, Card, Skeleton, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { api, apiErrorCode } from '../api/client';
import { useT } from '../i18n';
import type { ColumnsType } from 'antd/es/table';
import type { CapabilityCheckItem, CapabilityProbeReport, CapabilityStatus } from '../types/capability';
import { useIsPhoneViewport } from '../hooks/useIsPhoneViewport';
import { PhoneRow } from '../components/common/PhoneRow';
import { phoneRowFields, renderedCell } from '../components/common/phoneRowFields';

const { Text } = Typography;

interface CapabilityPlaceholderPageProps {
  /** Navigation dictionary key used for the localized page title. */
  navKey: string;
  capability: string;
}

function statusTagColor(status: CapabilityCheckItem['status']): string {
  switch (status) {
    case 'supported':
      return 'success';
    case 'missing':
      return 'warning';
    case 'offline':
    case 'error':
      return 'error';
  }
}

function overallStatusTone(status: CapabilityStatus): { color: string; labelKey: string } {
  switch (status) {
    case 'supported':
      return { color: 'success', labelKey: 'cap.status_supported' };
    case 'partial':
      return { color: 'warning', labelKey: 'cap.status_partial' };
    case 'missing':
      return { color: 'warning', labelKey: 'cap.status_missing' };
    case 'offline':
      return { color: 'error', labelKey: 'cap.status_offline' };
    case 'error':
      return { color: 'error', labelKey: 'cap.status_error' };
    case 'not_probeable':
      return { color: 'default', labelKey: 'cap.status_not_probeable' };
  }
}

export const CapabilityPlaceholderPage: React.FC<CapabilityPlaceholderPageProps> = ({ navKey, capability }) => {
  const t = useT();
  const { data, refetch, isPending, isError, error, isFetching } = useQuery<CapabilityProbeReport>({
    queryKey: ['capability', capability],
    queryFn: () => api.getCapability(capability),
    staleTime: 10000,
  });

  const tone = data ? overallStatusTone(data.status) : null;
  // Both above any early return, because hooks cannot come after one.
  const isPhone = useIsPhoneViewport();

  /**
   * The probe results' columns: the one description of a check.
   *
   * The table renders them and the phone row derives its labelled fields from the same array
   * (ADR 0012), so a check's endpoint, status code, latency and verdict cannot be printed one way
   * in a cell and another in a field.
   */
  const checkColumns: ColumnsType<CapabilityCheckItem> = [
    {
      title: t('cap.check_name'),
      dataIndex: 'name',
      key: 'name',
      width: 200,
      render: (val: string) => <Text strong>{val}</Text>,
    },
    {
      title: t('cap.check_endpoint'),
      dataIndex: 'endpoint',
      key: 'endpoint',
      render: (val: string) => <Text code>{val}</Text>,
    },
    {
      title: t('cap.check_http'),
      dataIndex: 'http_status',
      key: 'http_status',
      width: 100,
      render: (val: number) => (val > 0 ? <Text className="mono-num">{val}</Text> : '\u2014'),
    },
    {
      title: t('cap.check_latency'),
      dataIndex: 'latency_ms',
      key: 'latency_ms',
      width: 100,
      render: (val: number) => (val > 0 ? <Text className="mono-num">{val}ms</Text> : '\u2014'),
    },
    {
      title: t('cap.check_status'),
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (status: CapabilityCheckItem['status']) => (
        <Tag color={statusTagColor(status)} style={{ margin: 0 }}>
          {t(`cap.check_status_${status}`)}
        </Tag>
      ),
    },
  ];

  return (
    <div className="terminal-page capability-page">
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t(`nav.${navKey}`)}</h1>
        </div>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          onClick={() => refetch()}
          loading={isFetching}
        >
          {t('cap.refresh_status')}
        </Button>
      </div>

      {isPending ? (
        <Card size="small" className="capability-card">
          <Skeleton active paragraph={{ rows: 3 }} />
        </Card>
      ) : isError ? (
        <Alert
          type="error"
          showIcon
          description={apiErrorCode(error) === 'cpa_unavailable' ? t('cap.status_offline') : t('cap.status_error')}
        />
      ) : data ? (
        <div className="capability-content">
          <div className="capability-status-banner">
            <Tag color={tone?.color} className="capability-status-tag">
              {tone ? t(tone.labelKey) : data.status}
            </Tag>
            <Text type="secondary" className="capability-probe-time">
              {t('cap.probe_time', { time: dayjs(data.probed_at_ms).format('YYYY-MM-DD HH:mm:ss') })}
            </Text>
          </div>

          {isPhone ? (
            <>
              {data.checks.map((check, index) => (
                <PhoneRow
                  key={check.name}
                  identity={renderedCell(checkColumns, 'name', check, index)}
                  fields={phoneRowFields(checkColumns, check, { skip: ['name'], index })}
                />
              ))}
            </>
          ) : (
            <Table<CapabilityCheckItem>
              size="small"
              rowKey="name"
              dataSource={data.checks}
              pagination={false}
              columns={checkColumns}
            />
          )}
        </div>
      ) : null}
    </div>
  );
};
