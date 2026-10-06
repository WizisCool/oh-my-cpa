import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntdApp, Button, Drawer, Empty, Segmented, Select } from 'antd';
import { DeleteOutlined, SaveOutlined } from '../icons';
import { ProviderBrandIcon } from '../LobeIcon';
import { credentialProviderIconId, getCredentialProviderMetadata } from '../common/providerMetadata';
import { pluginOAuthLogoFor, type PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useT, type TFunc } from '../../i18n';
import { isDemoMode } from '../../types/demoMode';
import type {
  ManagementOAuthExcludedModelsResponse,
  ManagementOAuthModelAlias,
  ManagementOAuthModelAliasesResponse,
} from '../../types/managementOAuthModelAlias';
import {
  createOAuthModelAliasDrafts,
  isValidOAuthModelAliasProvider,
  normalizeOAuthModelAliasProvider,
  oauthModelAliasDraftsEqual,
  validateOAuthModelAliasDrafts,
  type ManagementOAuthModelAliasDraft,
  type OAuthModelAliasValidationError,
} from './oauthModelAliasLogic';
import { excludedModelRulesEqual, normalizeExcludedModelRules } from './oauthExcludedModelLogic';
import { OAuthExcludedModelsPanel, type OAuthModelCatalogState } from './OAuthExcludedModelsPanel';
import { OAuthModelAliasPanel } from './OAuthModelAliasPanel';
import styles from './OAuthModelRulesDrawer.module.css';
import { useOverlayHistory } from '../../hooks/useOverlayHistory';
import { LoadFailure, Notice, useToast } from '../feedback';

export type OAuthModelRulesSection = 'aliases' | 'excluded';

interface OAuthModelRulesDrawerProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  providerOptions: string[];
  pluginLogos?: PluginOAuthLogos;
}

const ALIASES_QUERY_KEY = ['management-oauth-model-aliases'] as const;
const EXCLUDED_QUERY_KEY = ['management-oauth-excluded-models'] as const;
const CATALOG_STALE_MS = 5 * 60_000;

function validationMessage(error: OAuthModelAliasValidationError, t: TFunc, alias?: string): string {
  switch (error) {
    case 'provider':
      return t('af.alias_error_provider');
    case 'too_many':
      return t('af.alias_error_too_many');
    case 'name_alias_required':
      return t('af.alias_error_name_alias_required');
    case 'field_too_long':
      return t('af.alias_error_field_too_long');
    case 'alias_same':
      return t('af.alias_error_alias_same');
    case 'alias_duplicate':
      return t('af.alias_error_alias_duplicate', { alias: alias ?? '' });
  }
}

const isUnsupported = (error: unknown): boolean => error instanceof ApiError && error.status === 501;

function safeError(error: unknown, t: TFunc): string {
  if (isUnsupported(error)) return t('af.rules_unsupported');
  return error instanceof Error ? error.message : t('af.request_failed');
}

const ProviderIdentity: React.FC<{ provider: string; logo?: string }> = ({ provider, logo }) => (
  <span className={styles['provider-identity']} data-testid="oauth-model-rules-provider-identity" data-provider={provider}>
    <ProviderBrandIcon iconId={credentialProviderIconId(provider)} logo={logo} size={18} />
    <span className={styles['provider-option-name']}>{getCredentialProviderMetadata(provider).label}</span>
  </span>
);

