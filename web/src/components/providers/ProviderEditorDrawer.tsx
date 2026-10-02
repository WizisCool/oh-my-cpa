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
import { CheckSquareOutlined, CloseOutlined, DownOutlined, PlusOutlined, SyncOutlined, UpOutlined } from '../icons';

import { useT } from '../../i18n';
import { useCustomIcons } from '../../hooks/useCustomIcons';
import { usePluginOAuthLogos } from '../../hooks/usePluginOAuthLogos';
import { customIconID } from '../../types/customIcons';
import { pluginOAuthLogoFor } from '../../types/pluginOAuthProviders';
import { isDemoMode } from '../../types/demoMode';
import { ProviderBrandIcon, getProviderDefaultIcon } from '../LobeIcon';
import { maskKeyText } from '../../utils/maskKey';
import { modelOptionsFor } from '../../utils/modelOptions';
import { PROVIDER_FAMILIES, lookupProviderFamily } from '../../types/providerFamilies';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import type { useProviderManagement } from './useProviderManagement';
import { EditorSection } from './EditorSection';
import { ModelPickerModal } from './ModelPickerModal';
import { SecretInput } from '../common/SecretInput';
import styles from './ProviderEditorDrawer.module.css';

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
  | 'isModelPickerOpen'
  | 'setIsModelPickerOpen'
  | 'handleAddPickedModels'
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
    isModelPickerOpen,
    setIsModelPickerOpen,
    handleAddPickedModels,
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
  const selectedCustomID = customIconID(formIcon);
  const customIcons = useCustomIcons(providerDrawerOpen && Boolean(selectedCustomID));
  const pluginLogos = usePluginOAuthLogos();
  const providerKeys = [formFamily, editingProvider?.upstream_name, formName, editingProvider?.id];
  const pluginLogo = providerKeys.map((key) => pluginOAuthLogoFor(pluginLogos, key)).find(Boolean);
  const iconName = selectedCustomID
    ? customIcons.data?.find((icon) => icon.id === selectedCustomID)?.name ?? t('pro.field_icon')
    : formIcon;

  // The provider editor is the deepest surface on this page, so Back closing it is the
  // difference between abandoning an edit and losing the page it was made on.
  useOverlayHistory({ isOpen: providerDrawerOpen, onClose: handleCloseProviderDrawer });

  // The picker's options come from the family registry, so a family the console
  // manages cannot appear in one control and not the other.
  const familyOptions = PROVIDER_FAMILIES.map((family) => ({
    label: `${t(family.labelKey)} (${family.id})`,
    value: family.id,
  }));
  const supportsModelImage = lookupProviderFamily(formFamily)?.supportsModelImage ?? false;
  const configuredModelNames = new Set(
    formModels.map((m) => m.name.trim()).filter((name) => name !== ''),
  );

  return (

      <Drawer
        title={
          <div>
            <div className={styles['drawer-title']}>
              {editingProvider
                ? `${t('common.edit')} · ${familyDisplayNames[formFamily] || formFamily}`
                : `${t('pro.add_provider')} · ${familyDisplayNames[formFamily] || formFamily}`}
            </div>
          </div>
        }
        open={providerDrawerOpen}
        onClose={handleCloseProviderDrawer}
        size="large"
        footer={
          <div className={styles['drawer-footer']}>
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
          <div className={styles['icon-card']}>
            <div
              className={styles['icon-tile']}
              onClick={() => {
                setTargetProviderForIcon(null);
                setIconPickerOpen(true);
              }}
              title={t('pro.change_icon')}
            >
              <ProviderBrandIcon iconId={formIcon} logo={pluginLogo} providerKeys={providerKeys} fallbackIconId={getProviderDefaultIcon(formFamily, formName, formBaseURL)} size={30} />
            </div>
            <div className={styles['icon-meta']}>
              <div className={styles['icon-label']}>{t('pro.field_icon')}</div>
              <div className={styles['icon-name']}>{iconName}</div>
            </div>
            <div className={styles['icon-actions']}>
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
            required={lookupProviderFamily(formFamily)?.requiresBaseURL ?? false}
            label={
              <span>
                {t('pro.field_base_url')}{' '}
                <span className={styles['label-hint']}>
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
                <span className={styles['label-hint']}>
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
                  className={styles['full-width']}
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
          <div className={styles['flag-list']}>
            <div className={styles['flag']}>
              <Checkbox
                checked={formDisabled}
                onChange={(e) => setFormDisabled(e.target.checked)}
              >
                <span className={styles['flag-label']}>{t('pro.field_disabled')}</span>
              </Checkbox>
              <div className={styles['flag-desc']}>
                {t('pro.field_disabled_desc')}
              </div>
            </div>

            <div className={styles['flag']}>
              <Checkbox
                checked={formDisableCooling}
                onChange={(e) => setFormDisableCooling(e.target.checked)}
              >
                <span className={styles['flag-label']}>{t('pro.field_disable_cooling')}</span>
              </Checkbox>
              <div className={styles['flag-desc']}>
                {t('pro.field_disable_cooling_desc')}
              </div>
            </div>
          </div>

          {/* Section: API Key Entries */}
          <EditorSection
            title={t('pro.section_keys')}
            count={formKeys.length}
            isOpen={keysSectionOpen}
            onToggle={() => setKeysSectionOpen((prev) => !prev)}
          >
                {/* Top Action Row */}
                <div className={styles['section-actions']}>
                  <Button
                    type="dashed"
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
                <div className={styles['item-list']}>
                  {formKeys.map((k, idx) => {
                    const isExpanded = expandedKeyIds.has(k.id);
                    const displayKey = (k.apiKey || '').trim();

                    return (
                      <div key={k.id} className={styles['item-card']}>
                        {/* Key Item Header: the title and the masked key are one toggle, so a
                            keyboard reaches it and a screen reader hears its state. */}
                        <div className={styles['item-head']}>
                          <button
                            type="button"
                            className={styles['item-toggle']}
                            aria-expanded={isExpanded}
                            onClick={() => toggleKeyExpanded(k.id)}
                          >
                            <span className={styles['item-title']}>{t('pro.key_label', { n: idx + 1 })}</span>
                            {displayKey && (
                              <span className={styles['item-key']} title={maskKeyText(displayKey)}>
                                {maskKeyText(displayKey)}
                              </span>
                            )}
                          </button>

                          <div className={styles['item-actions']}>
                            <Button type="link" size="small" onClick={() => handleTestKey(k, idx)}>
                              {t('pro.test_single')}
                            </Button>
                            {/* A pointer affordance only: the header button is the toggle a
                                keyboard and a screen reader use, and a second one would be
                                announced twice. */}
                            <Button
                              type="text"
                              size="small"
                              icon={isExpanded ? <UpOutlined /> : <DownOutlined />}
                              aria-hidden="true"
                              tabIndex={-1}
                              onClick={() => toggleKeyExpanded(k.id)}
                            />
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
                                okButtonProps={{ danger: true }}
                              >
                                <Button
                                  type="text"
                                  size="small"
                                  danger
                                  icon={<CloseOutlined />}
                                  aria-label={`${t('common.delete')}: ${t('pro.key_label', { n: idx + 1 })}`}
                                />
                              </Popconfirm>
                            )}
                          </div>
                        </div>

                        {/* Key Item Body (when expanded) */}
                        {isExpanded && (
                          <div className={styles['item-body']}>
                            {/* API Key */}
                            <div>
                              <div className={styles['item-field-label']}>
                                {t('pro.api_key_label')}
                              </div>
                              <SecretInput
                                value={k.apiKey || ''}
                                onChange={(e) =>
                                  setFormKeys((prev) =>
                                    prev.map((item) =>
                                      item.id === k.id ? { ...item, apiKey: e.target.value } : item
                                    )
                                  )
                                }
                                placeholder={t('pro.field_key_ph_create')}
                                className={styles['full-width']}
                              />
                            </div>

                            {/* Proxy URL */}
                            <div>
                              <div className={styles['item-field-label']}>
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
                                className={styles['full-width']}
                              />
                            </div>

                            {/* Schedule Weight */}
                            <div>
                              <div className={styles['item-field-label']}>
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
                                className={styles['full-width']}
                                placeholder="1"
                              />
                              <div className={styles['field-hint']}>
                                {t('pro.weight_desc')}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
          </EditorSection>

          {/* Section: Custom Headers */}
          <EditorSection
            title={t('pro.section_headers')}
            count={formHeaders.length > 0 ? formHeaders.length : undefined}
            isOpen={headersSectionOpen}
            onToggle={() => setHeadersSectionOpen((prev) => !prev)}
          >
                {formHeaders.length > 0 && (
                  <div className={styles['header-list']}>
                    {formHeaders.map((h) => (
                      <div key={h.id} className={styles['header-row']}>
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
                          className={styles['header-input']}
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
                          className={styles['header-input']}
                        />
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<CloseOutlined />}
                          aria-label={`${t('common.delete')}: ${h.key || t('pro.section_headers')}`}
                          onClick={() =>
                            setFormHeaders((prev) => prev.filter((item) => item.id !== h.id))
                          }
                        />
                      </div>
                    ))}
                  </div>
                )}
                <Button
                  type="dashed"
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
          </EditorSection>

          {/* Section: Custom Models */}
          <EditorSection
            title={t('pro.section_models')}
            count={formModels.length > 0 ? formModels.length : undefined}
            isOpen={modelsSectionOpen}
            onToggle={() => setModelsSectionOpen((prev) => !prev)}
          >
                {/* Action Row: Fetch model list on right */}
                <div className={styles['section-actions']}>
                  <div className={styles['section-note']}>
                    {endpointModels.length > 0 && (
                      <span className={styles['section-note-accent']}>
                        {t('pro.model_list_fetched', { n: endpointModels.length })}
                      </span>
                    )}
                  </div>
                  <div className={styles['section-buttons']}>
                    {endpointModels.length > 0 && (
                      <Button icon={<CheckSquareOutlined />} onClick={() => setIsModelPickerOpen(true)}>
                        {t('pro.pick_models')}
                      </Button>
                    )}
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
                </div>

                {/* Column Titles */}
                {formModels.length > 0 && (
                  <div className={styles['model-columns']}>
                    <div>{t('pro.actual_request_model')}</div>
                    <div>{t('pro.alias_optional')}</div>
                    <div className={styles['model-columns-spacer']} />
                  </div>
                )}

                {/* Configured Models List */}
                {formModels.length > 0 && (
                  <div className={`${styles['item-list']} ${styles['item-list-spaced']}`}>
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
                        <div key={m.id} id={`model-card-${m.id}`} className={`${styles['item-card']} ${styles['model-card']}`}>
                          {/* Model Card Header */}
                          <div className={styles['model-head']}>
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
                              className={styles['model-input']}
                            >
                              <Input
                                placeholder={t('pro.actual_request_model')}
                                suffix={
                                  endpointModels.length > 0 ? (
                                    <DownOutlined className={styles['model-suffix']} />
                                  ) : undefined
                                }
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
                              className={styles['model-input']}
                            />
                            <Button
                              type="text"
                              size="small"
                              icon={isExpanded ? <UpOutlined /> : <DownOutlined />}
                              aria-label={m.name || t('pro.actual_request_model')}
                              aria-expanded={isExpanded}
                              onClick={() => toggleModelExpanded(m.id)}
                            />
                            <Button
                              size="small"
                              type="text"
                              danger
                              icon={<CloseOutlined />}
                              aria-label={`${t('common.delete')}: ${m.name || t('pro.actual_request_model')}`}
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
                            <div className={styles['item-body']}>
                              {/* Only the OpenAI-compatible model entry has the image flag;
                                  CPA refuses it on every other family's list. */}
                              {supportsModelImage && (
                                <div>
                                  <Checkbox
                                    checked={m.image || false}
                                    onChange={(e) => updateModelImage(m.id, e.target.checked)}
                                  >
                                    <span className={styles['flag-label']}>
                                      {t('pro.allow_image_endpoint')}
                                    </span>
                                  </Checkbox>
                                  <div className={styles['flag-desc']}>
                                    {t('pro.allow_image_endpoint_desc')}
                                  </div>
                                </div>
                              )}

                              {/* Option: Allowed Thinking Levels */}
                              <div>
                                <div className={styles['item-field-label']}>
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
                                          aria-pressed={isChecked}
                                          className={`${styles['level-option']} ${isChecked ? styles['level-option-checked'] : ''}`}
                                        >
                                          <Checkbox checked={isChecked} tabIndex={-1} className={styles['level-check']}>
                                            <span className={styles['level-label']}>{t(opt.labelKey)}</span>
                                          </Checkbox>
                                          <span className={styles['level-value']}>{opt.value}</span>
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

                <Button type="dashed" icon={<PlusOutlined />} onClick={handleAddModel}>
                  {t('pro.add_model_entry')}
                </Button>
          </EditorSection>
        </Form>
        <ModelPickerModal
          isOpen={isModelPickerOpen && providerDrawerOpen && endpointModels.length > 0}
          models={endpointModels}
          configured={configuredModelNames}
          onApply={handleAddPickedModels}
          onClose={() => setIsModelPickerOpen(false)}
        />
      </Drawer>
  );
}
