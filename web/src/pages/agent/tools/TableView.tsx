import React from 'react';
import { Button, Table, Tooltip } from 'antd';
import type { TableColumnsType } from 'antd';
import { CopyButton } from '../../../components/common/CopyButton';
import { DownloadOutlined } from '../../../components/icons';
import { exportFileName, viewToCSV } from '../../../agent/export';
import type { DisplayView } from '../../../agent/types';
import { useI18n } from '../../../i18n';
import { saveBlob } from '../../../utils/download';
import styles from '../AgentPage.module.css';

type Row = DisplayView['rows'][number];

const PAGE_SIZE = 10;

function compareCells(left: Row[string], right: Row[string]): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return String(left ?? '').localeCompare(String(right ?? ''), undefined, { numeric: true });
}

export interface TableViewProps {
  table: Pick<DisplayView, 'columns' | 'rows'>;
  /** Names the CSV file and the table's accessible caption. */
  title: string;
  /** Drawn on the table's head row, beside the actions. */
  heading?: React.ReactNode;
}

/**
 * Rows as an Ant Design table, sortable by any column, with the data one click from the clipboard
 * or a CSV file. The rows are the frozen dataset, so what the operator copies is exactly what the
 * answer showed.
 */
export function TableView({ table, title, heading }: TableViewProps) {
  const { t } = useI18n();
  const columns = React.useMemo<TableColumnsType<Row & { key: number }>>(() => table.columns.map(column => ({
    key: column,
    dataIndex: column,
    title: column,
    ellipsis: true,
    sorter: (left, right) => compareCells(left[column], right[column]),
    render: (value: Row[string]) => (value === null || value === undefined ? '' : String(value)),
  })), [table.columns]);
  const dataSource = React.useMemo(() => table.rows.map((row, index) => ({ ...row, key: index })), [table.rows]);
  const csv = React.useMemo(() => viewToCSV(table), [table]);
  return (
    <div className={styles['view-table']}>
      <div className={styles['view-head']}>
        {heading}
        <span className={styles['view-spacer']} />
        <CopyButton text={csv} label={t('agent.view.copy_csv')} />
        <Tooltip title={t('agent.view.download_csv')}>
          <Button
            type="text"
            size="small"
            aria-label={t('agent.view.download_csv')}
            icon={<DownloadOutlined />}
            onClick={() => saveBlob(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }), exportFileName(title, 'csv', new Date()))}
          />
        </Tooltip>
      </div>
      <Table
        size="small"
        columns={columns}
        dataSource={dataSource}
        pagination={dataSource.length > PAGE_SIZE ? { pageSize: PAGE_SIZE, size: 'small', showSizeChanger: false } : false}
        scroll={{ x: 'max-content' }}
        aria-label={title}
      />
    </div>
  );
}
