import {
  AutoComplete,
  Button,
  Checkbox,
  Col,
  Drawer,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
  Select,
} from 'antd';
import { CloseOutlined, DownOutlined, PlusOutlined, SyncOutlined, UpOutlined } from '@ant-design/icons';

import { useT } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import { LobeIcon, getProviderDefaultIcon } from '../LobeIcon';
import { maskKeyText } from '../../utils/maskKey';
import { modelOptionsFor } from '../../utils/modelOptions';
import { PROVIDER_FAMILIES } from '../../types/providerFamilies';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import type { useProviderManagement } from './useProviderManagement';

type ProviderManagement = ReturnType<typeof useProviderManagement>;

interface ProviderEditorDrawerProps extends Pick<
  ProviderManagement,
  | 'createProviderMutation'
  | 'updateProviderMutation'
  | 'providerDrawerOpen'
  | 'editingProvider'
  | 'formFamily'
  | 'setFormFamily'
  | 'formName'
  | 'setFormName'
  | 'formBaseURL'
  | 'setFormBaseURL'
  | 'formWebsite'
  | 'setFormWebsite'
  | 'formPrefix'
  | 'setFormPrefix'
  | 'formPriority'
  | 'setFormPriority'
  | 'formDisabled'
  | 'setFormDisabled'
  | 'formDisableCooling'
  | 'setFormDisableCooling'
  | 'formKeys'
  | 'setFormKeys'
  | 'formHeaders'
  | 'setFormHeaders'
  | 'formModels'
  | 'setFormModels'
  | 'formTestModel'
  | 'setFormTestModel'
  | 'formIcon'
  | 'setFormIcon'
  | 'iconManuallySelected'
  | 'setIconManuallySelected'
  | 'setIconPickerOpen'
  | 'setTargetProviderForIcon'
  | 'setIsPullingModels'
  | 'keysSectionOpen'
  | 'setKeysSectionOpen'
  | 'headersSectionOpen'
  | 'setHeadersSectionOpen'
  | 'modelsSectionOpen'
  | 'setModelsSectionOpen'
  | 'expandedKeyIds'
  | 'setExpandedKeyIds'
  | 'expandedModelIds'
  | 'setExpandedModelIds'
  | 'endpointModels'
  | 'setEndpointModels'
  | 'isPullingModels'
  | 'modelFetchSeqRef'
  | 'websiteInputState'
  | 'handlePullModels'
  | 'toggleModelExpanded'
  | 'handleAddModel'
  | 'updateModelImage'
  | 'toggleThinkingLevel'
  | 'toggleKeyExpanded'
  | 'handleKeyAdd'
  | 'handleTestKey'
  | 'handleTestAllKeys'
  | 'handleCloseProviderDrawer'
  | 'handleSaveProvider'
> {}

const THINKING_LEVEL_OPTIONS = [
  { value: 'none', labelKey: 'pro.level_none' },
  { value: 'minimal', labelKey: 'pro.level_minimal' },
  { value: 'low', labelKey: 'pro.level_low' },
  { value: 'medium', labelKey: 'pro.level_medium' },
  { value: 'high', labelKey: 'pro.level_high' },
  { value: 'xhigh', labelKey: 'pro.level_xhigh' },
  { value: 'max', labelKey: 'pro.level_max' },
  { value: 'auto', labelKey: 'pro.level_auto' },
];

/**
 * The provider editor: one drawer that edits whatever CPA stores for a line.
 *
 * Every section it shows is one list CPA keeps whole - credentials, request
 * headers, model entries - so a save is one write of the complete record and the
 * drawer is the only place that shape exists. The three readable sections are
 * collapsed by default except the credentials, which are the field an operator
 * most often opens the drawer to change.
 */