export const OAuthModelRulesDrawer: React.FC<OAuthModelRulesDrawerProps> = ({
  open,
  onClose,
  onSaved,
  providerOptions,
  pluginLogos,
}) => {
  const t = useT();
  const isDemo = isDemoMode();
  const { modal } = AntdApp.useApp();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [section, setSection] = useState<OAuthModelRulesSection>('aliases');
  const [selectedProvider, setSelectedProvider] = useState('');
  const [providerSearch, setProviderSearch] = useState('');
  const [aliasDrafts, setAliasDrafts] = useState<ManagementOAuthModelAliasDraft[]>([]);
  const [aliasBaseline, setAliasBaseline] = useState<ManagementOAuthModelAliasDraft[]>([]);
  const [ruleDrafts, setRuleDrafts] = useState<string[]>([]);
  const [ruleBaseline, setRuleBaseline] = useState<string[]>([]);

  const aliasesQuery = useQuery({
    queryKey: ALIASES_QUERY_KEY,
    queryFn: () => api.getManagementOAuthModelAliases(),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  const excludedQuery = useQuery({
    queryKey: EXCLUDED_QUERY_KEY,
    queryFn: () => api.getManagementOAuthExcludedModels(),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  const savedAliases = aliasesQuery.data?.aliases;
  const savedRules = excludedQuery.data?.excluded_models;

  const provider = normalizeOAuthModelAliasProvider(selectedProvider);
  const catalogQuery = useQuery({
    queryKey: ['management-oauth-provider-models', provider],
    queryFn: () => api.getManagementOAuthProviderModels(provider),
    enabled: open && Boolean(provider),
    staleTime: CATALOG_STALE_MS,
    retry: false,
  });
  const catalog = catalogQuery.data?.models ?? [];
  let catalogState: OAuthModelCatalogState = 'ready';
  if (catalogQuery.isLoading) catalogState = 'loading';
  else if (catalogQuery.isError) catalogState = 'error';
  else if (!catalogQuery.data?.available) catalogState = 'unavailable';

  const knownProviders = useMemo(() => {
    const values = new Set<string>();
    [...Object.keys(savedAliases ?? {}), ...Object.keys(savedRules ?? {}), ...providerOptions].forEach((value) => {
      const normalized = normalizeOAuthModelAliasProvider(value);
      if (normalized && isValidOAuthModelAliasProvider(normalized)) values.add(normalized);
    });
    return Array.from(values).sort();
  }, [providerOptions, savedAliases, savedRules]);

  const isAliasDirty = !oauthModelAliasDraftsEqual(aliasDrafts, aliasBaseline);
  const isRuleDirty = !excludedModelRulesEqual(ruleDrafts, ruleBaseline);
  const isDirty = isAliasDirty || isRuleDirty;

  const loadProvider = useCallback((providerValue: string) => {
    const normalized = normalizeOAuthModelAliasProvider(providerValue);
    const aliases = createOAuthModelAliasDrafts(savedAliases?.[normalized] ?? []);
    const rules = normalizeExcludedModelRules(savedRules?.[normalized] ?? []);
    setSelectedProvider(normalized);
    setProviderSearch('');
    setAliasDrafts(aliases);
    setAliasBaseline(aliases);
    setRuleDrafts(rules);
    setRuleBaseline(rules);
  }, [savedAliases, savedRules]);

  useEffect(() => {
    if (!open || !provider || isAliasDirty || !savedAliases) return;
    const next = createOAuthModelAliasDrafts(savedAliases[provider] ?? []);
    setAliasDrafts(next);
    setAliasBaseline(next);
  }, [open, provider, isAliasDirty, savedAliases]);

  useEffect(() => {
    if (!open || !provider || isRuleDirty || !savedRules) return;
    const next = normalizeExcludedModelRules(savedRules[provider] ?? []);
    setRuleDrafts(next);
    setRuleBaseline(next);
  }, [open, provider, isRuleDirty, savedRules]);

  const isSettled = !aliasesQuery.isLoading && !excludedQuery.isLoading;
  useEffect(() => {
    if (!open || !isSettled || selectedProvider) return;
    // Open on a provider that already carries rules, so the drawer shows the
    // configuration that exists rather than an empty editor for the first name.
    const first = knownProviders.find((value) => savedAliases?.[value]?.length || savedRules?.[value]?.length)
      ?? knownProviders[0]
      ?? '';
    if (first) loadProvider(first);
  }, [isSettled, knownProviders, loadProvider, open, savedAliases, savedRules, selectedProvider]);

  useEffect(() => {
    if (!open) {
      setSection('aliases');
      setSelectedProvider('');
      setProviderSearch('');
      setAliasDrafts([]);
      setAliasBaseline([]);
      setRuleDrafts([]);
      setRuleBaseline([]);
    }
  }, [open]);

  const aliasMutation = useMutation({
    mutationFn: ({ target, aliases }: { target: string; aliases: ManagementOAuthModelAlias[] }) =>
      api.patchManagementOAuthModelAliases(target, aliases),
    onSuccess: (response, variables) => {
      queryClient.setQueryData(ALIASES_QUERY_KEY, (current: ManagementOAuthModelAliasesResponse | undefined) => {
        const aliases = { ...(current?.aliases ?? {}) };
        if (response.aliases.length > 0) aliases[variables.target] = response.aliases;
        else delete aliases[variables.target];
        return { aliases };
      });
      const next = createOAuthModelAliasDrafts(response.aliases);
      setAliasDrafts(next);
      setAliasBaseline(next);
      onSaved();
    },
  });
  const ruleMutation = useMutation({
    mutationFn: ({ target, models }: { target: string; models: string[] }) =>
      api.patchManagementOAuthExcludedModels(target, models),
    onSuccess: (response, variables) => {
      queryClient.setQueryData(EXCLUDED_QUERY_KEY, (current: ManagementOAuthExcludedModelsResponse | undefined) => {
        const excluded = { ...(current?.excluded_models ?? {}) };
        if (response.models.length > 0) excluded[variables.target] = response.models;
        else delete excluded[variables.target];
        return { excluded_models: excluded };
      });
      setRuleDrafts(response.models);
      setRuleBaseline(response.models);
      onSaved();
    },
  });
  const isSaving = aliasMutation.isPending || ruleMutation.isPending;

  const saveAliases = async () => {
    const validation = validateOAuthModelAliasDrafts(provider, aliasDrafts);
    if (!validation.ok) {
      toast.error(validationMessage(validation.error, t, validation.alias));
      return;
    }
    try {
      await aliasMutation.mutateAsync({ target: validation.provider, aliases: validation.aliases });
      toast.success(t('af.alias_saved'));
    } catch (error) {
      toast.error(safeError(error, t));
    }
  };

  const saveRules = async () => {
    if (!provider || !isValidOAuthModelAliasProvider(provider)) {
      toast.error(t('af.alias_error_provider'));
      return;
    }
    try {
      await ruleMutation.mutateAsync({ target: provider, models: normalizeExcludedModelRules(ruleDrafts) });
      toast.success(t('af.excluded_saved'));
    } catch (error) {
      toast.error(safeError(error, t));
    }
  };

  const hasSavedAliases = Boolean(provider && savedAliases?.[provider]?.length);
  const hasSavedRules = Boolean(provider && savedRules?.[provider]?.length);

  const confirmClear = () => {
    const isAliases = section === 'aliases';
    modal.confirm({
      title: t(isAliases ? 'af.alias_delete_confirm_title' : 'af.excluded_delete_confirm_title'),
      content: t(isAliases ? 'af.alias_delete_confirm_desc' : 'af.excluded_delete_confirm_desc', { provider }),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          if (isAliases) {
            await aliasMutation.mutateAsync({ target: provider, aliases: [] });
            toast.success(t('af.alias_delete_success', { provider }));
          } else {
            await ruleMutation.mutateAsync({ target: provider, models: [] });
            toast.success(t('af.excluded_delete_success', { provider }));
          }
        } catch (error) {
          toast.error(safeError(error, t));
          throw error;
        }
      },
    });
  };

  const handleAttemptClose = () => {
    if (isSaving) return;
    if (!isDirty) {
      onClose();
      return;
    }
    modal.confirm({
      title: t('af.rules_unsaved_title'),
      content: t('af.rules_unsaved_desc'),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: onClose,
    });
  };

  // Native Back must honor unsaved drafts and re-arm the overlay when close is declined.
  useOverlayHistory({ isOpen: open, onClose: handleAttemptClose });

  const typedProvider = normalizeOAuthModelAliasProvider(providerSearch);
  const providerSelectOptions = useMemo(() => {
    const options = knownProviders.map((value) => ({
      value,
      searchText: `${value} ${getCredentialProviderMetadata(value).label}`.toLowerCase(),
      label: (
        <span className={styles['provider-option']}>
          <ProviderIdentity provider={value} logo={pluginOAuthLogoFor(pluginLogos, value)} />
          <span className={styles['provider-option-meta']}>
            {t('af.rules_provider_counts', {
              aliases: savedAliases?.[value]?.length ?? 0,
              excluded: savedRules?.[value]?.length ?? 0,
            })}
          </span>
        </span>
      ),
    }));
    // A provider key CPA accepts but no credential or rule names yet, such as a
    // plugin channel, is reachable by typing it.
    if (typedProvider && isValidOAuthModelAliasProvider(typedProvider) && !knownProviders.includes(typedProvider)) {
      options.push({
        value: typedProvider,
        searchText: `${typedProvider} ${getCredentialProviderMetadata(typedProvider).label}`.toLowerCase(),
        label: (
          <span className={styles['provider-option']}>
            <ProviderIdentity provider={typedProvider} logo={pluginOAuthLogoFor(pluginLogos, typedProvider)} />
            <span className={styles['provider-option-meta']}>{t('af.rules_provider_use', { provider: typedProvider })}</span>
          </span>
        ),
      });
    }
    return options;
  }, [knownProviders, pluginLogos, savedAliases, savedRules, t, typedProvider]);

  const sectionQuery = section === 'aliases' ? aliasesQuery : excludedQuery;
  const isSectionDirty = section === 'aliases' ? isAliasDirty : isRuleDirty;
  const hasSavedSection = section === 'aliases' ? hasSavedAliases : hasSavedRules;
  const isSectionReady = Boolean(provider) && sectionQuery.isSuccess;

  const sectionLabel = (value: OAuthModelRulesSection, count: number, isSectionChanged: boolean) => (
    <span className={styles['section-tab']} data-testid={`oauth-model-rules-tab-${value}`}>
      {t(value === 'aliases' ? 'af.rules_tab_aliases' : 'af.rules_tab_excluded', { n: count })}
      {isSectionChanged && <span className={styles['dirty-pip']} role="img" aria-label={t('af.rules_tab_unsaved')} />}
    </span>
  );

  const renderSection = () => {
    if (sectionQuery.isError) {
      return isUnsupported(sectionQuery.error) ? (
        <Notice tone="info" title={t('af.rules_unsupported')} />
      ) : (
        <LoadFailure
          title={t('common.load_failed_title')}
          detail={safeError(sectionQuery.error, t)}
          onRetry={() => void sectionQuery.refetch()}
        />
      );
    }
    if (!provider) {
      return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('af.rules_no_provider')} />;
    }
    if (section === 'aliases') {
      return (
        <OAuthModelAliasPanel
          drafts={aliasDrafts}
          onChange={setAliasDrafts}
          catalog={catalog}
          catalogState={catalogState}
          excludedRules={ruleBaseline}
          isDisabled={isSaving}
        />
      );
    }
    return (
      <OAuthExcludedModelsPanel
        // The typed-rule field and the catalog search belong to one provider.
        key={provider}
        rules={ruleDrafts}
        onChange={setRuleDrafts}
        catalog={catalog}
        catalogState={catalogState}
        catalogError={catalogQuery.error}
        onRetryCatalog={() => void catalogQuery.refetch()}
        isDisabled={isSaving}
      />
    );
  };

  const footer = (
    <div className={styles['footer']}>
      <Button
        danger
        type="text"
        icon={<DeleteOutlined />}
        data-testid="oauth-model-rules-clear"
        disabled={!isSectionReady || !hasSavedSection || isSectionDirty || isSaving || isDemo}
        title={isDemo ? t('demo.blocked') : undefined}
        onClick={confirmClear}
      >
        {t(section === 'aliases' ? 'af.alias_delete_provider' : 'af.excluded_delete_provider')}
      </Button>
      <span className={styles['footer-actions']}>
        <Button
          data-testid="oauth-model-rules-revert"
          disabled={!isSectionDirty || isSaving}
          onClick={() => (section === 'aliases' ? setAliasDrafts(aliasBaseline) : setRuleDrafts(ruleBaseline))}
        >
          {t('af.rules_revert')}
        </Button>
        <Button
          type="primary"
          icon={<SaveOutlined />}
          data-testid="oauth-model-rules-save"
          loading={isSaving}
          disabled={!isSectionReady || !isSectionDirty || isDemo}
          title={isDemo ? t('demo.blocked') : undefined}
          onClick={() => void (section === 'aliases' ? saveAliases() : saveRules())}
        >
          {t(section === 'aliases' ? 'af.alias_save' : 'af.excluded_save')}
        </Button>
      </span>
    </div>
  );

  return (
    <Drawer
      data-testid="oauth-model-rules-drawer"
      title={t('af.rules_title')}
      closable={{ placement: 'end', 'aria-label': t('common.close') }}
      size="min(760px, 100vw)"
      open={open}
      onClose={handleAttemptClose}
      footer={footer}
    >
      <div className={styles['drawer-content']}>
        {!isSettled ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('common.loading')} />
        ) : (
          <>
            <p className={styles['intro']}>{t('af.rules_intro')}</p>
            <div className={styles['scope']}>
              <label className={styles['scope-label']} htmlFor="oauth-model-rules-provider">{t('af.rules_provider_label')}</label>
              <div data-testid="oauth-model-rules-provider" data-provider={provider} className={styles['scope-control']}>
                <Select
                  id="oauth-model-rules-provider"
                  className={styles['provider-select']}
                  value={provider || undefined}
                  placeholder={t('af.rules_provider_placeholder')}
                  options={providerSelectOptions}
                  // Counts belong to the options and tabs; the selected identity matches the page's provider tabs.
                  labelRender={(option) => <ProviderIdentity provider={String(option.value ?? '')} logo={pluginOAuthLogoFor(pluginLogos, String(option.value ?? ''))} />}
                  showSearch={{
                    searchValue: providerSearch,
                    onSearch: setProviderSearch,
                    filterOption: (input, option) => (option?.searchText ?? '').includes(input.trim().toLowerCase()) || String(option?.value ?? '').includes(normalizeOAuthModelAliasProvider(input)),
                  }}
                  onChange={(value) => loadProvider(String(value))}
                  disabled={isDirty || isSaving}
                />
              </div>
            </div>
            {isDirty && <Notice tone="info" description={t('af.rules_dirty_hint')} />}
            <Segmented
              block
              className={styles['sections']}
              value={section}
              onChange={(value) => setSection(value as OAuthModelRulesSection)}
              options={[
                { value: 'aliases', label: sectionLabel('aliases', aliasDrafts.length, isAliasDirty) },
                { value: 'excluded', label: sectionLabel('excluded', ruleDrafts.length, isRuleDirty) },
              ]}
            />
            {renderSection()}
          </>
        )}
      </div>
    </Drawer>
  );
};
