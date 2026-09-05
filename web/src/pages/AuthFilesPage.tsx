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
  CheckSquareOutlined,
} from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT, type TFunc } from '../i18n';
import type { ManagementAuthFile } from '../types/managementAuthFile';
import {
  chunkItems,
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
  const { message, modal } = AntdApp.useApp();
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
  const [isOperating, setIsOperating] = useState(false);

  // Synchronous operation gate
  const operationLockRef = useRef<boolean>(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const acquireLock = (): boolean => {
    if (operationLockRef.current) return false;
    operationLockRef.current = true;
    setIsOperating(true);
    return true;
  };

  const releaseLock = () => {
    operationLockRef.current = false;
    setIsOperating(false);
  };

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

  // Provider tabs calculation: known providers first, then any extra providers observed (including unknown)
  const tabProviders = useMemo(() => {
    const extras = files
      .map(providerOf)
      .filter((p) => p && !KNOWN_PROVIDERS.includes(p));
    return ['all', ...KNOWN_PROVIDERS, ...Array.from(new Set(extras)).sort()];
  }, [files]);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { all: files.length };
    for (const p of KNOWN_PROVIDERS) {
      counts[p] = 0;
    }
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

  const invalidate = async (clearSelection = false) => {
    if (clearSelection) {
      setSelected([]);
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['management-auth-files'] }),
      queryClient.invalidateQueries({ queryKey: ['management-overview'] }),
    ]);
  };

  // Upload mutation
  const uploadMutation = useMutation({
    mutationFn: (uploadFiles: File[]) => api.uploadManagementAuthFiles(uploadFiles),
    onSuccess: async (result) => {
      if (result.failed && result.failed.length > 0) {
        modal.warning({
          title: t('af.failure_details_title'),
          content: (
            <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 8 }}>
              {result.failed.map((item) => (
                <div key={item.name} style={{ fontSize: 12, marginBottom: 4 }}>
                  <span className="mono-num">{item.name}</span>: {item.error}
                </div>
              ))}
            </div>
          ),
        });
      } else {
        message.success(t('af.uploaded', { n: result.uploaded ?? 0 }));
      }
      await invalidate(false);
    },
    onError: (error) => message.error(safeError(error, t)),
    onSettled: () => {
      releaseLock();
    },
  });

  // Single file download (with runtime-only guard)
  const downloadMutation = useMutation({
    mutationFn: (file: ManagementAuthFile) => {
      const currentFiles = filesQuery.data?.files ?? [];
      const target = currentFiles.find((f) => f.name === file.name);
      if (!target || target.runtime_only) {
        throw new Error(t('af.runtime_only_badge'));
      }
      return api.downloadManagementAuthFile(target.name);
    },
    onSuccess: (blob, file) => downloadBlob(blob, file.name),
    onError: (error) => message.error(safeError(error, t)),
  });

  // Single file delete (revalidates non-runtime eligibility and confirmed returned files)
  const deleteSingle = async (name: string) => {
    if (!acquireLock()) return;
    try {
      const currentFiles = filesQuery.data?.files ?? [];
      const target = currentFiles.find((f) => f.name === name);
      if (!target || target.runtime_only) return;

      setBusyFiles((prev) => ({ ...prev, [name]: true }));
      const result = await api.deleteManagementAuthFiles([name]);
      const isConfirmed = result.files && result.files.includes(name);
      if (isConfirmed) {
        message.success(t('af.deleted', { n: 1 }));
        setSelected((prev) => prev.filter((n) => n !== name));
        await invalidate(false);
      } else {
        const errMsg = (result.failed && result.failed[0]?.error) || t('af.request_failed');
        message.error(errMsg);
      }
    } catch (err) {
      message.error(safeError(err, t));
    } finally {
      setBusyFiles((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      releaseLock();
    }
  };

  // Single file status toggle (uses isAuthFileDisabled to correctly toggle both disabled flag and status='disabled')
  const toggleSingleStatus = async (file: ManagementAuthFile) => {
    if (!acquireLock()) return;
    try {
      const currentFiles = filesQuery.data?.files ?? [];
      const target = currentFiles.find((f) => f.name === file.name);
      if (!target || target.runtime_only) return;

      setBusyFiles((prev) => ({ ...prev, [target.name]: true }));
      const isCurrentlyDisabled = isAuthFileDisabled(target);
      await api.setManagementAuthFileStatus(target.name, !isCurrentlyDisabled, target.auth_index);
      await invalidate(false);
    } catch (err) {
      message.error(safeError(err, t));
    } finally {
      setBusyFiles((prev) => {
        const next = { ...prev };
        delete next[file.name];
        return next;
      });
      releaseLock();
    }
  };

  // Batch status change (preserves failed selections and removes only confirmed successes)
  const handleBatchStatus = async (disabled: boolean) => {
    if (!acquireLock()) return;
    try {
      const currentFiles = filesQuery.data?.files ?? [];
      const targetFiles = selected
        .map((name) => currentFiles.find((f) => f.name === name))
        .filter((f): f is ManagementAuthFile => Boolean(f && !f.runtime_only));

      if (targetFiles.length === 0) return;

      const outcome = await executeBatchStatus(
        targetFiles,
        disabled,
        (name, dis, authIdx) => api.setManagementAuthFileStatus(name, dis, authIdx),
        5
      );

      // Remove only confirmed successful names from selected
      const succeededSet = new Set(outcome.succeeded);
      setSelected((prev) => prev.filter((name) => !succeededSet.has(name)));

      if (outcome.failed.length > 0) {
        modal.warning({
          title: t('af.failure_details_title'),
          content: (
            <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 8 }}>
              {outcome.failed.map((item) => (
                <div key={item.name} style={{ fontSize: 12, marginBottom: 4 }}>
                  <span className="mono-num">{item.name}</span>: {item.error}
                </div>
              ))}
            </div>
          ),
        });
      } else {
        const successMsg = disabled
          ? t('af.batch_disable_success', { n: outcome.succeeded.length })
          : t('af.batch_enable_success', { n: outcome.succeeded.length });
        message.success(successMsg);
      }
      await invalidate(false);
    } catch (err) {
      message.error(safeError(err, t));
    } finally {
      releaseLock();
    }
  };

  // Batch delete (processes in chunks of 100, removes only confirmed deleted names)
  const handleBatchDelete = async () => {
    if (!acquireLock()) return;
    try {
      const currentFiles = filesQuery.data?.files ?? [];
      const targetNames = selected.filter((name) => {
        const f = currentFiles.find((item) => item.name === name);
        return Boolean(f && !f.runtime_only);
      });

      if (targetNames.length === 0) return;

      const confirmedDeletedNames: string[] = [];
      const failedItems: Array<{ name: string; error: string }> = [];

      for (const chunk of chunkItems(targetNames, 100)) {
        try {
          const res = await api.deleteManagementAuthFiles(chunk);
          if (res.files && res.files.length > 0) {
            confirmedDeletedNames.push(...res.files);
          }
          if (res.failed && res.failed.length > 0) {
            for (const item of res.failed) {
              failedItems.push({ name: item.name, error: item.error || 'deletion failed' });
            }
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          chunk.forEach((name) => failedItems.push({ name, error: errMsg }));
        }
      }

      // Remove only confirmed deleted files from selected
      const deletedSet = new Set(confirmedDeletedNames);
      setSelected((prev) => prev.filter((name) => !deletedSet.has(name)));

      if (failedItems.length > 0) {
        modal.warning({
          title: t('af.failure_details_title'),
          content: (
            <div style={{ maxHeight: 200, overflowY: 'auto', marginTop: 8 }}>
              {failedItems.map((item) => (
                <div key={item.name} style={{ fontSize: 12, marginBottom: 4 }}>
                  <span className="mono-num">{item.name}</span>: {item.error}
                </div>
              ))}
            </div>
          ),
        });
      } else if (confirmedDeletedNames.length > 0) {
        message.success(t('af.deleted', { n: confirmedDeletedNames.length }));
      }
      await invalidate(false);
    } catch (err) {
      message.error(safeError(err, t));
    } finally {
      releaseLock();
    }
  };

  const handleSelectPage = () => {
    if (operationLockRef.current) return;
    setSelected((prev) => Array.from(new Set([...prev, ...selectableOnPage])));
  };

  const handleClearSelection = () => {
    if (operationLockRef.current) return;
    setSelected([]);
  };

  const handleUploadChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const filesToUpload = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (filesToUpload.length === 0) return;
    if (!acquireLock()) return;
    uploadMutation.mutate(filesToUpload);
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
    <div className={`terminal-page auth-files-page ${styles.authFilesPage}`}>
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
            disabled={isOperating}
          >
            {t('af.upload')}
          </Button>
          <Button
            type="text"
            icon={<ReloadOutlined />}
            onClick={() => filesQuery.refetch()}
            loading={filesQuery.isFetching}
            disabled={isOperating}
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
        isMutating={isOperating}
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

        {selectableOnPage.length > 0 && (
          <Button
            size="middle"
            icon={<CheckSquareOutlined />}
            onClick={handleSelectPage}
            disabled={isOperating}
          >
            {t('af.select_page_hint')}
          </Button>
        )}

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
          style={{ width: 105 }}
          options={[
            { value: 12, label: t('af.page_size_n', { n: 12 }) },
            { value: 24, label: t('af.page_size_n', { n: 24 }) },
            { value: 48, label: t('af.page_size_n', { n: 48 }) },
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
              const fileBusy = busyFiles[file.name] === true || isOperating;
              return (
                <AuthFileCard
                  key={`${file.name}:${file.auth_index ?? ''}`}
                  file={file}
                  compact={compactMode}
                  selected={selected.includes(file.name)}
                  busy={fileBusy}
                  onSelect={(checked) => {
                    if (isOperating) return;
                    setSelected((curr) =>
                      checked ? [...curr, file.name] : curr.filter((name) => name !== file.name)
                    );
                  }}
                  onToggle={() => toggleSingleStatus(file)}
                  onDownload={() => downloadMutation.mutate(file)}
                  onDelete={() => deleteSingle(file.name)}
                  onEdit={() => {
                    if (!isOperating) setSelectedFile(file);
                  }}
                  onShowModels={() => {
                    if (!isOperating) setModelsFile(file);
                  }}
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
