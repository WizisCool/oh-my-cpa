import React from 'react';
import { AutoComplete, Button, Modal, Select, type SelectProps } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, apiErrorCode } from '../../api/client';
import { useT } from '../../i18n';
import { useFontLibrary, useFontRoles } from '../../hooks/useFonts';
import { forgetLibraryFont, registerLibraryFont } from '../../theme/fontLibrary';
import {
  BUILT_IN_FONTS,
  FONT_PREFERENCE_KEY,
  FONT_ROLES,
  FONT_UPLOAD_ACCEPT,
  FONTS_QUERY_KEY,
  GOOGLE_FONT_SUGGESTIONS,
  builtInRef,
  fontStackFor,
  libraryRef,
  type FontRole,
  type InstalledFont,
} from '../../types/fonts';
import { formatBytes } from '../../utils/format';
import { ConfirmAction } from '../common/ConfirmAction';
import { EmptyState } from '../common/EmptyState';
import { SettingRow } from '../common/SettingRow';
import { useToast } from '../feedback';
import { CloudDownloadOutlined, DeleteOutlined, ExternalLinkOutlined, UploadOutlined } from '../icons';
import styles from './FontSettings.module.css';

const ROLE_LABEL_KEYS: Record<FontRole, { label: string; description: string }> = {
  ui: { label: 'omc.font_ui', description: 'omc.font_ui_desc' },
  mono: { label: 'omc.font_mono', description: 'omc.font_mono_desc' },
};

const ERROR_KEYS: Record<string, string> = {
  font_invalid_file: 'omc.font_error_invalid',
  font_too_large: 'omc.font_error_too_large',
  font_limit: 'omc.font_error_limit',
  font_invalid_family: 'omc.font_error_family',
  font_not_found: 'omc.font_error_missing',
  font_google_family_not_found: 'omc.font_error_google_missing',
  font_google_unreachable: 'omc.font_error_google_unreachable',
};

function useFontErrorText() {
  const t = useT();
  return React.useCallback((error: unknown) => {
    const key = ERROR_KEYS[apiErrorCode(error) ?? ''];
    return key ? t(key) : undefined;
  }, [t]);
}

/**
 * FontSettings is the typeface half of the appearance group: the two role pickers, and the
 * entry to the font library behind them.
 *
 * It follows the shape WordPress's Font Library settled on - one library of installed
 * families, filled by uploading files or by installing from Google Fonts, from which each
 * typographic role is chosen - because it keeps "which fonts this deployment has" apart
 * from "which font this role uses". Installing does not switch anything, and switching
 * never downloads anything: every family in a picker is already stored here, so a choice
 * repaints the console on the frame it is made.
 *
 * The library is managed in a dialog rather than inline. Choosing a role is the frequent
 * act and belongs on the page; maintaining the library is occasional, and a list of
 * families with their own actions would make a settings page of one-line rows grow a
 * panel no other setting has.
 */
export const FontSettings: React.FC = () => {
  const t = useT();
  const library = useFontLibrary();
  const fonts = React.useMemo(() => library.data ?? [], [library.data]);
  const [isLibraryOpen, setIsLibraryOpen] = React.useState(false);

  // Each picker option draws its family's own name in that family. That is the preview: the
  // browser fetches only the slices those few characters need.
  React.useEffect(() => {
    fonts.forEach((font) => registerLibraryFont(font));
  }, [fonts]);

  return (
    <>
      {FONT_ROLES.map((role) => (
        <SettingRow
          key={role}
          label={t(ROLE_LABEL_KEYS[role].label)}
          description={t(ROLE_LABEL_KEYS[role].description)}
          control={<FontPicker role={role} fonts={fonts} />}
        />
      ))}
      <SettingRow
        label={t('omc.font_library')}
        description={fonts.length ? t('omc.font_library_count', { n: fonts.length }) : t('omc.font_library_desc')}
        control={<Button onClick={() => setIsLibraryOpen(true)}>{t('omc.font_library_manage')}</Button>}
      />
      <FontLibraryDialog open={isLibraryOpen} fonts={fonts} isLoading={library.isPending} onClose={() => setIsLibraryOpen(false)} />
    </>
  );
};

