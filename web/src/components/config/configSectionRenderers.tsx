import { Button, Input, InputNumber, Select, Switch, Typography } from 'antd';
import {
  CodeOutlined,
  ExperimentOutlined,
  FieldTimeOutlined,
  GlobalOutlined,
  KeyOutlined,
  NodeIndexOutlined,
  ProfileOutlined,
} from '@ant-design/icons';
import { parseDocument, type Document } from 'yaml';

import { PayloadRulesEditor } from './PayloadRulesEditor';

import type { useT } from '../../i18n';
import { isConfigSemanticallyEqual } from './configDirty';
import {
  ALL_CONFIG_FIELDS,
  type ConfigFieldDefinition,
  type ConfigGroupDefinition,
  type ConfigSectionId,
} from '../../types/configSchema';
import type { useConfigDraft } from './useConfigDraft';

const { Text } = Typography;

/**
 * Everything a configuration field or group panel reads and rewrites: the draft
 * plus the view state the panel itself is drawn from.
 */
export type ConfigSectionContext = ReturnType<typeof useConfigDraft> & {
  doc: Document | null;
  configuredKeyCount: number;
  navigate: (path: string) => void;
  searchQuery: string;
  searchMatchedGroups: { group: ConfigGroupDefinition; matchedFieldIds: string[] }[];
  t: ReturnType<typeof useT>;
};

/**
 * How one configuration field and one group of them is drawn.
 *
 * They take the draft and the view state as a context rather than closing over
 * them, because the panels compose each other: a group draws its fields through
 * the same control chooser the search results use.
 */

export function sectionIcon(view: ConfigSectionContext, id: ConfigSectionId) {
  const {

  } = view;

    switch (id) {
      case 'connectivity':
        return <KeyOutlined />;
      case 'network':
        return <GlobalOutlined />;
      case 'logging':
        return <ProfileOutlined />;
      case 'quota':
        return <FieldTimeOutlined />;
      case 'streaming':
        return <NodeIndexOutlined />;
      case 'advanced':
        return <ExperimentOutlined />;
      case 'payload':
        return <CodeOutlined />;
    }

}

export function renderFieldControl(view: ConfigSectionContext, field: ConfigFieldDefinition, disabled = false) {
  const {
    updateFieldInDoc,
    getFieldValue,
    t,
  } = view;

    const val = getFieldValue(field);

    if (field.type === 'switch') {
      return (
        <Switch
          id={`cfg-${field.id}`}
          aria-describedby={`desc-${field.id}`}
          checked={Boolean(val)}
          disabled={disabled}
          onChange={(checked) => updateFieldInDoc(field, checked)}
        />
      );
    }

    if (field.type === 'string') {
      return (
        <Input
          id={`cfg-${field.id}`}
          aria-describedby={`desc-${field.id}`}
          className="config-mono-input"
          allowClear
          disabled={disabled}
          placeholder={field.placeholderKey ? (field.placeholderKey.startsWith('cfg.') ? t(field.placeholderKey) : field.placeholderKey) : ''}
          value={String(val ?? '')}
          onChange={(e) => updateFieldInDoc(field, e.target.value)}
        />
      );
    }

    if (field.type === 'number') {
      return (
        <div className="settings-number-control">
          <InputNumber
            id={`cfg-${field.id}`}
            aria-describedby={`desc-${field.id}`}
            className="config-mono-input"
            min={field.min ?? 0}
            max={field.max}
            disabled={disabled}
            value={typeof val === 'number' ? val : Number(val) || 0}
            onChange={(num) => updateFieldInDoc(field, num ?? 0)}
          />
          {field.unitKey && (
            <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {t(field.unitKey)}
            </Text>
          )}
        </div>
      );
    }

    if (field.type === 'select') {
      return (
        <Select
          id={`cfg-${field.id}`}
          aria-describedby={`desc-${field.id}`}
          disabled={disabled}
          value={String(val ?? field.defaultValue ?? '')}
          options={(field.options ?? []).map((opt) => ({
            value: opt.value,
            label: t(opt.labelKey),
          }))}
          onChange={(selected) => updateFieldInDoc(field, selected)}
        />
      );
    }

    if (field.type === 'json_editor') {
      return (
        <Input.TextArea
          id={`cfg-${field.id}`}
          aria-describedby={`desc-${field.id}`}
          rows={2}
          className="config-mono-textarea"
          placeholder="{}"
          disabled={disabled}
          value={typeof val === 'object' && val !== null ? JSON.stringify(val, null, 2) : String(val ?? '')}
          onChange={(e) => {
            const str = e.target.value;
            try {
              const parsed = JSON.parse(str);
              updateFieldInDoc(field, parsed);
            } catch {
              updateFieldInDoc(field, str);
            }
          }}
        />
      );
    }

    if (field.type === 'textarea') {
      return (
        <Input.TextArea
          id={`cfg-${field.id}`}
          aria-describedby={`desc-${field.id}`}
          rows={3}
          className="config-mono-textarea"
          disabled={disabled}
          placeholder={field.placeholderKey ? (field.placeholderKey.startsWith('cfg.') ? t(field.placeholderKey) : field.placeholderKey) : ''}
          value={String(val ?? '')}
          onChange={(e) => updateFieldInDoc(field, e.target.value)}
        />
      );
    }

    return null;
}

  // Variant 1: Grid Field (Label on top, input below)

