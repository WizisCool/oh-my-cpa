import React from 'react';
import { Alert, App as AntdApp, Button, Drawer, Input, Segmented, Select, Skeleton, Switch, Tooltip } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClearOutlined, PlusOutlined, UndoOutlined } from '../icons';
import { api, describeError } from '../../api/client';
import { useT } from '../../i18n';
import { pluginDisplayName, type PluginConfigField, type PluginItem } from '../../types/plugin';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { PluginConfigEditor } from './PluginConfigEditor';
import { parsePluginConfig, pluginConfigsEqual, pluginConfigSummary } from './pluginConfig';
import {
  buildPluginConfigDraft,
  composePluginConfig,
  isPluginFieldChanged,
  pluginFieldDraftFromValue,
  pluginFieldKind,
  undeclaredPluginKeys,
  type PluginConfigDraft,
  type PluginFieldDraft,
  type PluginFieldError,
} from './pluginConfigForm';
import { formatPluginVersion, PluginLogo, PluginMeta } from './PluginParts';
import styles from './Plugins.module.css';

type EditorMode = 'form' | 'json';

interface PluginConfigDrawerProps {
  plugin: PluginItem | null;
  isDemo: boolean;
  onClose: () => void;
}

/**
 * One plugin's settings, edited as the typed fields the plugin declares, or as the JSON
 * document CPA stores.
 *
 * The form is the default whenever the plugin declares fields: each one is a control of
 * its own type, states whether it is set or left to the plugin's default, and marks what
 * the draft changed. The JSON view is the same document, for keys the plugin does not
 * declare and for plugins that declare nothing. Switching views carries the draft across,
 * and a view that does not parse cannot be left, so an edit is never silently dropped.
 */
