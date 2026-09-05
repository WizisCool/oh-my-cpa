import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Empty,
  Input,
  Pagination,
  Segmented,
  Select,
  Space,
  Spin,
  Tag,
} from 'antd';
import {
  AppstoreOutlined,
  BarsOutlined,
  ReloadOutlined,
  SearchOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT, type TFunc } from '../i18n';
import type { ManagementAuthFile } from '../types/managementAuthFile';
import {
  executeBatchStatus,
  filterAuthFiles,
  isAuthFileDisabled,
  isAuthFileHealthy,
  isAuthFileProblem,
  providerOf,
  sortAuthFiles,
  type AuthFileSortKey,
  type AuthFileStatusFilter,
} from '../components/authFiles/authFileLogic';
import { AuthFileCard } from '../components/authFiles/AuthFileCard';
import { AuthFileDetailDrawer } from '../components/authFiles/AuthFileDetailDrawer';
import { BatchActionBar } from '../components/authFiles/BatchActionBar';
import { ModelsModal } from '../components/authFiles/ModelsModal';
import { ProviderTabs } from '../components/authFiles/ProviderTabs';
import styles from './authFiles/AuthFilesPage.module.css';

const KNOWN_PROVIDERS = ['claude', 'antigravity', 'codex', 'xai', 'kimi'];

