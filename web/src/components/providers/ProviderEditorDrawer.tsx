import { ConnectionPoolEditor } from './ConnectionPoolEditor';
import { EMPTY_CONNECTION_POOL_DRAFT, buildConnectionPool } from './connectionPool';
import { AutoComplete } from '@/components/ui/autocomplete';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { NumberInput } from '../common/NumberInput';
import { CheckSquareOutlined, CloseOutlined, DownOutlined, PlusOutlined, SyncOutlined } from '../icons';

import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import { useCustomIcons } from '../../hooks/useCustomIcons';
import { usePluginOAuthLogos } from '../../hooks/usePluginOAuthLogos';
import { customIconID } from '../../types/customIcons';
import { isDemoMode } from '../../types/demoMode';
import { ProviderMark } from '../LobeIcon';
import { getProviderDefaultIcon } from '../../types/providerIconIds';
import { maskKeyText } from '../../utils/maskKey';
import { modelOptionsFor } from '../../utils/modelOptions';
import { PROVIDER_FAMILIES, lookupProviderFamily } from '../../types/providerFamilies';
import type { useProviderManagement } from './useProviderManagement';
import { EditorSection } from './EditorSection';
import { Fold } from '../common/Fold';
import { RuntimePolicySection } from './RuntimePolicySection';
import { countPolicyOverrides } from './runtimePolicy';
import { ModelOptionsFields } from './ModelOptionsFields';
import { modelOptionsProblem } from './modelOptions';
import { ModelPickerModal } from './ModelPickerModal';
import {
  OPENCODE_SESSION_HEADER,
  OPENCODE_SESSION_HEADER_VALUE,
  openCodeSessionState,
  isOpenCodeEndpoint,
  withOpenCodeSessionHeader,
} from './opencodeSession';
import { Notice } from '../feedback';
import { SecretInput } from '../common/SecretInput';
import styles from './ProviderEditorDrawer.module.css';
import { AppDrawer } from '../common/AppDrawer';
import { ConfirmAction } from '../common/ConfirmAction';

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
  | 'formConnectionPool'
  | 'setFormConnectionPool'
  | 'formPolicy'
  | 'setFormPolicy'
  | 'formBehavior'
  | 'setFormBehavior'
  | 'policySectionOpen'
  | 'setPolicySectionOpen'
  | 'isPolicyChecked'
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
  | 'setThinkingLevels'
  | 'toggleKeyExpanded'
  | 'handleKeyAdd'
  | 'testingKeyIds'
  | 'isTestingAllKeys'
  | 'handleTestKey'
  | 'handleTestAllKeys'
  | 'handleCloseProviderDrawer'
  | 'handleSaveProvider'
> {}