const FontPicker: React.FC<{ role: FontRole; fonts: readonly InstalledFont[] }> = ({ role, fonts }) => {
  const t = useT();
  const { value, loaded, setRole } = useFontRoles();
  const builtIns: SelectProps['options'] = BUILT_IN_FONTS.map((font) => ({
    value: builtInRef(font.id),
    label: <span style={{ fontFamily: font.stack }}>{t(font.nameKey)}</span>,
    title: t(font.nameKey),
  }));
  const installed: NonNullable<SelectProps['options']> = fonts.map((font) => ({
    value: libraryRef(font.id),
    label: <span style={{ fontFamily: fontStackFor(libraryRef(font.id), fonts) }}>{font.family}</span>,
    title: font.family,
  }));
  return (
    <Select<string>
      className={styles.picker}
      value={value[role]}
      disabled={!loaded}
      onChange={(next) => { void setRole(role, next); }}
      aria-label={t(ROLE_LABEL_KEYS[role].label)}
      popupMatchSelectWidth={false}
      options={installed.length
        ? [
          { label: t('omc.font_group_builtin'), title: t('omc.font_group_builtin'), options: builtIns },
          { label: t('omc.font_group_library'), title: t('omc.font_group_library'), options: installed },
        ]
        : builtIns}
    />
  );
};

const GOOGLE_FONTS_SITE = 'https://fonts.google.com/';

/**
 * FontLibraryDialog is the library: installing from Google Fonts, uploading, and the
 * installed families.
 *
 * The Google install is a field inside the dialog rather than a dialog of its own, so the
 * library never stacks a second modal over the first. The server does the download, so the
 * field cannot preview a family without breaking the rule that the browser loads nothing
 * from another host; Google's catalogue is linked for that, and an installed family
 * previews itself in the list the moment it lands.
 */
const FontLibraryDialog: React.FC<{ open: boolean; fonts: readonly InstalledFont[]; isLoading: boolean; onClose: () => void }> = ({ open, fonts, isLoading, onClose }) => {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const errorText = useFontErrorText();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [family, setFamily] = React.useState('');
  const abort = React.useRef<AbortController | null>(null);

  const addToLibrary = (font: InstalledFont) => {
    queryClient.setQueryData<InstalledFont[]>(FONTS_QUERY_KEY, (cached) => [font, ...(cached ?? [])]);
    toast.success(t('omc.font_added', { family: font.family }));
  };
  const install = useMutation({
    mutationFn: (name: string) => {
      abort.current = new AbortController();
      return api.installGoogleFont(name, abort.current.signal);
    },
    onSuccess: (font) => {
      addToLibrary(font);
      setFamily('');
    },
    onError: (error) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      toast.error(errorText(error) ?? t('omc.font_install_failed'), { error });
    },
  });
  const upload = useMutation({
    mutationFn: (files: File[]) => api.uploadFont(files),
    onSuccess: addToLibrary,
    onError: (error) => toast.error(errorText(error) ?? t('omc.font_upload_failed'), { error }),
  });

  const trimmed = family.trim();
  const query = trimmed.toLocaleLowerCase();
  const suggestions = GOOGLE_FONT_SUGGESTIONS
    .filter((suggestion) => suggestion.family.toLocaleLowerCase().includes(query))
    .map((suggestion) => ({
      value: suggestion.family,
      label: (
        <span className={styles.suggestion}>
          <span>{suggestion.family}</span>
          <span className={styles.meta}>{t(`omc.font_category_${suggestion.category}`)}{suggestion.isCjk ? ` · ${t('omc.font_cjk')}` : ''}</span>
        </span>
      ),
    }));
  const close = () => {
    abort.current?.abort();
    onClose();
  };

  return (
    <Modal
      open={open}
      title={t('omc.font_library')}
      onCancel={close}
      footer={null}
      width={720}
      destroyOnHidden
    >
      <div className={styles.dialog}>
        <section className={styles.section} aria-label={t('omc.font_google_title')}>
          <div className={styles['section-head']}>
            <span className={styles['field-label']}>{t('omc.font_google_title')}</span>
            <a className={styles.browse} href={GOOGLE_FONTS_SITE} target="_blank" rel="noreferrer noopener">
              {t('omc.font_google_browse')} <ExternalLinkOutlined />
            </a>
          </div>
          <form
            className={styles['install-row']}
            onSubmit={(event) => {
              event.preventDefault();
              if (trimmed && !install.isPending) install.mutate(trimmed);
            }}
          >
            <AutoComplete
              className={styles['install-field']}
              value={family}
              options={suggestions}
              onChange={setFamily}
              disabled={install.isPending}
              placeholder="Noto Sans SC"
              aria-label={t('omc.font_google_family')}
            />
            <Button type="primary" htmlType="submit" icon={<CloudDownloadOutlined />} disabled={!trimmed} loading={install.isPending}>
              {t('omc.font_install')}
            </Button>
          </form>
          <p className={styles.note}>{t(install.isPending ? 'omc.font_google_installing' : 'omc.font_google_note')}</p>
        </section>

        <section className={styles.section} aria-label={t('omc.font_installed')}>
          <div className={styles['section-head']}>
            <span className={styles['field-label']}>{t('omc.font_installed')}</span>
            <Button size="small" icon={<UploadOutlined />} loading={upload.isPending} onClick={() => fileInput.current?.click()}>{t('omc.font_upload')}</Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              accept={FONT_UPLOAD_ACCEPT}
              aria-label={t('omc.font_upload')}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = '';
                if (files.length) upload.mutate(files);
              }}
            />
          </div>
          {fonts.length > 0
            ? <FontLibraryList fonts={fonts} />
            : !isLoading && <EmptyState size="compact" title={t('omc.font_library_empty')} description={t('omc.font_library_desc')} />}
        </section>
      </div>
    </Modal>
  );
};