export function renderGridField(view: ConfigSectionContext, field: ConfigFieldDefinition, disabled = false) {
  const {
    t,
  } = view;

    const isFull =
      field.type === 'textarea' ||
      field.type === 'json_editor' ||
      field.id === 'proxyUrl' ||
      field.id === 'authDir' ||
      field.id === 'logDir' ||
      field.id === 'rmSecretKey' ||
      field.id === 'corsOrigins';

    return (
      <div key={field.id} className={`settings-field${isFull ? ' is-full' : ''}`}>
        <label htmlFor={`cfg-${field.id}`} className="settings-field-label">
          <span>{t(field.labelKey)}</span>
        </label>
        <div id={`desc-${field.id}`} className="settings-field-desc">
          {t(field.descKey)}
        </div>
        <div className={`settings-field-control is-${field.type}`}>
          {renderFieldControl(view, field, disabled)}
        </div>
      </div>
    );
}

  // Variant 2: Toggle Row (Title/desc on left, control on right)

export function renderToggleRow(view: ConfigSectionContext, field: ConfigFieldDefinition, disabled = false) {
  const {
    t,
  } = view;

    return (
      <div key={field.id} className="settings-toggle-row">
        <div className="settings-toggle-info">
          <label htmlFor={`cfg-${field.id}`} className="settings-toggle-title">
            {t(field.labelKey)}
          </label>
          <div id={`desc-${field.id}`} className="settings-toggle-desc">
            {t(field.descKey)}
          </div>
        </div>
        <div className={`settings-toggle-control is-${field.type}`}>
          {renderFieldControl(view, field, disabled)}
        </div>
      </div>
    );
}

  // Render a cohesive Setting Group Panel
  //
  // `context` says which heading the caller is already showing above this group,
  // because the Payload panel is the one variant whose group head restates its
  // section header. Under the section header the group head is therefore dropped:
  // the reader was shown the section's own title and description and then the
  // same panel named a second time underneath it. Under search results the header
  // names the search rather than the section, so the group head is the only
  // heading the panel has and must stay.