const THINKING_LEVEL_OPTIONS: readonly { value: string; labelKey: MessageKey }[] = [
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
    formConnectionPool,
    setFormConnectionPool,
    formPolicy,
    setFormPolicy,
    formBehavior,
    setFormBehavior,
    policySectionOpen,
    setPolicySectionOpen,
    isPolicyChecked,
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
    setThinkingLevels,
    toggleKeyExpanded,
    handleKeyAdd,
    testingKeyIds,
    isTestingAllKeys,
    handleTestKey,
    handleTestAllKeys,
    handleCloseProviderDrawer,
    handleSaveProvider,
  } = editor;
  const selectedCustomID = customIconID(formIcon);
  const customIcons = useCustomIcons(providerDrawerOpen && Boolean(selectedCustomID));
  const pluginLogos = usePluginOAuthLogos();
  const iconName = selectedCustomID
    ? customIcons.data?.find((icon) => icon.id === selectedCustomID)?.name ?? t('pro.field_icon')
    : formIcon;

  // The picker's options come from the family registry, so a family the console
  // manages cannot appear in one control and not the other.
  const familyOptions = PROVIDER_FAMILIES.map((family) => ({
    label: `${t(family.labelKey)} (${family.id})`,
    value: family.id,
  }));
  const familyMeta = lookupProviderFamily(formFamily);
  const supportsModelImage = familyMeta?.supportsModelImage ?? false;
  const modelOptionFields = familyMeta?.modelOptionFields ?? [];
  const policyOverrideCount = countPolicyOverrides(formPolicy, formBehavior, familyMeta?.behaviorSwitches) + (formConnectionPool.isConfigured ? 1 : 0);
  const configuredModelNames = new Set(
    formModels.map((m) => m.name.trim()).filter((name) => name !== ''),
  );
  const openCodeSession = isOpenCodeEndpoint(formBaseURL) ? openCodeSessionState(formHeaders) : null;

  // The one click only edits the draft: the header travels with the Save the
  // operator already has to make, so nothing is written behind their back.
  const handleAddOpenCodeSessionHeader = () => {
    setFormHeaders((prev) => withOpenCodeSessionHeader(prev, `hdr-opencode-${Date.now()}`));
    setHeadersSectionOpen(true);
  };

  return (

      <AppDrawer
        widthKey="provider_editor"
        title={t(editingProvider ? 'pro.editor_edit_title' : 'pro.editor_add_title', {
          family: familyDisplayNames[formFamily] || formFamily,
        })}
        open={providerDrawerOpen}
        onClose={handleCloseProviderDrawer}
        width="wide"
        footer={
          <>
            <Button onClick={handleCloseProviderDrawer}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={createProviderMutation.isPending || updateProviderMutation.isPending}
              disabled={isDemo}
              data-tip={isDemo ? t('demo.blocked') : undefined}
              onClick={handleSaveProvider}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div>
          {/* Provider Icon Card */}
          <div className={styles['icon-card']}>
            <div
              className={styles['icon-tile']}
              onClick={() => {
                setTargetProviderForIcon(null);
                setIconPickerOpen(true);
              }}
              data-tip={t('pro.change_icon')}
            >
              <ProviderMark provider={{ id: editingProvider?.id, family: formFamily, name: formName, upstream_name: editingProvider?.upstream_name, base_url: formBaseURL, icon_id: formIcon }} sources={{ pluginLogos }} size={30} />
            </div>
            <div className={styles['icon-meta']}>
              <div className={styles['icon-label']}>{t('pro.field_icon')}</div>
              <div className={styles['icon-name']}>{iconName}</div>
            </div>
            <div className={styles['icon-actions']}>
              <Button
                size="sm"
                onClick={() => {
                  setTargetProviderForIcon(null);
                  setIconPickerOpen(true);
                }}
              >
                {t('pro.change_icon')}
              </Button>
              {formIcon !== getProviderDefaultIcon(formFamily, formName, formBaseURL) && (
                <Button
                  size="sm"
                  variant="link"
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Field
                label={t('pro.field_family')}
                required
                extra={editingProvider && formFamily !== editingProvider.family
                  ? t(formFamily !== 'openai-compatibility' && formKeys.length > 1
                    ? 'pro.family_change_keys_hint'
                    : 'pro.family_change_hint')
                  : undefined}
              >
                <Select
                  aria-label={t('pro.field_family')}
                  value={formFamily}
                  onChange={(val) => {
                    setFormFamily(val);
                    modelFetchSeqRef.current += 1;
                    setEndpointModels([]);
                    setIsPullingModels(false);
                    setIsModelPickerOpen(false);
                    if (!iconManuallySelected) {
                      setFormIcon(getProviderDefaultIcon(val, formName, formBaseURL));
                    }
                  }}
                  disabled={createProviderMutation.isPending || updateProviderMutation.isPending}
                  options={familyOptions}
                />
              </Field>
            </div>
            <div>
              <Field label={t('pro.field_name')} required>
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
              </Field>
            </div>
          </div>

          {/* Base URL */}
          <Field
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
          </Field>

          {/* Guidance sits with the URL that makes the header necessary: the
              Custom Headers group is collapsed by default, and a requirement
              discovered only after a failed request is the bug this prevents. */}
          {openCodeSession === 'missing' && (
            <Notice
              tone="warning"
              className={styles['endpoint-notice']}
              title={t('pro.opencode_session_title')}
              description={t('pro.opencode_session_desc', {
                header: OPENCODE_SESSION_HEADER,
                value: OPENCODE_SESSION_HEADER_VALUE,
              })}
              action={
                <Button size="sm" onClick={handleAddOpenCodeSessionHeader}>
                  {t('pro.opencode_session_add', { header: OPENCODE_SESSION_HEADER })}
                </Button>
              }
            />
          )}
          {/* Two configured ids are reported, never resolved: whichever one this
              console picked would silently replace the other on the wire. */}
          {openCodeSession === 'conflict' && (
            <Notice
              tone="warning"
              className={styles['endpoint-notice']}
              title={t('pro.opencode_session_conflict_title')}
              description={t('pro.opencode_session_conflict_desc', { header: OPENCODE_SESSION_HEADER })}
              action={
                <Button size="sm" onClick={() => setHeadersSectionOpen(true)}>
                  {t('pro.opencode_session_review')}
                </Button>
              }
            />
          )}

          {/* Website: console metadata, deliberately not a CPA field. */}
          <Field
            label={
              <span>
                {t('pro.field_website')}{' '}
                <span className={styles['label-hint']}>
                  · {t('pro.field_website_desc')}
                </span>
              </span>
            }
            error={websiteInputState.status === 'error' ? websiteInputState.help : undefined}
            extra={websiteInputState.status !== 'error' ? websiteInputState.help : undefined}
          >
            <Input
              value={formWebsite}
              onChange={(e) => setFormWebsite(e.target.value)}
              placeholder="https://example.com"
              className="config-mono-input"
              status={websiteInputState.status === 'error' ? 'error' : undefined}
              allowClear
            />
          </Field>

          {/* Prefix & Priority */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Field label={t('pro.field_prefix')}>
                <Input
                  value={formPrefix}
                  onChange={(e) => setFormPrefix(e.target.value)}
                  placeholder="e.g. prefix"
                />
              </Field>
            </div>
            <div>
              <Field label={t('pro.field_priority')}>
                <NumberInput
                  value={formPriority}
                  onChange={(val) => setFormPriority(val)}
                  placeholder="e.g. 1"
                  className={styles['full-width']}
                />
              </Field>
            </div>
          </div>

          {/* Test Model */}
          <Field label={t('pro.field_test_model')}>
            <Select
              value={
                formTestModel === '' || formModels.some((m) => m.name === formTestModel)
                  ? formTestModel
                  : ''
              }
              onChange={setFormTestModel}
              options={[
                {
                  label: formModels[0]?.name
                    ? t('pro.test_auto', { model: formModels[0].name })
                    : t('pro.test_auto_default'),
                  value: '',
                },
                ...formModels
                  .filter((m) => !!m.name.trim())
                  .map((m) => ({
                    label: m.alias ? `${m.name} (${m.alias})` : m.name,
                    value: m.name,
                  })),
              ]}
            />
          </Field>

          {/* Flag: Disabled */}
          <div className={styles['flag-list']}>
            <div className={styles['flag']}>
              <Checkbox
                checked={formDisabled}
                onCheckedChange={(checked) => setFormDisabled(checked)}
              >
                <span className={styles['flag-label']}>{t('pro.field_disabled')}</span>
              </Checkbox>
              <div className={styles['flag-desc']}>
                {t('pro.field_disabled_desc')}
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
                    variant="dashed"
                    icon={<PlusOutlined />}
                    onClick={handleKeyAdd}
                  >
                    {t('pro.add_key_entry')}
                  </Button>
                  <Button
                    loading={isTestingAllKeys}
                    disabled={isDemo || isTestingAllKeys}
                    onClick={handleTestAllKeys}
                  >
                    {t('pro.test_all')}
                  </Button>
                </div>

                {formFamily !== 'openai-compatibility' && formKeys.length > 1 && (
                  <div className={styles['section-note']}>{t('pro.keys_split_hint')}</div>
                )}

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
                              <span className={styles['item-key']} data-tip={maskKeyText(displayKey)} data-tip-overflow="">
                                {maskKeyText(displayKey)}
                              </span>
                            )}
                          </button>

                          <div className={styles['item-actions']}>
                            <Button
                              variant="link"
                              size="sm"
                              loading={testingKeyIds.has(k.id)}
                              disabled={isDemo || testingKeyIds.has(k.id)}
                              onClick={() => handleTestKey(k, idx)}
                            >
                              {t('pro.test_single')}
                            </Button>
                            {/* A pointer affordance only: the header button is the toggle a
                                keyboard and a screen reader use, and a second one would be
                                announced twice. */}
                            <Button
                              variant="ghost"
                              size="sm"
                              icon={<DownOutlined className={styles['chevron']} />}
                              data-expanded={isExpanded || undefined}
                              aria-hidden="true"
                              tabIndex={-1}
                              onClick={() => toggleKeyExpanded(k.id)}
                            />
                            {formKeys.length > 1 && (
                              <ConfirmAction
                                title={t('pro.delete_key_confirm')}
                                onConfirm={() => {
                                  setFormKeys((prev) => prev.filter((item) => item.id !== k.id));
                                  setExpandedKeyIds((prev) => {
                                    const next = new Set(prev);
                                    next.delete(k.id);
                                    return next;
                                  });
                                }}
                                isDanger
                              >
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  danger
                                  icon={<CloseOutlined />}
                                  aria-label={`${t('common.delete')}: ${t('pro.key_label', { n: idx + 1 })}`}
                                />
                              </ConfirmAction>
                            )}
                          </div>
                        </div>

                        {/* Key Item Body (when expanded) */}
                        <Fold isOpen={isExpanded} className={styles['item-body']}>
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
                            <NumberInput
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
                          <ConnectionPoolEditor
                            draft={k.connectionPool ?? EMPTY_CONNECTION_POOL_DRAFT}
                            defaults={buildConnectionPool(formConnectionPool)}
                            onChange={connectionPool => setFormKeys(previous => previous.map(item => item.id === k.id ? { ...item, connectionPool } : item))}
                          />
                        </Fold>
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
                          size="sm"
                          variant="ghost"
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
                  variant="dashed"
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
                      data-tip={isDemo ? t('demo.blocked') : undefined}
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
                              filterOption={false}
                              placeholder={t('pro.actual_request_model')}
                              showCaret={endpointModels.length > 0}
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
                            />
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
                              variant="ghost"
                              size="sm"
                              icon={<DownOutlined className={styles['chevron']} />}
                              aria-label={m.name || t('pro.actual_request_model')}
                              aria-expanded={isExpanded}
                              onClick={() => toggleModelExpanded(m.id)}
                            />
                            <Button
                              size="sm"
                              variant="ghost"
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
                          <Fold isOpen={isExpanded} className={styles['item-body']}>
                            {/* Only the OpenAI-compatible model entry has the image flag;
                                CPA refuses it on every other family's list. */}
                            {supportsModelImage && (
                              <div>
                                <Checkbox
                                  checked={m.image || false}
                                  onCheckedChange={(checked) => updateModelImage(m.id, checked)}
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
                              <div className={styles['level-head']}>
                                <span className={styles['item-field-label']}>
                                  {t('pro.allowed_thinking_levels')}
                                </span>
                                <Checkbox
                                  className={styles['level-select-all']}
                                  checked={THINKING_LEVEL_OPTIONS.every((opt) => m.thinking?.levels?.includes(opt.value))}
                                  indeterminate={THINKING_LEVEL_OPTIONS.some((opt) => m.thinking?.levels?.includes(opt.value))
                                    && !THINKING_LEVEL_OPTIONS.every((opt) => m.thinking?.levels?.includes(opt.value))}
                                  onCheckedChange={(checked) => {
                                    const current = m.thinking?.levels ?? [];
                                    const known = new Set(THINKING_LEVEL_OPTIONS.map((opt) => opt.value));
                                    const next = checked
                                      ? [...THINKING_LEVEL_OPTIONS.map((opt) => opt.value), ...current.filter((level) => !known.has(level))]
                                      : current.filter((level) => !known.has(level));
                                    setThinkingLevels(m.id, next);
                                  }}
                                >
                                  {t('pro.select_all')}
                                </Checkbox>
                              </div>
                              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                                {THINKING_LEVEL_OPTIONS.map((opt) => {
                                  const isChecked =
                                    m.thinking?.levels?.includes(opt.value) || false;
                                  return (
                                    <div key={opt.value}>
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
                                    </div>
                                  );
                                })}
                              </div>
                            </div>

                            <ModelOptionsFields
                              idPrefix={`model-${m.id}`}
                              options={m.options}
                              fields={modelOptionFields}
                              problem={modelOptionsProblem(m.options, modelOptionFields)}
                              onChange={(patch) =>
                                setFormModels((prev) =>
                                  prev.map((item) =>
                                    item.id === m.id ? { ...item, options: { ...item.options, ...patch } } : item
                                  )
                                )
                              }
                            />
                          </Fold>
                        </div>
                      );
                    })}
                  </div>
                )}

                <Button variant="dashed" icon={<PlusOutlined />} onClick={handleAddModel}>
                  {t('pro.add_model_entry')}
                </Button>
          </EditorSection>

          {/* Section: Runtime policy */}
          <EditorSection
            title={t('policy.section')}
            count={policyOverrideCount > 0 ? policyOverrideCount : undefined}
            isOpen={policySectionOpen}
            onToggle={() => setPolicySectionOpen((prev) => !prev)}
          >
            <RuntimePolicySection
              connectionPool={formConnectionPool}
              onConnectionPoolChange={setFormConnectionPool}
              poolGroupName={editingProvider?.family === formFamily ? editingProvider.connection_pool?.group_name : undefined}
              poolGroupSize={editingProvider?.family === formFamily ? editingProvider.connection_pool?.group_size ?? formKeys.length : formKeys.length}
              policy={formPolicy}
              onPolicyChange={setFormPolicy}
              behavior={formBehavior}
              onBehaviorChange={setFormBehavior}
              supportsErrorRules={familyMeta?.supportsErrorRules ?? false}
              behaviorSwitches={familyMeta?.behaviorSwitches ?? []}
              showProblems={isPolicyChecked}
            />
          </EditorSection>
        </div>
        <ModelPickerModal
          isOpen={isModelPickerOpen && providerDrawerOpen && endpointModels.length > 0}
          models={endpointModels}
          configured={configuredModelNames}
          onApply={handleAddPickedModels}
          onClose={() => setIsModelPickerOpen(false)}
        />
      </AppDrawer>
  );
}