const FontLibraryList: React.FC<{ fonts: readonly InstalledFont[] }> = ({ fonts }) => {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { value: roles } = useFontRoles();
  const errorText = useFontErrorText();
  const remove = useMutation({
    mutationFn: (font: InstalledFont) => api.deleteFont(font.id),
    onSuccess: (_, font) => {
      forgetLibraryFont(font.id);
      queryClient.setQueryData<InstalledFont[]>(FONTS_QUERY_KEY, (cached) => (cached ?? []).filter((candidate) => candidate.id !== font.id));
      // The server cleared every role that used the family in the same transaction; the
      // cached preference is brought into line rather than refetched, so no other key's
      // in-flight write is overwritten by an older server copy.
      queryClient.setQueryData<Record<string, unknown>>(['preferences'], (cached) => {
        const stored = cached?.[FONT_PREFERENCE_KEY];
        if (!stored || typeof stored !== 'object') return cached;
        const next = Object.fromEntries(Object.entries(stored).filter(([, ref]) => ref !== libraryRef(font.id)));
        return { ...cached, [FONT_PREFERENCE_KEY]: next };
      });
      toast.success(t('omc.font_deleted', { family: font.family }));
    },
    onError: (error) => toast.error(errorText(error) ?? t('omc.font_delete_failed'), { error }),
  });

  return (
    <ul className={styles.library} aria-label={t('omc.font_installed')}>
      {fonts.map((font) => {
        const stack = fontStackFor(libraryRef(font.id), fonts);
        const usedBy = FONT_ROLES.filter((role) => roles[role] === libraryRef(font.id)).map((role) => t(ROLE_LABEL_KEYS[role].label));
        return (
          <li key={font.id} className={styles.row}>
            <div className={styles.identity}>
              <span className={styles.family} style={{ fontFamily: stack }}>{font.family}</span>
              <span className={styles.meta}>
                {[
                  t(font.source === 'google' ? 'omc.font_source_google' : 'omc.font_source_upload'),
                  font.faces.length === 1 ? t('omc.font_file_single') : t('omc.font_files', { n: font.faces.length }),
                  formatBytes(font.byte_size),
                  ...(usedBy.length ? [t('omc.font_in_use', { roles: usedBy.join(' / ') })] : []),
                ].join(' · ')}
              </span>
            </div>
            <ConfirmAction
              title={t('omc.font_delete_confirm', { family: font.family })}
              description={usedBy.length ? t('omc.font_delete_in_use') : undefined}
              confirmLabel={t('common.delete')}
              isDanger
              isConfirming={remove.isPending && remove.variables?.id === font.id}
              onConfirm={() => remove.mutateAsync(font).catch(() => undefined)}
            >
              <Button type="text" icon={<DeleteOutlined />} aria-label={t('omc.font_delete', { family: font.family })} />
            </ConfirmAction>
          </li>
        );
      })}
    </ul>
  );
};