export function ProviderEditorDrawer({
  familyDisplayNames,
  ...editor
}: ProviderEditorDrawerProps & { familyDisplayNames: Record<string, string> }) {
  const t = useT();
  // Pulling models calls the provider's own endpoint with the credential. The
  // demonstration refuses it, so the control says so rather than failing on click.
  const isDemo = isDemoMode();
  const {
    createProviderMutation,
    updateProviderMutation,
    providerDrawerOpen,
    editingProvider,
    formFamily,
    setFormFamily,
    formName,
    setFormName,
    formBaseURL,
    setFormBaseURL,
    formWebsite,
    setFormWebsite,
    formPrefix,
    setFormPrefix,
    formPriority,
    setFormPriority,
    formDisabled,
    setFormDisabled,
    formDisableCooling,
    setFormDisableCooling,
    formKeys,
    setFormKeys,
    formHeaders,
    setFormHeaders,
    formModels,
    setFormModels,
    formTestModel,
    setFormTestModel,
    formIcon,
    setFormIcon,
    iconManuallySelected,
    setIconManuallySelected,
    setIconPickerOpen,
    setTargetProviderForIcon,
    setIsPullingModels,
    keysSectionOpen,
    setKeysSectionOpen,
    headersSectionOpen,
    setHeadersSectionOpen,
    modelsSectionOpen,
    setModelsSectionOpen,
    expandedKeyIds,
    setExpandedKeyIds,
    expandedModelIds,
    setExpandedModelIds,
    endpointModels,
    setEndpointModels,
    isPullingModels,
    modelFetchSeqRef,
    websiteInputState,
    handlePullModels,
    toggleModelExpanded,
    handleAddModel,
    updateModelImage,
    toggleThinkingLevel,
    toggleKeyExpanded,
    handleKeyAdd,
    handleTestKey,
    handleTestAllKeys,
    handleCloseProviderDrawer,
    handleSaveProvider,
  } = editor;

  // The provider editor is the deepest surface on this page, so Back closing it is the
  // difference between abandoning an edit and losing the page it was made on.
  useOverlayHistory({ isOpen: providerDrawerOpen, onClose: handleCloseProviderDrawer });

  // The picker's options come from the family registry, so a family the console
  // manages cannot appear in one control and not the other.
  const familyOptions = PROVIDER_FAMILIES.map((family) => ({
    label: `${t(family.labelKey)} (${family.id})`,
    value: family.id,
  }));

  return (

      <Drawer
        title={
          <div>
            <div style={{ fontSize: 12, color: 'var(--meta)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              {editingProvider ? t('common.edit') : t('pro.add_provider')}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--fg)', marginTop: 2 }}>
              {editingProvider
                ? `${t('common.edit')} · ${familyDisplayNames[formFamily] || formFamily}`
                : `${t('pro.add_provider')} · ${familyDisplayNames[formFamily] || formFamily}`}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
              {t('pro.manage_resource_subtitle', { path: `/ai-providers/${formFamily}` })}
            </div>
          </div>
        }
        open={providerDrawerOpen}
        onClose={handleCloseProviderDrawer}
        size="large"
        footer={
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, padding: '4px 0' }}>
            <Button onClick={handleCloseProviderDrawer}>
              {t('common.cancel')}
            </Button>
            <Button
              type="primary"
              loading={createProviderMutation.isPending || updateProviderMutation.isPending}
              disabled={isDemo}
              title={isDemo ? t('demo.blocked') : undefined}
              onClick={handleSaveProvider}
            >
              {t('common.save')}
            </Button>
          </div>
        }
      >
        <Form layout="vertical">
          {/* Provider Icon Card */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              marginBottom: 16,
              padding: '12px 14px',
              background: 'var(--surface)',
              borderRadius: 6,
              border: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 8,
                border: '1px solid var(--border)',
                background: 'var(--bg)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flexShrink: 0,
              }}
              onClick={() => {
                setTargetProviderForIcon(null);
                setIconPickerOpen(true);
              }}
              title={t('pro.change_icon')}
            >
              <LobeIcon iconId={formIcon} size={30} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: 'var(--meta)', marginBottom: 2 }}>
                {t('pro.field_icon')}
              </div>
              <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg)' }}>
                {formIcon}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button
                size="small"
                onClick={() => {
                  setTargetProviderForIcon(null);
                  setIconPickerOpen(true);
                }}
              >
                {t('pro.change_icon')}
              </Button>
              {formIcon !== getProviderDefaultIcon(formFamily, formName, formBaseURL) && (
                <Button
                  size="small"
                  type="link"
                  onClick={() => {
                    setFormIcon(getProviderDefaultIcon(formFamily, formName, formBaseURL));
                    setIconManuallySelected(false);
                  }}
                >
                  {t('pro.reset_icon')}
                </Button>
              )}
            </div>
          </div>

          {/* Driver & Name */}
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label={t('pro.field_family')} required>
                <Select
                  value={formFamily}
                  onChange={(val) => {
                  setFormFamily(val);
                  if (!iconManuallySelected) {
                    setFormIcon(getProviderDefaultIcon(val, formName, formBaseURL));
                  }
                }}
                  disabled={!!editingProvider}
                  options={familyOptions}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label={t('pro.field_name')} required>
                <Input
                  value={formName}
                  onChange={(e) => {
                  const val = e.target.value;
                  setFormName(val);
                  if (!iconManuallySelected) {
                    setFormIcon(getProviderDefaultIcon(formFamily, val, formBaseURL));
                  }
                }}
                  placeholder={t('pro.field_name_ph')}
                />
              </Form.Item>
            </Col>
          </Row>

          {/* Base URL */}
          <Form.Item
            label={
              <span>
                {t('pro.field_base_url')}{' '}
                <span style={{ fontSize: 12, color: 'var(--meta)', fontWeight: 400 }}>
                  · {t('pro.field_base_url_desc')}
                </span>
              </span>
            }
          >
            <Input
              value={formBaseURL}
              onChange={(e) => {
                const val = e.target.value;
                setFormBaseURL(val);
                modelFetchSeqRef.current += 1;
                setEndpointModels([]);
                setIsPullingModels(false);
                if (!iconManuallySelected) {
                  setFormIcon(getProviderDefaultIcon(formFamily, formName, val));
                }
              }}
              placeholder={t('pro.field_base_url_ph')}
            />
          </Form.Item>

          {/* Website: console metadata, deliberately not a CPA field. */}
          <Form.Item
            label={
              <span>
                {t('pro.field_website')}{' '}
                <span style={{ fontSize: 12, color: 'var(--meta)', fontWeight: 400 }}>
                  · {t('pro.field_website_desc')}
                </span>
              </span>
            }
            validateStatus={websiteInputState.status}
            help={websiteInputState.help}
          >
            <Input
              value={formWebsite}
              onChange={(e) => setFormWebsite(e.target.value)}
              placeholder="https://example.com"
              className="config-mono-input"
              allowClear
            />
          </Form.Item>

          {/* Prefix & Priority */}
          <Row gutter={16}>
            <Col xs={24} sm={12}>
              <Form.Item label={t('pro.field_prefix')}>
                <Input
                  value={formPrefix}
                  onChange={(e) => setFormPrefix(e.target.value)}
                  placeholder="e.g. prefix"
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label={t('pro.field_priority')}>
                <InputNumber
                  value={formPriority}
                  onChange={(val) => setFormPriority(val)}
                  placeholder="e.g. 1"
                  style={{ width: '100%' }}
                />
              </Form.Item>
            </Col>
          </Row>

          {/* Test Model */}
          <Form.Item label={t('pro.field_test_model')}>
            <Select
              value={
                formTestModel === 'auto' || formModels.some((m) => m.name === formTestModel)
                  ? formTestModel
                  : 'auto'
              }
              onChange={setFormTestModel}
              options={[
                {
                  label: formModels[0]?.name
                    ? t('pro.test_auto', { model: formModels[0].name })
                    : t('pro.test_auto_default'),
                  value: 'auto',
                },
                ...formModels
                  .filter((m) => !!m.name.trim())
                  .map((m) => ({
                    label: m.alias ? `${m.name} (${m.alias})` : m.name,
                    value: m.name,
                  })),
              ]}
            />
          </Form.Item>

          {/* Flags: Disabled & Disable Cooling */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ marginBottom: 12 }}>
              <Checkbox
                checked={formDisabled}
                onChange={(e) => setFormDisabled(e.target.checked)}
              >
                <span style={{ fontWeight: 500 }}>{t('pro.field_disabled')}</span>
              </Checkbox>
              <div style={{ fontSize: 12, color: 'var(--meta)', marginLeft: 24, marginTop: 2 }}>
                {t('pro.field_disabled_desc')}
              </div>
            </div>

            <div>
              <Checkbox
                checked={formDisableCooling}
                onChange={(e) => setFormDisableCooling(e.target.checked)}
              >
                <span style={{ fontWeight: 500 }}>{t('pro.field_disable_cooling')}</span>
              </Checkbox>
              <div style={{ fontSize: 12, color: 'var(--meta)', marginLeft: 24, marginTop: 2 }}>
                {t('pro.field_disable_cooling_desc')}
              </div>
            </div>
          </div>

          {/* Section: API Key Entries */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
              marginBottom: 16,
              overflow: 'hidden',
            }}
          >
            {/* Section Header */}
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'pointer',
                userSelect: 'none',
              }}
              onClick={() => setKeysSectionOpen((prev) => !prev)}
            >
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {t('pro.section_keys')}{' '}
                <span style={{ color: 'var(--meta)', fontWeight: 400, marginLeft: 6 }}>
                  {formKeys.length}
                </span>
              </div>
              <div style={{ color: 'var(--meta)', fontSize: 12 }}>
                {keysSectionOpen ? <UpOutlined /> : <DownOutlined />}
              </div>
            </div>

            {keysSectionOpen && (
              <div style={{ padding: '0 16px 16px 16px' }}>
                {/* Top Action Row */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 12,
                  }}
                >
                  <Button
                    style={{ borderStyle: 'dashed' }}
                    icon={<PlusOutlined />}
                    onClick={handleKeyAdd}
                  >
                    {t('pro.add_key_entry')}
                  </Button>
                  <Button onClick={handleTestAllKeys}>
                    {t('pro.test_all')}
                  </Button>
                </div>

                {/* Key Cards List */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {formKeys.map((k, idx) => {
                    const isExpanded = expandedKeyIds.has(k.id);
                    const displayKey = (k.apiKey || '').trim();

                    return (
                      <div
                        key={k.id}
                        style={{
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          background: 'var(--bg)',
                          overflow: 'hidden',
                        }}
                      >
                        {/* Key Item Header */}
                        <div
                          style={{
                            padding: '10px 14px',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            cursor: 'pointer',
                            userSelect: 'none',
                          }}
                          onClick={() => toggleKeyExpanded(k.id)}
                        >
                          <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--fg)' }}>
                            {t('pro.key_label', { n: idx + 1 })}
                          </div>

                          <div
                            style={{ display: 'flex', alignItems: 'center', gap: 12 }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {displayKey && (
                              <span
                                title={maskKeyText(displayKey)}
                                style={{
                                  fontFamily: 'monospace',
                                  fontWeight: 600,
                                  fontSize: 13,
                                  color: 'var(--fg)',
                                  letterSpacing: '0.5px',
                                  maxWidth: 220,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  display: 'inline-block',
                                  verticalAlign: 'middle',
                                }}
                              >
                                {maskKeyText(displayKey)}
                              </span>
                            )}
                            <Button
                              type="link"
                              size="small"
                              style={{ padding: '0 4px', height: 'auto', fontSize: 13 }}
                              onClick={() => handleTestKey(k, idx)}
                            >
                              {t('pro.test_single')}
                            </Button>
                            <span
                              style={{ cursor: 'pointer', color: 'var(--meta)', display: 'inline-flex' }}
                              onClick={() => toggleKeyExpanded(k.id)}
                            >
                              {isExpanded ? <UpOutlined /> : <DownOutlined />}
                            </span>
                            {formKeys.length > 1 && (
                              <Popconfirm
                                title={t('pro.delete_key_confirm')}
                                onConfirm={() => {
                                  setFormKeys((prev) => prev.filter((item) => item.id !== k.id));
                                  setExpandedKeyIds((prev) => {
                                    const next = new Set(prev);
                                    next.delete(k.id);
                                    return next;
                                  });
                                }}
                                okText={t('common.confirm')}
                                cancelText={t('common.cancel')}
                              >
                                <CloseOutlined
                                  style={{
                                    cursor: 'pointer',
                                    color: 'var(--danger)',
                                    fontSize: 12,
                                    marginLeft: 2,
                                  }}
                                />
                              </Popconfirm>
                            )}
                          </div>
                        </div>

                        {/* Key Item Body (when expanded) */}
                        {isExpanded && (
                          <div
                            style={{
                              padding: '14px 16px',
                              borderTop: '1px solid var(--border)',
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 14,
                            }}
                          >
                            {/* API Key */}
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--fg)' }}>
                                {t('pro.api_key_label')}
                              </div>
                              <Input.Password
                                value={k.apiKey || ''}
                                onChange={(e) =>
                                  setFormKeys((prev) =>
                                    prev.map((item) =>
                                      item.id === k.id ? { ...item, apiKey: e.target.value } : item
                                    )
                                  )
                                }
                                placeholder={t('pro.field_key_ph_create')}
                                style={{ width: '100%' }}
                              />
                            </div>

                            {/* Proxy URL */}
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--fg)' }}>
                                {t('pro.proxy_url_label')}
                              </div>
                              <Input
                                value={k.proxyUrl || ''}
                                onChange={(e) =>
                                  setFormKeys((prev) =>
                                    prev.map((item) =>
                                      item.id === k.id ? { ...item, proxyUrl: e.target.value } : item
                                    )
                                  )
                                }
                                placeholder="http://127.0.0.1:7890"
                                style={{ width: '100%' }}
                              />
                            </div>

                            {/* Schedule Weight */}
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--fg)' }}>
                                {t('pro.weight_label')}
                              </div>
                              <InputNumber
                                value={k.weight ?? 1}
                                onChange={(val) =>
                                  setFormKeys((prev) =>
                                    prev.map((item) =>
                                      item.id === k.id ? { ...item, weight: val ?? 1 } : item
                                    )
                                  )
                                }
                                min={0}
                                max={1000000}
                                style={{ width: '100%' }}
                                placeholder="1"
                              />
                              <div style={{ fontSize: 12, color: 'var(--meta)', marginTop: 4 }}>
                                {t('pro.weight_desc')}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Section: Custom Headers */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
              marginBottom: 16,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'pointer',
                userSelect: 'none',
              }}
              onClick={() => setHeadersSectionOpen((prev) => !prev)}
            >
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {t('pro.section_headers')}{' '}
                {formHeaders.length > 0 && (
                  <span style={{ color: 'var(--meta)', fontWeight: 400, marginLeft: 6 }}>
                    {formHeaders.length}
                  </span>
                )}
              </div>
              <div style={{ color: 'var(--meta)', fontSize: 12 }}>
                {headersSectionOpen ? <UpOutlined /> : <DownOutlined />}
              </div>
            </div>

            {headersSectionOpen && (
              <div style={{ padding: '0 16px 16px 16px' }}>
                {formHeaders.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                    {formHeaders.map((h) => (
                      <div key={h.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <Input
                          value={h.key}
                          onChange={(e) =>
                            setFormHeaders((prev) =>
                              prev.map((item) =>
                                item.id === h.id ? { ...item, key: e.target.value } : item
                              )
                            )
                          }
                          placeholder="X-Custom-Header"
                          style={{ flex: 1, fontFamily: 'monospace' }}
                        />
                        <Input
                          value={h.value}
                          onChange={(e) =>
                            setFormHeaders((prev) =>
                              prev.map((item) =>
                                item.id === h.id ? { ...item, value: e.target.value } : item
                              )
                            )
                          }
                          placeholder="value"
                          style={{ flex: 1 }}
                        />
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<CloseOutlined />}
                          onClick={() =>
                            setFormHeaders((prev) => prev.filter((item) => item.id !== h.id))
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
                <Button
                  style={{ borderStyle: 'dashed' }}
                  icon={<PlusOutlined />}
                  onClick={() =>
                    setFormHeaders((prev) => [
                      ...prev,
                      { id: `hdr-${Date.now()}-${formKeys.length}`, key: '', value: '' },
                    ])
                  }
                >
                  {t('pro.add_header_entry')}
                </Button>
              </div>
            )}
          </div>

          {/* Section: Custom Models */}
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--surface)',
              marginBottom: 20,
              overflow: 'hidden',
            }}
          >
            {/* Header row */}
            <div
              style={{
                padding: '12px 16px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                cursor: 'pointer',
                userSelect: 'none',
              }}
              onClick={() => setModelsSectionOpen((prev) => !prev)}
            >
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {t('pro.section_models')}{' '}
                {formModels.length > 0 && (
                  <span style={{ color: 'var(--meta)', fontWeight: 400, marginLeft: 6 }}>
                    {formModels.length}
                  </span>
                )}
              </div>
              <div style={{ color: 'var(--meta)', fontSize: 12 }}>
                {modelsSectionOpen ? <UpOutlined /> : <DownOutlined />}
              </div>
            </div>

            {modelsSectionOpen && (
              <div style={{ padding: '0 16px 16px 16px' }}>
                {/* Action Row: Fetch model list on right */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 12,
                  }}
                >
                  <div style={{ fontSize: 12, color: 'var(--meta)' }}>
                    {endpointModels.length > 0 && (
                      <span style={{ color: 'var(--accent)', fontWeight: 500 }}>
                        {t('pro.model_list_fetched', { n: endpointModels.length })}
                      </span>
                    )}
                  </div>
                  <Button
                    icon={<SyncOutlined spin={isPullingModels} />}
                    loading={isPullingModels}
                    disabled={isDemo}
                    title={isDemo ? t('demo.blocked') : undefined}
                    onClick={handlePullModels}
                  >
                    {endpointModels.length > 0
                      ? t('pro.refresh_model_list')
                      : t('pro.fetch_model_list')}
                  </Button>
                </div>

                {/* Column Titles */}
                {formModels.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      padding: '0 12px 6px 12px',
                      fontSize: 12,
                      color: 'var(--meta)',
                      fontWeight: 500,
                    }}
                  >
                    <div style={{ flex: 1 }}>{t('pro.actual_request_model')}</div>
                    <div style={{ flex: 1 }}>{t('pro.alias_optional')}</div>
                    <div style={{ width: 56 }} />
                  </div>
                )}

                {/* Configured Models List */}
                {formModels.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      marginBottom: 12,
                    }}
                  >
                    {formModels.map((m) => {
                      const isExpanded = expandedModelIds.has(m.id);
                      const otherSelected = new Set(
                        formModels
                          .filter((item) => item.id !== m.id && item.name.trim() !== '')
                          .map((item) => item.name)
                      );
                      // Filtered as the operator types, with models already
                      // configured on this provider suppressed. The list is
                      // pre-filtered rather than left to AutoComplete's own
                      // `filterOption`, whose combobox default is "do not
                      // filter" - the dropdown used to show the whole catalog
                      // no matter what was typed.
                      const modelOptions = modelOptionsFor(
                        endpointModels,
                        m.name,
                        otherSelected,
                      ).map((name) => ({ label: name, value: name }));

                      return (
                        <div
                          key={m.id}
                          id={`model-card-${m.id}`}
                          style={{
                            border: '1px solid var(--border)',
                            borderRadius: 6,
                            background: 'var(--bg)',
                            overflow: 'hidden',
                            scrollMarginBottom: 24,
                          }}
                        >
                          {/* Model Card Header */}
                          <div
                            style={{
                              padding: '10px 12px',
                              display: 'flex',
                              gap: 8,
                              alignItems: 'center',
                              background: 'rgba(255, 255, 255, 0.02)',
                            }}
                          >
                            <AutoComplete
                              value={m.name}
                              options={modelOptions}
                              // The options are already narrowed by the typed
                              // text above, so the popup must not apply a second,
                              // differently-scoped filter on top of them. Stated
                              // explicitly rather than left to the combobox
                              // default, which is what silently made this
                              // dropdown unfiltered in the first place.
                              showSearch={{ filterOption: false }}
                              onSelect={(val) => {
                                setFormModels((prev) =>
                                  prev.map((item) =>
                                    item.id === m.id
                                      ? {
                                          ...item,
                                          name: val,
                                          alias: item.alias.trim() ? item.alias : val,
                                        }
                                      : item
                                  )
                                );
                              }}
                              onChange={(val) => {
                                setFormModels((prev) =>
                                  prev.map((item) =>
                                    item.id === m.id ? { ...item, name: val } : item
                                  )
                                );
                              }}
                              style={{ flex: 1 }}
                            >
                              <Input
                                placeholder={t('pro.actual_request_model')}
                                suffix={
                                  endpointModels.length > 0 ? (
                                    <DownOutlined
                                      style={{ fontSize: 11, color: 'var(--meta)' }}
                                    />
                                  ) : undefined
                                }
                                style={{ fontFamily: 'monospace' }}
                              />
                            </AutoComplete>
                            <Input
                              value={m.alias}
                              onChange={(e) =>
                                setFormModels((prev) =>
                                  prev.map((item) =>
                                    item.id === m.id ? { ...item, alias: e.target.value } : item
                                  )
                                )
                              }
                              placeholder={t('pro.alias_optional')}
                              style={{ flex: 1 }}
                            />
                            <Button
                              type="text"
                              size="small"
                              icon={isExpanded ? <UpOutlined /> : <DownOutlined />}
                              onClick={() => toggleModelExpanded(m.id)}
                            />
                            <Button
                              size="small"
                              type="text"
                              danger
                              icon={<CloseOutlined />}
                              onClick={() => {
                                setFormModels((prev) => prev.filter((item) => item.id !== m.id));
                                setExpandedModelIds((prev) => {
                                  const next = new Set(prev);
                                  next.delete(m.id);
                                  return next;
                                });
                              }}
                            />
                          </div>

                          {/* Model Card Body (expanded) */}
                          {isExpanded && (
                            <div
                              style={{
                                padding: '14px 16px',
                                borderTop: '1px solid var(--border)',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 14,
                              }}
                            >
                              {/* Option: Allow Image Endpoint */}
                              <div>
                                <Checkbox
                                  checked={m.image || false}
                                  onChange={(e) => updateModelImage(m.id, e.target.checked)}
                                >
                                  <span style={{ fontWeight: 500 }}>
                                    {t('pro.allow_image_endpoint')}
                                  </span>
                                </Checkbox>
                                <div
                                  style={{
                                    fontSize: 12,
                                    color: 'var(--meta)',
                                    marginLeft: 24,
                                    marginTop: 2,
                                  }}
                                >
                                  {t('pro.allow_image_endpoint_desc')}
                                </div>
                              </div>

                              {/* Option: Allowed Thinking Levels */}
                              <div>
                                <div
                                  style={{
                                    fontWeight: 500,
                                    fontSize: 13,
                                    marginBottom: 8,
                                    color: 'var(--fg)',
                                  }}
                                >
                                  {t('pro.allowed_thinking_levels')}
                                </div>
                                <Row gutter={[10, 10]}>
                                  {THINKING_LEVEL_OPTIONS.map((opt) => {
                                    const isChecked =
                                      m.thinking?.levels?.includes(opt.value) || false;
                                    return (
                                      <Col xs={24} sm={12} key={opt.value}>
                                        <div
                                          role="button"
                                          tabIndex={0}
                                          onClick={() => toggleThinkingLevel(m.id, opt.value)}
                                          onKeyDown={(e) => {
                                            if (e.key === ' ' || e.key === 'Enter') {
                                              e.preventDefault();
                                              toggleThinkingLevel(m.id, opt.value);
                                            }
                                          }}
                                          style={{
                                            border: isChecked
                                              ? '1px solid var(--accent, #1677ff)'
                                              : '1px solid var(--border)',
                                            borderRadius: 6,
                                            padding: '8px 12px',
                                            background: isChecked
                                              ? 'rgba(22, 119, 255, 0.08)'
                                              : 'var(--surface)',
                                            cursor: 'pointer',
                                            display: 'flex',
                                            justifyContent: 'space-between',
                                            alignItems: 'center',
                                            transition: 'border-color var(--motion-fast), background var(--motion-fast)',
                                            userSelect: 'none',
                                          }}
                                        >
                                          <Checkbox
                                            checked={isChecked}
                                            tabIndex={-1}
                                            style={{ pointerEvents: 'none' }}
                                          >
                                            <span style={{ fontWeight: isChecked ? 600 : 400 }}>
                                              {t(opt.labelKey)}
                                            </span>
                                          </Checkbox>
                                          <span
                                            style={{
                                              fontSize: 11,
                                              fontFamily: 'monospace',
                                              color: 'var(--meta)',
                                            }}
                                          >
                                            {opt.value}
                                          </span>
                                        </div>
                                      </Col>
                                    );
                                  })}
                                </Row>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <Button
                  style={{ borderStyle: 'dashed' }}
                  icon={<PlusOutlined />}
                  onClick={handleAddModel}
                >
                  {t('pro.add_model_entry')}
                </Button>
              </div>
            )}
          </div>
        </Form>
      </Drawer>
  );
}