export function renderGroupPanel(view: ConfigSectionContext, grp: ConfigGroupDefinition, visibleFieldIds?: string[], context: 'section' | 'search' = 'section') {
  const {
    setRawYaml,
    serverYaml,
    docRef,
    serverDocRef,
    getFieldValue,
    validateTrigger,
    setPayloadIssues,
    configuredKeyCount,
    navigate,
    t,
  } = view;

    const rawFields = grp.fieldIds
      .map((fid) => ALL_CONFIG_FIELDS.find((f) => f.id === fid))
      .filter((f): f is ConfigFieldDefinition => Boolean(f));

    const groupFields = visibleFieldIds
      ? rawFields.filter((f) => visibleFieldIds.includes(f.id))
      : rawFields;

    if (groupFields.length === 0) return null;

    // Managed-elsewhere variant (the client API keys)
    //
    // This group points at the surface that owns the field rather than editing
    // it: one editor per field, and the operator who looks here is told where
    // that editor is. It renders in the search context too, so searching for the
    // field finds the panel that names it instead of nothing at all.
    if (grp.variant === 'managed-elsewhere') {
      return (
        <div key={grp.id} className="settings-group">
          <div className="settings-group-head">
            <div>
              <h3 className="settings-group-title">{t(grp.labelKey)}</h3>
              {grp.descKey && <p className="settings-group-desc">{t(grp.descKey)}</p>}
            </div>
          </div>
          <div className="settings-group-body">
            <div className="settings-managed-elsewhere">
              <span className="settings-managed-count">
                {t('cfg.api_keys_count', { n: configuredKeyCount })}
              </span>
              <Button size="small" type="primary" onClick={() => navigate('/api-keys')}>
                {t('cfg.api_keys_manage')}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    // Payload Builder variant (structured JSON rules for models and parameters)
    if (grp.variant === 'payload-builder') {
      return (
        <div key={grp.id} className="settings-group payload-builder-group">
          {context === 'search' && (
            <div className="settings-group-head">
              <div>
                <h3 className="settings-group-title">{t(grp.labelKey)}</h3>
                {grp.descKey && <p className="settings-group-desc">{t(grp.descKey)}</p>}
              </div>
            </div>
          )}
          <div className="settings-group-body">
            <PayloadRulesEditor
              doc={docRef.current}
              onDocChange={() => {
                if (docRef.current) {
                  // Check semantic equality with serverDocRef before setting rawYaml
                  if (serverDocRef.current && isConfigSemanticallyEqual(docRef.current, serverDocRef.current, ALL_CONFIG_FIELDS)) {
                    setRawYaml(serverYaml);
                    docRef.current = parseDocument(serverYaml);
                  } else {
                    setRawYaml(docRef.current.toString());
                  }
                }
              }}
              onValidationChange={setPayloadIssues}
              validateTrigger={validateTrigger}
            />
          </div>
        </div>
      );
    }

    // TLS Accordion variant
    if (grp.variant === 'tls-accordion') {
      const tlsEnableField = ALL_CONFIG_FIELDS.find((f) => f.id === 'tlsEnable');
      const tlsCertField = ALL_CONFIG_FIELDS.find((f) => f.id === 'tlsCert');
      const tlsKeyField = ALL_CONFIG_FIELDS.find((f) => f.id === 'tlsKey');
      const tlsEnabled = tlsEnableField ? Boolean(getFieldValue(tlsEnableField)) : false;

      // If user searched for cert or key directly, open the panel
      const isSearchActive = Boolean(visibleFieldIds);
      const isOpen = isSearchActive ? true : tlsEnabled;

      return (
        <div key={grp.id} className="settings-group">
          <div className="settings-group-head">
            <div>
              <h3 className="settings-group-title">{t(grp.labelKey)}</h3>
              {grp.descKey && (
                <p id="desc-tlsEnable" className="settings-group-desc">
                  {t(grp.descKey)}
                </p>
              )}
            </div>
            {tlsEnableField && (!visibleFieldIds || visibleFieldIds.includes('tlsEnable')) && (
              <div className="settings-toggle-control is-switch">
                {renderFieldControl(view, tlsEnableField)}
              </div>
            )}
          </div>
          <div className={`settings-tls-body${isOpen ? ' is-open' : ''}`} aria-hidden={!isOpen}>
            <div className="settings-tls-inner">
              <div className="settings-form-grid">
                {tlsCertField && (!visibleFieldIds || visibleFieldIds.includes('tlsCert')) && renderGridField(view, tlsCertField, !isOpen)}
                {tlsKeyField && (!visibleFieldIds || visibleFieldIds.includes('tlsKey')) && renderGridField(view, tlsKeyField, !isOpen)}
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Settings List variant (toggle switches and flags)
    if (grp.variant === 'settings-list') {
      return (
        <div key={grp.id} className="settings-group">
          <div className="settings-group-head">
            <div>
              <h3 className="settings-group-title">{t(grp.labelKey)}</h3>
              {grp.descKey && <p className="settings-group-desc">{t(grp.descKey)}</p>}
            </div>
          </div>
          <div className="settings-list-rows">
            {groupFields.map((f) => renderToggleRow(view, f))}
          </div>
        </div>
      );
    }

    // Default: Form Grid variant
    const hasHost = groupFields.some((f) => f.id === 'host');
    const hasPort = groupFields.some((f) => f.id === 'port');
    const hostField = ALL_CONFIG_FIELDS.find((f) => f.id === 'host');
    const portField = ALL_CONFIG_FIELDS.find((f) => f.id === 'port');
    const combineHostPort = hasHost && hasPort && !visibleFieldIds;

    return (
      <div key={grp.id} className="settings-group">
        <div className="settings-group-head">
          <div>
            <h3 className="settings-group-title">{t(grp.labelKey)}</h3>
            {grp.descKey && <p className="settings-group-desc">{t(grp.descKey)}</p>}
          </div>
        </div>
        <div className="settings-group-body">
          <div className="settings-form-grid">
            {combineHostPort && hostField && portField && (
              <div key="host-port-combo" className="settings-field-host-port">
                <div className="settings-field">
                  <label htmlFor="cfg-host" className="settings-field-label">
                    <span>{t(hostField.labelKey)}</span>
                  </label>
                  <div id="desc-host" className="settings-field-desc">
                    {t(hostField.descKey)}
                  </div>
                  <div className="settings-field-control">{renderFieldControl(view, hostField)}</div>
                </div>
                <div className="settings-field">
                  <label htmlFor="cfg-port" className="settings-field-label">
                    <span>{t(portField.labelKey)}</span>
                  </label>
                  <div id="desc-port" className="settings-field-desc">
                    {t(portField.descKey)}
                  </div>
                  <div className="settings-field-control">{renderFieldControl(view, portField)}</div>
                </div>
              </div>
            )}
            {groupFields
              .filter((f) => (combineHostPort ? f.id !== 'host' && f.id !== 'port' : true))
              .map((f) => renderGridField(view, f))}
          </div>
        </div>
      </div>
    );
}
