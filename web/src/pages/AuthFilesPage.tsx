import React from 'react';
import { Alert, App as AntdApp, Button, Empty, Input, Popconfirm, Select, Spin, Switch, Tag } from 'antd';
import { DeleteOutlined, DownloadOutlined, EditOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useT, type TFunc } from '../i18n';
import type { ManagementAuthFile } from '../types/managementAuthFile';
import { AuthFileDetailDrawer } from '../components/authFiles/AuthFileDetailDrawer';

function providerOf(file: ManagementAuthFile): string {
  return (file.type || file.provider || 'unknown').trim().toLowerCase();
}

function statusOf(file: ManagementAuthFile): string {
  if (file.disabled) return 'disabled';
  if (file.unavailable) return 'unavailable';
  return 'enabled';
}

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
  const [query, setQuery] = React.useState('');
  const [provider, setProvider] = React.useState('all');
  const [status, setStatus] = React.useState('all');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [selectedFile, setSelectedFile] = React.useState<ManagementAuthFile | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const statusOptions = React.useMemo(() => [
    { value: 'all', label: t('af.status_all') },
    { value: 'enabled', label: t('af.enabled') },
    { value: 'disabled', label: t('af.disabled') },
    { value: 'unavailable', label: t('af.unavailable') },
  ], [t]);

  const filesQuery = useQuery({
    queryKey: ['management-auth-files'],
    queryFn: () => api.getManagementAuthFiles(),
    refetchInterval: 60000,
    staleTime: 10000,
    // Existing cards stay on screen during a refresh instead of swapping out.
    placeholderData: keepPreviousData,
  });

  const invalidate = () => {
    setSelected([]);
    queryClient.invalidateQueries({ queryKey: ['management-auth-files'] });
    queryClient.invalidateQueries({ queryKey: ['management-overview'] });
  };

  const statusMutation = useMutation({
    mutationFn: ({ file, disabled }: { file: ManagementAuthFile; disabled: boolean }) => api.setManagementAuthFileStatus(file.name, disabled, file.auth_index),
    onSuccess: invalidate,
    onError: (error) => message.error(safeError(error, t)),
  });
  const deleteMutation = useMutation({
    mutationFn: (names: string[]) => api.deleteManagementAuthFiles(names),
    onSuccess: (result) => { message.success(t('af.deleted', { n: result.deleted ?? selected.length })); invalidate(); },
    onError: (error) => message.error(safeError(error, t)),
  });
  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => api.uploadManagementAuthFiles(files),
    onSuccess: (result) => { message.success(t('af.uploaded', { n: result.uploaded ?? 0 })); invalidate(); },
    onError: (error) => message.error(safeError(error, t)),
  });
  const downloadMutation = useMutation({
    mutationFn: (file: ManagementAuthFile) => api.downloadManagementAuthFile(file.name),
    onSuccess: (blob, file) => downloadBlob(blob, file.name),
    onError: (error) => message.error(safeError(error, t)),
  });

  const files = filesQuery.data?.files ?? [];
  const providers = Array.from(new Set(files.map(providerOf))).sort();
  const filtered = files.filter((file) => {
    const normalizedQuery = query.trim().toLowerCase();
    const matchesQuery = !normalizedQuery || [file.name, file.email, file.project_id, file.type, file.provider, file.auth_index].some((value) => value?.toLowerCase().includes(normalizedQuery));
    return matchesQuery && (provider === 'all' || providerOf(file) === provider) && (status === 'all' || statusOf(file) === status);
  });

  const handleUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const filesToUpload = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (filesToUpload.length > 0) uploadMutation.mutate(filesToUpload);
  };

  if (filesQuery.isLoading) return <div className="dashboard-loading"><Spin tip={t('af.loading')}><div style={{ minHeight: 80, minWidth: 200 }} /></Spin></div>;
  if (filesQuery.isError) return <div className="terminal-page"><Alert type="error" showIcon description={`${t('af.error')} — ${safeError(filesQuery.error, t)}`} action={<Button onClick={() => filesQuery.refetch()}>{t('common.retry')}</Button>} /></div>;

  return (
    <div className="terminal-page auth-files-page">
      <div className="terminal-page-head"><div><h1 className="terminal-title">{t('nav.auth_files')}</h1><p className="terminal-subtitle">{t('af.subtitle', { n: files.length })}</p></div><div className="auth-files-actions"><input ref={fileInput} type="file" accept=".json,application/json" multiple hidden onChange={handleUpload} /><Button icon={<UploadOutlined />} onClick={() => fileInput.current?.click()} loading={uploadMutation.isPending}>{t('af.upload')}</Button><Button type="text" icon={<ReloadOutlined />} onClick={() => filesQuery.refetch()} loading={filesQuery.isFetching}>{t('common.refresh')}</Button></div></div>
      {selected.length > 0 && <div className="batch-bar"><span>{t('af.selected_n', { n: selected.length })}</span><Popconfirm title={t('af.delete_selected_title')} description={t('af.delete_selected_desc')} onConfirm={() => deleteMutation.mutate(selected)} okText={t('common.delete')} cancelText={t('common.cancel')}><Button danger icon={<DeleteOutlined />} loading={deleteMutation.isPending}>{t('af.delete_selected')}</Button></Popconfirm></div>}
      <div className="auth-files-toolbar"><Input allowClear placeholder={t('af.search_ph')} value={query} onChange={(event) => setQuery(event.target.value)} /><Select value={provider} onChange={setProvider} options={[{ value: 'all', label: t('af.all_providers') }, ...providers.map((value) => ({ value, label: value }))]} /><Select value={status} onChange={setStatus} options={statusOptions} /></div>
      {filtered.length === 0 ? <div className="terminal-panel auth-files-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={files.length === 0 ? t('af.empty_all') : t('af.empty_filter')} /></div> : <div className="auth-files-grid">{filtered.map((file) => <AuthFileCard key={`${file.name}:${file.auth_index ?? ''}`} file={file} selected={selected.includes(file.name)} busy={statusMutation.isPending || downloadMutation.isPending} onSelect={(checked) => setSelected((current) => checked ? [...current, file.name] : current.filter((name) => name !== file.name))} onToggle={() => statusMutation.mutate({ file, disabled: !file.disabled })} onDownload={() => downloadMutation.mutate(file)} onDelete={() => deleteMutation.mutate([file.name])} onEdit={() => setSelectedFile(file)} />)}</div>}

      <AuthFileDetailDrawer
        file={selectedFile}
        open={Boolean(selectedFile)}
        onClose={() => setSelectedFile(null)}
        onSaved={() => {
          setSelectedFile(null);
          invalidate();
        }}
        onDownload={(f) => downloadMutation.mutate(f)}
      />
    </div>
  );
};

