import React, { useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, App as AntdApp, Button } from 'antd';
import { PlusOutlined, SyncOutlined } from '@ant-design/icons';

import { useT } from '../i18n';
import { getProviderDefaultIcon } from '../components/LobeIcon';
import { IconPickerModal } from '../components/IconPickerModal';
import { resolveProviderIcon } from '../types/providerIcons';
import { PROVIDER_FAMILIES } from '../types/providerFamilies';
import { useProviderIconOverrides } from '../components/providers/useProviderIconOverrides';
import { usePluginOAuthLogos } from '../hooks/usePluginOAuthLogos';
import { useProviderList } from '../components/providers/useProviderList';
import { useProviderManagement } from '../components/providers/useProviderManagement';
import { ProviderEditorDrawer } from '../components/providers/ProviderEditorDrawer';
import { ProviderTable } from '../components/providers/ProviderTable';

export const ProvidersPage: React.FC = () => {
  const t = useT();
  const { message } = AntdApp.useApp();

  const { providerIcons, writeProviderIcon, shiftCachedProviderIcons } = useProviderIconOverrides();
  // A plugin-registered provider's own logo outranks everything the console stores
  // for it, because the plugin owns that provider's identity.
  const pluginLogos = usePluginOAuthLogos();
  const {
    providers,
    providersLoading,
    providersFetching,
    providersError,
    providersErr,
    refetchProviders,
    settleProviderRow,
  } = useProviderList();
  const {
    createProviderMutation,
    deleteProviderMutation,
    updateProviderMutation,
    statusQueue,
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
    iconManuallySelected,
    setIconManuallySelected,
    iconPickerOpen,
    setIconPickerOpen,
    targetProviderForIcon,
    setTargetProviderForIcon,
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
    handleSelectIcon,
    toggleKeyExpanded,
    handleKeyAdd,
    handleTestKey,
    handleTestAllKeys,
    handleCloseProviderDrawer,
    handleOpenCreate,
    handleOpenEdit,
    handleSaveProvider,
    setFormIcon,
    setIsPullingModels,
  } = useProviderManagement({
    message,
    t,
    providerIcons,
    writeProviderIcon,
    shiftCachedProviderIcons,
    settleProviderRow,
  });

  // A drill-down link names the provider it wants opened. The effect resolves it
  // against the loaded list rather than reopening on every render, so a closed
  // drawer stays closed while the same link is still in the address bar.
  const [searchParams] = useSearchParams();
  const targetProviderParam = searchParams.get('provider');
  const handledTargetRef = useRef<string | null>(null);

  React.useEffect(() => {
    if (!targetProviderParam || providersLoading || providers.length === 0) return;
    if (handledTargetRef.current === targetProviderParam) return;
    handledTargetRef.current = targetProviderParam;
    const norm = targetProviderParam.toLowerCase().trim();
    const matched = providers.find(
      (p) =>
        p.id.toLowerCase() === norm ||
        p.name?.toLowerCase() === norm ||
        p.upstream_name?.toLowerCase() === norm ||
        p.family?.toLowerCase() === norm
    );
    if (matched) {
      handleOpenEdit(matched);
    }
  }, [targetProviderParam, providersLoading, providers]);

  // Family labels and the picker's options both come from the family registry, so a
  // family the console manages cannot appear in one and not the other.
  const familyDisplayNames: Record<string, string> = Object.fromEntries(
    PROVIDER_FAMILIES.map((family) => [family.id, t(family.labelKey)]),
  );

  return (
    <div className="terminal-page providers-page">
      <div className="terminal-page-head">
        <div>
          <h1 className="terminal-title">{t('pro.title')}</h1>
          <p className="terminal-subtitle">{t('pro.subtitle')}</p>
        </div>

        <Button
          size="small"
          icon={<SyncOutlined spin={providersFetching} />}
          onClick={() => void refetchProviders()}
        >
          {t('common.refresh')}
        </Button>
      </div>

      <div>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <Button type="primary" icon={<PlusOutlined />} onClick={handleOpenCreate}>
            {t('pro.add_provider')}
          </Button>
        </div>

        {providersError && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            description={`${t('common.save_failed', { msg: providersErr instanceof Error ? providersErr.message : String(providersErr) })}`}
          />
        )}

        <ProviderTable
          providers={providers}
          providersLoading={providersLoading}
          providerIcons={providerIcons}
          pluginLogos={pluginLogos}
          statusQueue={statusQueue}
          deleteProviderMutation={deleteProviderMutation}
          handleOpenEdit={handleOpenEdit}
          setIconPickerOpen={setIconPickerOpen}
          setTargetProviderForIcon={setTargetProviderForIcon}
        />
      </div>

      {/* Provider Rich Drawer */}
      <ProviderEditorDrawer
        familyDisplayNames={familyDisplayNames}
        createProviderMutation={createProviderMutation}
        updateProviderMutation={updateProviderMutation}
        providerDrawerOpen={providerDrawerOpen}
        editingProvider={editingProvider}
        formFamily={formFamily}
        setFormFamily={setFormFamily}
        formName={formName}
        setFormName={setFormName}
        formBaseURL={formBaseURL}
        setFormBaseURL={setFormBaseURL}
        formWebsite={formWebsite}
        setFormWebsite={setFormWebsite}
        formPrefix={formPrefix}
        setFormPrefix={setFormPrefix}
        formPriority={formPriority}
        setFormPriority={setFormPriority}
        formDisabled={formDisabled}
        setFormDisabled={setFormDisabled}
        formDisableCooling={formDisableCooling}
        setFormDisableCooling={setFormDisableCooling}
        formKeys={formKeys}
        setFormKeys={setFormKeys}
        formHeaders={formHeaders}
        setFormHeaders={setFormHeaders}
        formModels={formModels}
        setFormModels={setFormModels}
        formTestModel={formTestModel}
        setFormTestModel={setFormTestModel}
        formIcon={formIcon}
        iconManuallySelected={iconManuallySelected}
        setIconManuallySelected={setIconManuallySelected}
        setIconPickerOpen={setIconPickerOpen}
        setTargetProviderForIcon={setTargetProviderForIcon}
        setFormIcon={setFormIcon}
        setIsPullingModels={setIsPullingModels}
        keysSectionOpen={keysSectionOpen}
        setKeysSectionOpen={setKeysSectionOpen}
        headersSectionOpen={headersSectionOpen}
        setHeadersSectionOpen={setHeadersSectionOpen}
        modelsSectionOpen={modelsSectionOpen}
        setModelsSectionOpen={setModelsSectionOpen}
        expandedKeyIds={expandedKeyIds}
        setExpandedKeyIds={setExpandedKeyIds}
        expandedModelIds={expandedModelIds}
        setExpandedModelIds={setExpandedModelIds}
        endpointModels={endpointModels}
        setEndpointModels={setEndpointModels}
        isPullingModels={isPullingModels}
        modelFetchSeqRef={modelFetchSeqRef}
        websiteInputState={websiteInputState}
        handlePullModels={handlePullModels}
        toggleModelExpanded={toggleModelExpanded}
        handleAddModel={handleAddModel}
        updateModelImage={updateModelImage}
        toggleThinkingLevel={toggleThinkingLevel}
        toggleKeyExpanded={toggleKeyExpanded}
        handleKeyAdd={handleKeyAdd}
        handleTestKey={handleTestKey}
        handleTestAllKeys={handleTestAllKeys}
        handleCloseProviderDrawer={handleCloseProviderDrawer}
        handleSaveProvider={handleSaveProvider}
      />

      {/* LobeHub Icon Picker Modal */}
      <IconPickerModal
        open={iconPickerOpen}
        currentIcon={
          targetProviderForIcon
            ? resolveProviderIcon(
                providerIcons,
                targetProviderForIcon,
                getProviderDefaultIcon(
                  targetProviderForIcon.family,
                  targetProviderForIcon.name,
                  targetProviderForIcon.base_url,
                ),
              )
            : formIcon
        }
        onSelect={handleSelectIcon}
        onClose={() => {
          setIconPickerOpen(false);
          setTargetProviderForIcon(null);
        }}
      />
    </div>
  );
};