export function PluginConfigDrawer({ plugin, isDemo, onClose }: PluginConfigDrawerProps) {
  const t = useT();
  const { message, modal } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const pluginId = plugin?.id ?? '';
  const fields = React.useMemo(() => plugin?.config_fields ?? [], [plugin]);

  const configQuery = useQuery({
    queryKey: ['management-plugin-config', pluginId],
    queryFn: () => api.getPluginConfig(pluginId),
    enabled: plugin !== null,
    staleTime: 0,
  });
  const saved = configQuery.data?.config;

  const [mode, setMode] = React.useState<EditorMode>('form');
  const [draft, setDraft] = React.useState<PluginConfigDraft | null>(null);
  const [base, setBase] = React.useState<Record<string, unknown>>({});
  const [jsonText, setJsonText] = React.useState('');

  // The editor is seeded once per opened plugin, from a document read for this opening:
  // a cached copy from an earlier opening may predate a save, so seeding waits for the
  // refetch, and a later background refetch must not overwrite an edit in progress.
  const seededFor = React.useRef<string | null>(null);
  const isReading = configQuery.isFetching;
  React.useEffect(() => {
    if (!plugin) {
      // Closed: the next opening, of this plugin or another, starts from its own read.
      seededFor.current = null;
      setDraft(null);
      return;
    }
    if (!saved || isReading || seededFor.current === plugin.id) return;
    seededFor.current = plugin.id;
    setDraft(buildPluginConfigDraft(fields, saved, plugin.enabled));
    setBase(saved);
    setJsonText(JSON.stringify(saved, null, 2));
    setMode(fields.length > 0 ? 'form' : 'json');
  }, [plugin, saved, fields, isReading]);

  const composed = React.useMemo(() => {
    if (mode === 'json') {
      const parsed = parsePluginConfig(jsonText);
      return { value: parsed.value, errors: {} as Record<string, PluginFieldError>, jsonError: parsed.error };
    }
    if (!draft) return { value: undefined, errors: {} as Record<string, PluginFieldError>, jsonError: undefined };
    return { ...composePluginConfig(draft, fields, base), jsonError: undefined };
  }, [mode, jsonText, draft, fields, base]);

  const isDirty = saved !== undefined && (composed.value === undefined || !pluginConfigsEqual(composed.value, saved));
  const errorCount = Object.keys(composed.errors).length + (composed.jsonError ? 1 : 0);

  const saveMutation = useMutation({
    mutationFn: (config: Record<string, unknown>) => api.setPluginConfig(pluginId, config),
    onSuccess: () => {
      message.success(t('plugin.config_saved'));
      void queryClient.invalidateQueries({ queryKey: ['management-plugins'] });
      void queryClient.invalidateQueries({ queryKey: ['management-plugin-config', pluginId] });
      seededFor.current = null;
      onClose();
    },
    onError: (err: unknown) => message.error(t('common.save_failed', { msg: describeError(err) })),
  });

  const requestClose = () => {
    if (saveMutation.isPending) return;
    if (!isDirty) {
      onClose();
      return;
    }
    modal.confirm({
      title: t('plugin.config_unsaved_title'),
      content: t('plugin.config_unsaved_desc'),
      okText: t('plugin.discard'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: onClose,
    });
  };
  useOverlayHistory({ isOpen: plugin !== null, onClose: requestClose });

  const switchMode = (next: EditorMode) => {
    if (next === mode) return;
    if (next === 'json') {
      if (!composed.value) {
        message.warning(t('plugin.config_fix_errors'));
        return;
      }
      setJsonText(JSON.stringify(composed.value, null, 2));
      setMode('json');
      return;
    }
    const parsed = parsePluginConfig(jsonText);
    if (!parsed.value) {
      message.warning(t('plugin.config_fix_json'));
      return;
    }
    setBase(parsed.value);
    setDraft(buildPluginConfigDraft(fields, parsed.value, plugin?.enabled ?? false));
    setMode('form');
  };

  const handleSave = () => {
    if (!composed.value) {
      message.warning(mode === 'json' ? t('plugin.config_fix_json') : t('plugin.config_fix_errors'));
      return;
    }
    saveMutation.mutate(composed.value);
  };

  const updateField = (name: string, patch: Partial<PluginFieldDraft>) => {
    setDraft((current) => (current ? { ...current, fields: { ...current.fields, [name]: { ...current.fields[name], ...patch } } } : current));
  };

  const resetField = (field: PluginConfigField) => {
    const source = saved ?? {};
    const isSet = Object.prototype.hasOwnProperty.call(source, field.name) && source[field.name] !== null;
    updateField(field.name, pluginFieldDraftFromValue(field, source[field.name], isSet));
  };

  const name = plugin ? pluginDisplayName(plugin) : '';
  const extraKeys = mode === 'form' ? undeclaredPluginKeys(base, fields) : [];
  const extraSummary = new Map(pluginConfigSummary(base).map((entry) => [entry.key, entry.type]));

  return (
    <Drawer
      open={plugin !== null}
      onClose={requestClose}
      size="min(720px, 100vw)"
      title={t('plugin.config_title', { name })}
      destroyOnHidden
      footer={(
        <div className={styles['drawer-footer']}>
          <span className={styles['drawer-footer-note']}>
            {errorCount > 0
              ? t('plugin.config_error_count', { n: errorCount })
              : isDirty ? t('plugin.unsaved_changes') : t('plugin.config_no_changes')}
          </span>
          <span className={styles['card-actions']}>
            <Button onClick={requestClose} disabled={saveMutation.isPending}>{t('common.cancel')}</Button>
            <Tooltip title={isDemo ? t('demo.blocked') : undefined}>
              <Button
                type="primary"
                disabled={isDemo || !isDirty}
                loading={saveMutation.isPending}
                onClick={handleSave}
                data-plugin-config-save
              >
                {t('common.save')}
              </Button>
            </Tooltip>
          </span>
        </div>
      )}
    >
      {plugin && (
        <div data-plugin-config={plugin.id}>
          <div className={styles['config-head']}>
            <div className={styles['config-identity']}>
              <PluginLogo logo={plugin.logo || plugin.metadata?.logo} />
              <div>
                <div className={styles['installed-name']}>{name}</div>
                <PluginMeta items={[plugin.id, formatPluginVersion(plugin.metadata?.version), plugin.metadata?.author]} />
              </div>
            </div>
            <Segmented
              value={mode}
              onChange={(value) => switchMode(value as EditorMode)}
              options={[
                { value: 'form', label: t('plugin.config_mode_form') },
                { value: 'json', label: t('plugin.config_mode_json') },
              ]}
            />
          </div>

          {!configQuery.isError && (configQuery.isLoading || !draft || seededFor.current !== plugin.id) ? (
            <Skeleton active paragraph={{ rows: 6 }} />
          ) : configQuery.isError ? (
            <Alert type="error" showIcon title={t('plugin.config_load_failed')} description={describeError(configQuery.error)} />
          ) : mode === 'json' ? (
            <PluginConfigEditor value={jsonText} onChange={setJsonText} pluginName={name} isReadOnly={isDemo} />
          ) : draft && (
            <>
              <section className={styles['config-section']}>
                <h3 className={styles['config-section-title']}>{t('plugin.config_base')}</h3>
                <div className={styles['config-field']}>
                  <div>
                    <div className={styles['config-field-label']}>enabled</div>
                    <div className={styles['config-field-desc']}>{t('plugin.config_enabled_hint')}</div>
                  </div>
                  <div className={styles['config-control']}>
                    <Switch
                      checked={draft.enabled}
                      disabled={isDemo}
                      onChange={(checked) => setDraft({ ...draft, enabled: checked })}
                      aria-label="enabled"
                    />
                  </div>
                </div>
                <div className={styles['config-field']}>
                  <div>
                    <div className={styles['config-field-label']}>priority <span className={styles['config-field-type']}>integer</span></div>
                    <div className={styles['config-field-desc']}>{t('plugin.config_priority_hint')}</div>
                  </div>
                  <div className={styles['config-control']}>
                    <Input
                      value={draft.priority}
                      disabled={isDemo}
                      inputMode="numeric"
                      placeholder="0"
                      status={composed.errors.priority ? 'error' : undefined}
                      onChange={(event) => setDraft({ ...draft, priority: event.target.value })}
                      aria-label="priority"
                    />
                    {composed.errors.priority && <span className={styles['field-error']}>{t('plugin.field_error_integer')}</span>}
                  </div>
                </div>
              </section>

              <section className={styles['config-section']}>
                <h3 className={styles['config-section-title']}>
                  {t('plugin.config_fields_title')}
                  <span>{fields.length}</span>
                </h3>
                {fields.length === 0 ? (
                  <Alert type="info" showIcon title={t('plugin.config_no_fields')} />
                ) : fields.map((field) => (
                  <ConfigFieldRow
                    key={field.name}
                    field={field}
                    draft={draft.fields[field.name]}
                    error={composed.errors[field.name]}
                    isChanged={isPluginFieldChanged(field, draft.fields[field.name], saved ?? {})}
                    isReadOnly={isDemo}
                    onChange={(patch) => updateField(field.name, patch)}
                    onReset={() => resetField(field)}
                  />
                ))}
              </section>

              {extraKeys.length > 0 && (
                <section className={styles['config-section']}>
                  <h3 className={styles['config-section-title']}>{t('plugin.config_extra_title')}</h3>
                  <p className={styles['config-field-desc']}>{t('plugin.config_extra_desc')}</p>
                  <div className={styles['extra-keys']}>
                    {extraKeys.map((key) => (
                      <span key={key} className={styles['extra-key']}>
                        {key}
                        <span className={styles['config-field-type']}>{extraSummary.get(key)}</span>
                      </span>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </Drawer>
  );
}

const FIELD_ERROR_KEYS: Record<PluginFieldError, string> = {
  'invalid-integer': 'plugin.field_error_integer',
  'invalid-number': 'plugin.field_error_number',
  'invalid-enum': 'plugin.field_error_enum',
  'invalid-json': 'plugin.field_error_json',
  'expected-array': 'plugin.field_error_array',
  'expected-object': 'plugin.field_error_object',
  'required-value': 'plugin.field_error_required',
};

interface ConfigFieldRowProps {
  field: PluginConfigField;
  draft: PluginFieldDraft;
  error?: PluginFieldError;
  isChanged: boolean;
  isReadOnly: boolean;
  onChange: (patch: Partial<PluginFieldDraft>) => void;
  onReset: () => void;
}

function ConfigFieldRow({ field, draft, error, isChanged, isReadOnly, onChange, onReset }: ConfigFieldRowProps) {
  const t = useT();
  const kind = pluginFieldKind(field);

  const control = (() => {
    if (!draft.isSet) {
      return (
        <div className={styles['config-unset']}>
          <span>{t('plugin.field_unset')}</span>
          <Button size="small" type="link" icon={<PlusOutlined />} disabled={isReadOnly} onClick={() => onChange({ isSet: true })}>
            {t('plugin.field_set')}
          </Button>
        </div>
      );
    }
    if (kind === 'boolean') {
      return <Switch checked={draft.checked} disabled={isReadOnly} onChange={(checked) => onChange({ checked })} aria-label={field.name} />;
    }
    if (kind === 'enum') {
      return (
        <Select
          value={draft.text || undefined}
          disabled={isReadOnly}
          status={error ? 'error' : undefined}
          placeholder={t('plugin.field_select')}
          options={(field.enum_values ?? []).map((value) => ({ value, label: value }))}
          onChange={(value: string) => onChange({ text: value })}
          aria-label={field.name}
        />
      );
    }
    if (kind === 'array' && draft.isList) {
      return (
        <Select
          mode="tags"
          value={draft.list}
          disabled={isReadOnly}
          open={false}
          suffixIcon={null}
          tokenSeparators={[',', '\n']}
          placeholder={t('plugin.field_list_placeholder')}
          onChange={(values: string[]) => onChange({ list: values })}
          aria-label={field.name}
        />
      );
    }
    if (kind === 'array' || kind === 'object') {
      return (
        <Input.TextArea
          value={draft.text}
          disabled={isReadOnly}
          autoSize={{ minRows: 3, maxRows: 12 }}
          spellCheck={false}
          className={styles['config-json']}
          status={error ? 'error' : undefined}
          onChange={(event) => onChange({ text: event.target.value })}
          aria-label={field.name}
        />
      );
    }
    return (
      <Input
        value={draft.text}
        disabled={isReadOnly}
        inputMode={kind === 'integer' || kind === 'number' ? 'decimal' : undefined}
        status={error ? 'error' : undefined}
        onChange={(event) => onChange({ text: event.target.value })}
        aria-label={field.name}
      />
    );
  })();

  return (
    <div className={`${styles['config-field']} ${isChanged ? styles['config-field-changed'] : ''}`} data-plugin-config-field={field.name}>
      <div>
        <div className={styles['config-field-label']}>
          {field.name}
          <span className={styles['config-field-type']}>{kind}</span>
        </div>
        {field.description && <div className={styles['config-field-desc']}>{field.description}</div>}
      </div>
      <div className={styles['config-control']}>
        <div className={styles['config-control-row']}>
          {control}
          {draft.isSet && (
            <Tooltip title={t('plugin.field_unset_action')}>
              <Button size="small" type="text" icon={<ClearOutlined />} disabled={isReadOnly} onClick={() => onChange({ isSet: false })} aria-label={t('plugin.field_unset_action')} />
            </Tooltip>
          )}
          {isChanged && (
            <Tooltip title={t('plugin.field_reset')}>
              <Button size="small" type="text" icon={<UndoOutlined />} disabled={isReadOnly} onClick={onReset} aria-label={t('plugin.field_reset')} />
            </Tooltip>
          )}
        </div>
        {error && <span className={styles['field-error']}>{t(FIELD_ERROR_KEYS[error])}</span>}
      </div>
    </div>
  );
}