function safeError(error: unknown, t: TFunc): string {
  if (error instanceof ApiError && error.status === 501) return t('af.unsupported');
  return error instanceof Error ? error.message : t('af.request_failed');
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

export const AuthFilesPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();

  // Filters, sorting, view modes
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('all');
  const [statusFilter, setStatusFilter] = useState<AuthFileStatusFilter>('all');
  const [sortMode, setSortMode] = useState<AuthFileSortKey>('name-asc');
  const [compactMode, setCompactMode] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);

  // Selection and modal state
  const [selected, setSelected] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<ManagementAuthFile | null>(null);
  const [modelsFile, setModelsFile] = useState<ManagementAuthFile | null>(null);
  const [busyFiles, setBusyFiles] = useState<Record<string, boolean>>({});
  const [isBatchMutating, setIsBatchMutating] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);

  const filesQuery = useQuery({
    queryKey: ['management-auth-files'],
    queryFn: () => api.getManagementAuthFiles(),
    refetchInterval: 60000,
    staleTime: 10000,
    placeholderData: keepPreviousData,
  });

  const files = useMemo(() => filesQuery.data?.files ?? [], [filesQuery.data?.files]);

  // Non-runtime files lookup map for reconciling selection
  const nonRuntimeFilesMap = useMemo(() => {
    const map = new Map<string, ManagementAuthFile>();
    for (const f of files) {
      if (!f.runtime_only) {
        map.set(f.name, f);
      }
    }
    return map;
  }, [files]);

  // Reconcile selection with available non-runtime files
  useEffect(() => {
    setSelected((prev) => {
      const filtered = prev.filter((name) => nonRuntimeFilesMap.has(name));
      if (filtered.length !== prev.length) {
        return filtered;
      }
      return prev;
    });
  }, [nonRuntimeFilesMap]);

  // Telemetry counts across the full dataset
  const totalCount = files.length;
  const activeCount = useMemo(() => files.filter(isAuthFileHealthy).length, [files]);
  const disabledCount = useMemo(() => files.filter(isAuthFileDisabled).length, [files]);
  const problemCount = useMemo(() => files.filter(isAuthFileProblem).length, [files]);

  // Provider tabs calculation
  const tabProviders = useMemo(() => {
    const extras = files
      .map(providerOf)
      .filter((p) => p && !KNOWN_PROVIDERS.includes(p) && p !== 'unknown');
    return ['all', ...KNOWN_PROVIDERS, ...Array.from(new Set(extras)).sort()];
  }, [files]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { all: files.length };
    for (const f of files) {
      const p = providerOf(f);
      counts[p] = (counts[p] ?? 0) + 1;
    }
    return counts;
  }, [files]);

  // Filter & Sort
  const filtered = useMemo(
    () => filterAuthFiles(files, query, provider, statusFilter),
    [files, query, provider, statusFilter]
  );

  const sorted = useMemo(() => sortAuthFiles(filtered, sortMode), [filtered, sortMode]);

  // Reset page when filter / provider / query changes
  useEffect(() => {
    setPage(1);
  }, [query, provider, statusFilter, sortMode]);

  // Clamped pagination
  const maxPage = Math.max(1, Math.ceil(sorted.length / pageSize));
  useEffect(() => {
    if (page > maxPage) {
      setPage(maxPage);
    }
  }, [page, maxPage]);

  const pagedFiles = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sorted.slice(start, start + pageSize);
  }, [sorted, page, pageSize]);

  // Current page selectable items
  const selectableOnPage = useMemo(
    () => pagedFiles.filter((f) => !f.runtime_only).map((f) => f.name),
    [pagedFiles]
  );

  const invalidate = (clearSelection = false) => {
    if (clearSelection) {
      setSelected([]);
    }
    queryClient.invalidateQueries({ queryKey: ['management-auth-files'] });
    queryClient.invalidateQueries({ queryKey: ['management-overview'] });
  };

  // Upload mutation
  const uploadMutation = useMutation({
    mutationFn: (uploadFiles: File[]) => api.uploadManagementAuthFiles(uploadFiles),
    onSuccess: (result) => {
      if (result.failed && result.failed.length > 0) {
        message.warning(
          t('af.upload_partial', {
            uploaded: result.uploaded ?? 0,
            failed: result.failed.length,
          })
        );
      } else {
        message.success(t('af.uploaded', { n: result.uploaded ?? 0 }));
      }
      invalidate(false);
    },
    onError: (error) => message.error(safeError(error, t)),
  });

  // Single file download
  const downloadMutation = useMutation({
    mutationFn: (file: ManagementAuthFile) => api.downloadManagementAuthFile(file.name),
    onSuccess: (blob, file) => downloadBlob(blob, file.name),
    onError: (error) => message.error(safeError(error, t)),
  });

  // Single file delete
  const deleteSingle = async (name: string) => {
    try {
      setBusyFiles((prev) => ({ ...prev, [name]: true }));
      const result = await api.deleteManagementAuthFiles([name]);
      if (result.failed && result.failed.length > 0) {
        message.error(result.failed[0]?.error || t('af.request_failed'));
      } else {
        message.success(t('af.deleted', { n: 1 }));
        setSelected((prev) => prev.filter((n) => n !== name));
        invalidate(false);
      }
    } catch (err) {
      message.error(safeError(err, t));
    } finally {
      setBusyFiles((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

  // Single file status toggle (preserves selected list!)
  const toggleSingleStatus = async (file: ManagementAuthFile) => {
    const nextDisabled = !file.disabled;
    try {
      setBusyFiles((prev) => ({ ...prev, [file.name]: true }));
      await api.setManagementAuthFileStatus(file.name, nextDisabled, file.auth_index);
      invalidate(false);
    } catch (err) {
      message.error(safeError(err, t));
    } finally {
      setBusyFiles((prev) => {
        const next = { ...prev };
        delete next[file.name];
        return next;
      });
    }
  };

  // Batch status change
  const handleBatchStatus = async (disabled: boolean) => {
    const targetFiles = selected
      .map((name) => nonRuntimeFilesMap.get(name))
      .filter((f): f is ManagementAuthFile => Boolean(f));

    if (targetFiles.length === 0) return;

    setIsBatchMutating(true);
    try {
      const outcome = await executeBatchStatus(
        targetFiles,
        disabled,
        (name, dis, authIdx) => api.setManagementAuthFileStatus(name, dis, authIdx),
        5
      );

      if (outcome.failed.length > 0) {
        message.warning(
          t('af.batch_partial_failed', {
            succeeded: outcome.succeeded.length,
            failed: outcome.failed.length,
          })
        );
        const failedNames = new Set(outcome.failed.map((f) => f.name));
        setSelected((prev) => prev.filter((name) => failedNames.has(name)));
      } else {
        const successMsg = disabled
          ? t('af.batch_disable_success', { n: outcome.succeeded.length })
          : t('af.batch_enable_success', { n: outcome.succeeded.length });
        message.success(successMsg);
        setSelected([]);
      }
      invalidate(false);
    } catch (err) {
      message.error(safeError(err, t));
    } finally {
      setIsBatchMutating(false);
    }
  };

  // Batch delete (respects 100 limit)
  const handleBatchDelete = async () => {
    if (selected.length === 0) return;
    const namesToDelete = selected.slice(0, 100);

    setIsBatchMutating(true);
    try {
      const res = await api.deleteManagementAuthFiles(namesToDelete);
      if (res.failed && res.failed.length > 0) {
        message.warning(
          t('af.batch_partial_failed', {
            succeeded: res.deleted ?? 0,
            failed: res.failed.length,
          })
        );
        const failedNames = new Set(res.failed.map((f) => f.name));
        setSelected((prev) => prev.filter((name) => failedNames.has(name)));
      } else {
        message.success(t('af.deleted', { n: res.deleted ?? namesToDelete.length }));
        const deletedSet = new Set(res.files ?? namesToDelete);
        setSelected((prev) => prev.filter((name) => !deletedSet.has(name)));
      }
      invalidate(false);
    } catch (err) {
      message.error(safeError(err, t));
    } finally {
      setIsBatchMutating(false);
    }
  };

  const handleSelectPage = () => {
    setSelected((prev) => Array.from(new Set([...prev, ...selectableOnPage])));
  };

  const handleClearSelection = () => {
    setSelected([]);
  };

  const handleUploadChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const filesToUpload = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (filesToUpload.length > 0) {
      uploadMutation.mutate(filesToUpload);
    }
  };

  if (filesQuery.isLoading) {
    return (
      <div className="dashboard-loading">
        <Spin tip={t('af.loading')}>
          <div style={{ minHeight: 80, minWidth: 200 }} />
        </Spin>
      </div>
    );
  }

  if (filesQuery.isError) {
    return (
      <div className="terminal-page">
        <Alert
          type="error"
          showIcon
          description={`${t('af.error')} — ${safeError(filesQuery.error, t)}`}
          action={<Button onClick={() => filesQuery.refetch()}>{t('common.retry')}</Button>}
        />
      </div>
    );
  }

  return (
    <div className={`terminal-page ${styles.authFilesPage}`}>
      {/* Page Header */}
      <header className={styles.headTop}>
        <div>
          <h1 className="terminal-title">{t('nav.auth_files')}</h1>
          <Space size={8} wrap style={{ marginTop: 6 }}>
            <Tag style={{ margin: 0 }}>
              {t('af.meta_total', { n: totalCount })}
            </Tag>
            <Tag color="success" style={{ margin: 0 }}>
              {t('af.meta_active', { n: activeCount })}
            </Tag>
            <Tag style={{ margin: 0 }}>
              {t('af.meta_disabled', { n: disabledCount })}
            </Tag>
            {problemCount > 0 && (
              <Tag color="error" style={{ margin: 0 }}>
                {t('af.meta_problem', { n: problemCount })}
              </Tag>
            )}
          </Space>
        </div>

        <div className="auth-files-actions">
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            multiple
            hidden
            onChange={handleUploadChange}
          />
          <Button
            icon={<UploadOutlined />}
            onClick={() => fileInput.current?.click()}
            loading={uploadMutation.isPending}
          >
            {t('af.upload')}
          </Button>
          <Button
            type="text"
            icon={<ReloadOutlined />}
            onClick={() => filesQuery.refetch()}
            loading={filesQuery.isFetching}
          >
            {t('common.refresh')}
          </Button>
        </div>
      </header>

      {/* Provider Filter Tabs (Ant Design Tabs) */}
      <ProviderTabs
        providers={tabProviders}
        counts={tabCounts}
        active={provider}
        onChange={setProvider}
      />

      {/* Floating Batch Action Bar */}
      <BatchActionBar
        selectedCount={selected.length}
        selectablePageCount={selectableOnPage.length}
        isMutating={isBatchMutating}
        onSelectPage={handleSelectPage}
        onClearSelection={handleClearSelection}
        onEnable={() => handleBatchStatus(false)}
        onDisable={() => handleBatchStatus(true)}
        onDelete={handleBatchDelete}
      />

      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.searchBox}>
          <Input
            prefix={<SearchOutlined style={{ color: 'var(--meta)' }} />}
            allowClear
            placeholder={t('af.search_ph')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <Segmented<AuthFileStatusFilter>
          value={statusFilter}
          onChange={(val) => setStatusFilter(val)}
          options={[
            { label: t('af.status_all'), value: 'all' },
            { label: t('af.enabled'), value: 'enabled' },
            { label: t('af.disabled'), value: 'disabled' },
            {
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <span className={`${styles.statDot} ${styles.dotProblem}`} />
                  {t('af.status_problem')}
                </span>
              ),
              value: 'problem',
            },
          ]}
        />

        <Select<AuthFileSortKey>
          value={sortMode}
          onChange={setSortMode}
          style={{ width: 170 }}
          options={[
            { value: 'name-asc', label: t('af.sort_name_asc') },
            { value: 'name-desc', label: t('af.sort_name_desc') },
            { value: 'requests-desc', label: t('af.sort_requests') },
            { value: 'priority-desc', label: t('af.sort_priority') },
            { value: 'weight-desc', label: t('af.sort_weight') },
          ]}
        />

        <Segmented
          value={compactMode ? 'compact' : 'grid'}
          onChange={(val) => setCompactMode(val === 'compact')}
          options={[
            { value: 'grid', icon: <AppstoreOutlined />, title: t('af.view_regular') },
            { value: 'compact', icon: <BarsOutlined />, title: t('af.view_compact') },
          ]}
        />

        <Select
          value={pageSize}
          onChange={setPageSize}
          style={{ width: 95 }}
          options={[
            { value: 12, label: '12 / 页' },
            { value: 24, label: '24 / 页' },
            { value: 48, label: '48 / 页' },
          ]}
        />
      </div>

      {/* Cards Grid / Empty State */}
      {sorted.length === 0 ? (
        <div className="terminal-panel auth-files-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={files.length === 0 ? t('af.empty_all') : t('af.empty_filter')}
          />
        </div>
      ) : (
        <>
          <div className={compactMode ? styles.compactGrid : styles.cardsGrid}>
            {pagedFiles.map((file) => {
              const fileBusy = busyFiles[file.name] === true || isBatchMutating;
              return (
                <AuthFileCard
                  key={`${file.name}:${file.auth_index ?? ''}`}
                  file={file}
                  compact={compactMode}
                  selected={selected.includes(file.name)}
                  busy={fileBusy}
                  onSelect={(checked) =>
                    setSelected((curr) =>
                      checked ? [...curr, file.name] : curr.filter((name) => name !== file.name)
                    )
                  }
                  onToggle={() => toggleSingleStatus(file)}
                  onDownload={() => downloadMutation.mutate(file)}
                  onDelete={() => deleteSingle(file.name)}
                  onEdit={() => setSelectedFile(file)}
                  onShowModels={() => setModelsFile(file)}
                />
              );
            })}
          </div>

          {sorted.length > pageSize && (
            <div className={styles.paginationWrap}>
              <Pagination
                current={page}
                pageSize={pageSize}
                total={sorted.length}
                onChange={(newPage) => setPage(newPage)}
                showSizeChanger={false}
                showQuickJumper
              />
            </div>
          )}
        </>
      )}

      {/* Details & Configuration Drawer */}
      <AuthFileDetailDrawer
        file={selectedFile}
        open={Boolean(selectedFile)}
        onClose={() => setSelectedFile(null)}
        onSaved={() => {
          setSelectedFile(null);
          invalidate(false);
        }}
        onDownload={(f) => downloadMutation.mutate(f)}
      />

      {/* Quick Models Modal */}
      <ModelsModal
        file={modelsFile}
        open={Boolean(modelsFile)}
        onClose={() => setModelsFile(null)}
      />
    </div>
  );
};
