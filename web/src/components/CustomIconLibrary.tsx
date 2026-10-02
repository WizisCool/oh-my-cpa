import React, { useEffect, useId, useRef, useState } from 'react';
import { Button, Input, Segmented, Spin } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { api, apiErrorCode } from '../api/client';
import { useT } from '../i18n';
import { isDemoMode } from '../types/demoMode';
import {
  CUSTOM_ICONS_QUERY_KEY,
  MAX_CUSTOM_ICON_BYTES,
  canSaveCustomIcon,
  clearCustomIconAssignments,
  filterCustomIcons,
  type CustomIcon,
} from '../types/customIcons';
import {
  parseProviderIcons,
  PROVIDER_ICONS_PREFERENCE,
} from '../types/providerIcons';
import { useCustomIcons } from '../hooks/useCustomIcons';
import { LobeIcon } from './LobeIcon';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  PictureOutlined,
  PlusOutlined,
  SearchOutlined,
  UploadOutlined,
} from './icons';
import { LoadFailure, Notice, useToast } from './feedback';
import styles from './CustomIconLibrary.module.css';

interface Props {
  currentIcon?: string;
  onSelect: (reference: string) => Promise<void>;
  onDeleted?: (id: string) => void;
  onBusyChange?: (isBusy: boolean) => void;
  isSelecting: boolean;
}