const AuthFileCard: React.FC<{
  file: ManagementAuthFile;
  selected: boolean;
  busy: boolean;
  onSelect: (checked: boolean) => void;
  onToggle: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onEdit: () => void;
}> = ({ file, selected, busy, onSelect, onToggle, onDownload, onDelete, onEdit }) => {
  const t = useT();
  return (
    <article className={`terminal-panel auth-file-card ${selected ? 'is-selected' : ''}`}>
      <div className="auth-file-card-head">
        <input type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)} aria-label={t('af.select_one', { name: file.name })} />
        <span className={`auth-status ${file.disabled ? 'is-disabled' : file.unavailable ? 'is-unavailable' : 'is-active'}`} />
        <div className="auth-file-name" title={file.name}>{file.name}</div>
        <Tag>{file.type || file.provider || 'unknown'}</Tag>
      </div>
      <div className="auth-file-identity">{file.email || file.project_id || t('af.identity_missing')}</div>
      <div className="auth-file-meta">
        <span>auth: {file.auth_index || '—'}</span>
        <span>{t('dash.success_n', { n: file.success })}</span>
        <span>{t('dash.failure_n', { n: file.failed })}</span>
        {file.priority !== undefined && file.priority > 0 && <Tag style={{ margin: 0, fontSize: 10 }}>P:{file.priority}</Tag>}
        {file.weight !== undefined && file.weight !== 1 && <Tag style={{ margin: 0, fontSize: 10 }}>W:{file.weight}</Tag>}
      </div>
      {file.note && <div className="auth-file-note">{file.note}</div>}
      <div className="auth-file-footer">
        <span className="terminal-muted">{file.disabled ? 'DISABLED' : file.unavailable ? 'UNAVAILABLE' : 'ACTIVE'}</span>
        <Button
          type="link"
          size="small"
          icon={<EditOutlined />}
          onClick={onEdit}
          style={{ padding: '0 4px', fontSize: 12 }}
        >
          {t('common.edit')}
        </Button>
        <Switch size="small" checked={!file.disabled} disabled={busy || file.runtime_only} onChange={onToggle} />
        <Button type="text" size="small" icon={<DownloadOutlined />} disabled={busy || file.runtime_only} onClick={onDownload} aria-label={t('af.download_one', { name: file.name })} />
        <Popconfirm title={t('af.delete_one_title')} onConfirm={onDelete} okText={t('common.delete')} cancelText={t('common.cancel')}>
          <Button type="text" danger size="small" icon={<DeleteOutlined />} disabled={busy || file.runtime_only} aria-label={t('af.delete_one', { name: file.name })} />
        </Popconfirm>
      </div>
    </article>
  );
};