export const CustomIconLibrary: React.FC<Props> = ({
  currentIcon,
  onSelect,
  onDeleted,
  onBusyChange,
  isSelecting,
}) => {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const icons = useCustomIcons();
  const regionID = useId();
  const [search, setSearch] = useState('');
  const [editor, setEditor] = useState<CustomIcon | 'new' | null>(null);
  const [deletingIcon, setDeletingIcon] = useState<CustomIcon | null>(null);
  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [fileName, setFileName] = useState('');
  const [mode, setMode] = useState<'file' | 'base64'>('file');
  const [preview, setPreview] = useState('');
  const [previewMIME, setPreviewMIME] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [error, setError] = useState('');
  const [savedID, setSavedID] = useState('');
  const sequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const cancelDeleteButton = useRef<HTMLButtonElement>(null);
  const shouldRestoreFocus = useRef(false);
  const isDemo = isDemoMode();
  const visibleIcons = filterCustomIcons(icons.data ?? [], search);
  const isNew = editor === 'new';
  const hasReplacement = Boolean(source.trim() || fileName);
  const canSave = canSaveCustomIcon({
    name,
    originalName: editor && editor !== 'new' ? editor.name : undefined,
    isNew,
    hasReplacement,
    hasValidatedPreview: Boolean(preview),
    isBusy,
  });

  useEffect(() => {
    onBusyChange?.(isBusy);
    return () => onBusyChange?.(false);
  }, [isBusy, onBusyChange]);
  useEffect(() => {
    if (deletingIcon) cancelDeleteButton.current?.focus();
    else if (!editor && !isBusy && shouldRestoreFocus.current) {
      addButton.current?.focus();
      shouldRestoreFocus.current = false;
    }
  }, [editor, deletingIcon, isBusy, icons.data]);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );

  const showError = (reason: unknown) =>
    setError(
      t(CUSTOM_ICON_ERROR_KEYS[apiErrorCode(reason)] ?? 'icons.error_unknown'),
    );
  const resetReplacement = () => {
    sequence.current++;
    setSource('');
    setFileName('');
    setPreview('');
    setPreviewMIME('');
    setError('');
  };
  const returnToLibrary = () => {
    resetReplacement();
    shouldRestoreFocus.current = true;
    setEditor(null);
    setDeletingIcon(null);
  };
  const openEditor = (icon: CustomIcon | 'new') => {
    resetReplacement();
    setEditor(icon);
    setName(icon === 'new' ? '' : icon.name);
    setMode('file');
  };
  const validateSource = async (data: string) => {
    const requestSequence = ++sequence.current;
    setSource(data);
    setPreview('');
    setPreviewMIME('');
    setError('');
    setIsBusy(true);
    try {
      const response = await api.previewCustomIcon(data);
      if (requestSequence === sequence.current) {
        setPreview(response.data_url);
        setPreviewMIME(response.mime_type);
      }
    } catch (reason) {
      if (requestSequence === sequence.current) showError(reason);
    } finally {
      if (requestSequence === sequence.current) setIsBusy(false);
    }
  };
  const readFile = async (file?: File) => {
    if (!file || isBusy) return;
    resetReplacement();
    setFileName(file.name);
    const requestSequence = sequence.current;
    if (file.size > MAX_CUSTOM_ICON_BYTES) {
      setError(t('icons.error_size'));
      return;
    }
    setIsBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      if (requestSequence !== sequence.current) return;
      if (!name.trim()) setName(file.name.replace(/\.[^.]+$/, '').slice(0, 80));
      await validateSource(data);
    } catch (reason) {
      if (requestSequence === sequence.current) {
        showError(reason);
        setIsBusy(false);
      }
    }
  };
  const saveIcon = async () => {
    if (!editor || !canSave) return;
    setIsBusy(true);
    setError('');
    try {
      const icon =
        editor === 'new'
          ? await api.createCustomIcon(name.trim(), source)
          : await api.updateCustomIcon(editor.id, {
              name: name.trim(),
              ...(source ? { data: source } : {}),
            });
      await queryClient.invalidateQueries({ queryKey: CUSTOM_ICONS_QUERY_KEY });
      setSavedID(icon.id);
      setSearch('');
      returnToLibrary();
      toast.success(t('icons.saved'));
    } catch (reason) {
      showError(reason);
    } finally {
      setIsBusy(false);
    }
  };
  const deleteIcon = async () => {
    if (!deletingIcon || isBusy) return;
    const id = deletingIcon.id;
    setIsBusy(true);
    setError('');
    try {
      await api.deleteCustomIcon(id);
      await queryClient.cancelQueries({ queryKey: ['preferences'] });
      // The server only removes matching overrides. Mirror that projection instead
      // of refetching the whole document over unrelated optimistic preference edits.
      queryClient.setQueryData<Record<string, unknown>>(
        ['preferences'],
        (cached) =>
          cached
            ? {
                ...cached,
                [PROVIDER_ICONS_PREFERENCE]: clearCustomIconAssignments(
                  parseProviderIcons(cached[PROVIDER_ICONS_PREFERENCE]),
                  id,
                ),
              }
            : cached,
      );
      queryClient.setQueryData<CustomIcon[]>(CUSTOM_ICONS_QUERY_KEY, (cached) =>
        cached?.filter((icon) => icon.id !== id),
      );
      onDeleted?.(id);
      await queryClient.invalidateQueries({ queryKey: CUSTOM_ICONS_QUERY_KEY });
      returnToLibrary();
      toast.success(t('icons.deleted'));
    } catch (reason) {
      showError(reason);
    } finally {
      setIsBusy(false);
    }
  };

  const renderArtwork = (size: number) =>
    preview ? (
      <img
        src={preview}
        alt={size === 64 ? t('icons.preview') : ''}
        width={size}
        height={size}
      />
    ) : editor && editor !== 'new' ? (
      <LobeIcon iconId={`custom:${editor.id}`} size={size} />
    ) : (
      <PictureOutlined
        className={styles['preview-placeholder']}
        style={{ fontSize: size === 64 ? 32 : 20 }}
      />
    );

  if (editor)
    return (
      <section
        className={styles['editor']}
        aria-labelledby={`${regionID}-editor-title`}
      >
        <header className={styles['view-header']}>
          <Button
            type="text"
            icon={<ArrowLeftOutlined />}
            disabled={isBusy}
            onClick={returnToLibrary}
          >
            {t('icons.back')}
          </Button>
          <div>
            <h3 id={`${regionID}-editor-title`}>
              {t(isNew ? 'icons.add' : 'icons.edit_title')}
            </h3>
          </div>
        </header>
        <div className={styles['editor-body']}>
          <div className={styles['editor-fields']}>
            <label className={styles['field']}>
              <span>{t('icons.name')}</span>
              <Input
                value={name}
                maxLength={80}
                disabled={isBusy}
                placeholder={t('icons.name_hint')}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </label>
            <div className={styles['source-heading']}>
              <span>{t('icons.artwork')}</span>
              {editor !== 'new' && hasReplacement && (
                <Button
                  type="link"
                  size="small"
                  disabled={isBusy}
                  onClick={resetReplacement}
                >
                  {t('icons.keep_artwork')}
                </Button>
              )}
            </div>
            <Segmented
              block
              value={mode}
              disabled={isBusy}
              options={[
                { value: 'file', label: t('icons.file') },
                { value: 'base64', label: t('icons.base64') },
              ]}
              onChange={(value) => {
                resetReplacement();
                setMode(value as 'file' | 'base64');
              }}
            />
            {mode === 'file' ? (
              <div
                className={[
                  styles['dropzone'],
                  isDragActive ? styles['dropzone-active'] : '',
                ].join(' ')}
                onDragOver={(event) => {
                  event.preventDefault();
                  if (!isBusy) setIsDragActive(true);
                }}
                onDragLeave={() => setIsDragActive(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragActive(false);
                  if (!isBusy) void readFile(event.dataTransfer.files[0]);
                }}
              >
                <UploadOutlined className={styles['upload-mark']} />
                <strong>{t('icons.drop_title')}</strong>
                <span>{t('icons.drop_hint')}</span>
                <Button
                  icon={<PlusOutlined />}
                  disabled={isBusy}
                  onClick={() => fileInput.current?.click()}
                >
                  {t('icons.choose_file')}
                </Button>
                <input
                  ref={fileInput}
                  className={styles['file-input']}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  tabIndex={-1}
                  aria-label={t('icons.file')}
                  disabled={isBusy}
                  onChange={(event) => {
                    void readFile(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
                {fileName && (
                  <span className={styles['file-name']} title={fileName}>
                    {fileName}
                  </span>
                )}
              </div>
            ) : (
              <div className={styles['base64-input']}>
                <label className={styles['field']}>
                  <span className={styles['visually-hidden']}>
                    {t('icons.base64')}
                  </span>
                  <Input.TextArea
                    rows={6}
                    value={source}
                    disabled={isBusy}
                    placeholder={t('icons.base64_hint')}
                    onChange={(event) => {
                      sequence.current++;
                      setSource(event.target.value);
                      setPreview('');
                      setPreviewMIME('');
                      setError('');
                    }}
                  />
                </label>
                <Button
                  icon={<CheckOutlined />}
                  disabled={!source.trim() || isBusy}
                  onClick={() => void validateSource(source)}
                >
                  {t('icons.preview')}
                </Button>
              </div>
            )}
            <p className={styles['limits']}>{t('icons.limits')}</p>
            {preview && (
              <div className={styles['validated']} role="status">
                <CheckCircleOutlined />
                {t('icons.validated')}
                <span>
                  {previewMIME
                    .replace('image/', '')
                    .replace('svg+xml', 'SVG')
                    .toUpperCase()}
                </span>
              </div>
            )}
            {error && <Notice tone="error" title={error} />}
          </div>
          <aside
            className={styles['preview-panel']}
            aria-label={t('icons.preview_title')}
          >
            <h4>{t('icons.preview_title')}</h4>
            <div className={styles['preview-large']}>
              {isBusy ? <Spin /> : renderArtwork(64)}
            </div>
            <span className={styles['preview-caption']}>64 × 64</span>
            <div className={styles['preview-small']}>
              <span>{t('icons.list_preview')}</span>
              {renderArtwork(24)}
            </div>
            <p className={styles['preview-note']}>
              {t(
                preview
                  ? 'icons.preview_ready'
                  : editor !== 'new'
                    ? 'icons.preview_current'
                    : 'icons.preview_hint',
              )}
            </p>
          </aside>
        </div>
        <footer className={styles['view-footer']}>
          <Button disabled={isBusy} onClick={returnToLibrary}>
            {t('common.cancel')}
          </Button>
          <Button
            type="primary"
            icon={<CheckOutlined />}
            loading={isBusy}
            disabled={!canSave}
            onClick={() => void saveIcon()}
          >
            {t('icons.save')}
          </Button>
        </footer>
      </section>
    );

  if (deletingIcon)
    return (
      <section
        className={styles['deletion']}
        data-testid="custom-icon-deletion"
        aria-labelledby={`${regionID}-delete-title`}
      >
        <div className={styles['delete-artwork']}>
          <LobeIcon iconId={`custom:${deletingIcon.id}`} size={48} />
          <span>
            <ExclamationCircleOutlined />
          </span>
        </div>
        <h3 id={`${regionID}-delete-title`}>
          {t('icons.delete_confirm', { name: deletingIcon.name })}
        </h3>
        <p>
          {t(
            deletingIcon.reference_count
              ? 'icons.delete_references'
              : 'icons.delete_unused',
            { n: deletingIcon.reference_count },
          )}
        </p>
        {Boolean(deletingIcon.reference_count) && (
          <div className={styles['delete-impact']}>
            <span>
              {t('icons.references', { n: deletingIcon.reference_count })}
            </span>
            <ArrowLeftOutlined />
            <span>{t('icons.default_artwork')}</span>
          </div>
        )}
        {error && <Notice tone="error" title={error} />}
        <footer className={styles['view-footer']}>
          <Button
            ref={cancelDeleteButton}
            disabled={isBusy}
            onClick={returnToLibrary}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="primary"
            danger
            icon={<DeleteOutlined />}
            loading={isBusy}
            onClick={() => void deleteIcon()}
          >
            {t(
              deletingIcon.reference_count
                ? 'icons.delete_reset'
                : 'icons.delete_action',
            )}
          </Button>
        </footer>
      </section>
    );

  return (
    <section
      className={styles['library']}
      aria-labelledby={`${regionID}-library-title`}
    >
      <header className={styles['library-header']}>
        <div>
          <h3 id={`${regionID}-library-title`}>
            {t('icons.library_title')}
            <span>{icons.data?.length ?? 0} / 100</span>
          </h3>
        </div>
        <Button
          ref={addButton}
          type="primary"
          icon={<PlusOutlined />}
          disabled={
            isDemo || isSelecting || isBusy || (icons.data?.length ?? 0) >= 100
          }
          onClick={() => openEditor('new')}
        >
          {t('icons.add')}
        </Button>
      </header>
      <Input
        className={styles['search']}
        prefix={<SearchOutlined />}
        aria-label={t('icons.search')}
        placeholder={t('icons.search')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        allowClear
      />
      {isDemo && <Notice tone="info" title={t('icons.demo')} />}
      {icons.isError ? (
        <LoadFailure
          title={t('icons.load_failed')}
          error={icons.error}
          onRetry={() => void icons.refetch()}
        />
      ) : icons.isPending ? (
        <div className={styles['loading']}>
          <Spin />
        </div>
      ) : visibleIcons.length === 0 ? (
        <div className={styles['empty']} data-testid="custom-icons-empty">
          <PictureOutlined />
          <h4>
            {t(search.trim() ? 'icons.search_empty' : 'icons.empty_title')}
          </h4>
          <p>
            {t(search.trim() ? 'icons.search_empty_hint' : 'icons.empty_hint')}
          </p>
          {search.trim() ? (
            <Button onClick={() => setSearch('')}>
              {t('icons.clear_search')}
            </Button>
          ) : (
            <Button
              icon={<PlusOutlined />}
              disabled={isDemo}
              onClick={() => openEditor('new')}
            >
              {t('icons.add_first')}
            </Button>
          )}
        </div>
      ) : (
        <div className={styles['grid']}>
          {visibleIcons.map((icon) => {
            const isSelected = currentIcon === `custom:${icon.id}`;
            return (
              <article
                key={icon.id}
                className={[
                  styles['tile'],
                  isSelected || savedID === icon.id
                    ? styles['tile-highlighted']
                    : '',
                ].join(' ')}
                data-custom-icon-id={icon.id}
              >
                <button
                  className={styles['pick']}
                  data-icon-id={`custom:${icon.id}`}
                  disabled={isSelecting || isBusy}
                  aria-pressed={isSelected}
                  onClick={() => void onSelect(`custom:${icon.id}`)}
                  title={icon.name}
                >
                  <span className={styles['tile-artwork']}>
                    <LobeIcon
                      iconId={`custom:${icon.id}`}
                      size={40}
                      loading="lazy"
                    />
                    {isSelected && (
                      <CheckOutlined className={styles['selected-mark']} />
                    )}
                  </span>
                  <span className={styles['name']}>{icon.name}</span>
                </button>
                <div className={styles['tile-meta']}>
                  <span>
                    {icon.mime_type
                      .replace('image/', '')
                      .replace('svg+xml', 'SVG')
                      .toUpperCase()}
                  </span>
                  <span>
                    {t(
                      icon.reference_count
                        ? 'icons.references'
                        : 'icons.unused',
                      { n: icon.reference_count },
                    )}
                  </span>
                </div>
                <div className={styles['actions']}>
                  <Button
                    size="small"
                    type="text"
                    icon={<EditOutlined />}
                    disabled={isDemo || isBusy || isSelecting}
                    onClick={() => openEditor(icon)}
                  >
                    {t('common.edit')}
                  </Button>
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    aria-label={t('common.delete')}
                    title={t('icons.delete_action')}
                    disabled={isDemo || isBusy || isSelecting}
                    onClick={() => {
                      setError('');
                      setDeletingIcon(icon);
                    }}
                  />
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};

const CUSTOM_ICON_ERROR_KEYS: Record<string, string> = {
  custom_icon_too_large: 'icons.error_size',
  custom_icon_invalid_image: 'icons.error_image',
  custom_icon_invalid_name: 'icons.error_name',
  custom_icon_not_found: 'icons.error_missing',
  custom_icon_limit: 'icons.error_limit',
};
