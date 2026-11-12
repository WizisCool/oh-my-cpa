import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { DeleteOutlined, SaveOutlined } from '../icons';
import { CredentialMark } from '../LobeIcon';
import { providerDisplayName } from '../../types/providerMetadata';
import { type PluginOAuthLogos } from '../../types/pluginOAuthProviders';
import { useQuery } from '@tanstack/react-query';
import {
  useOptimisticOAuthAliasesMutation,
  useOptimisticOAuthExcludedModelsMutation,
} from '../../hooks/useConfigMutations';
import { api, ApiError } from '../../api/client';
import { useT, type TFunc } from '../../i18n';
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
import { LoadFailure, Notice, useConfirmModal, useToast } from '../feedback';
import { EmptyState } from '../common/EmptyState';
import { ListLoading } from '../common/PageLoading';
import { SearchSelect } from '../common/SearchSelect';
import { AppDrawer } from '../common/AppDrawer';

export type OAuthModelRulesSection = 'aliases' | 'excluded';

interface OAuthModelRulesDrawerProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  providerOptions: string[];
  pluginLogos?: PluginOAuthLogos;
  pluginTitles?: ReadonlyMap<string, string>;
  /** The provider to open on, when the drawer is reached from a scoped view or one credential. */
  initialProvider?: string;
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

const ProviderIdentity: React.FC<{
  provider: string;
  pluginLogos?: PluginOAuthLogos;
  pluginTitles?: ReadonlyMap<string, string>;
}> = ({ provider, pluginLogos, pluginTitles }) => (
  <span className={styles['provider-identity']} data-testid="oauth-model-rules-provider-identity" data-provider={provider}>
    <CredentialMark credential={{ provider }} pluginLogos={pluginLogos} size={18} />
    <span className={styles['provider-option-name']}>{providerDisplayName(provider, pluginTitles)}</span>
  </span>
);

export const OAuthModelRulesDrawer: React.FC<OAuthModelRulesDrawerProps> = ({
  open,
  onClose,
  onSaved,
  providerOptions,
  pluginLogos,
  pluginTitles,
  initialProvider,
}) => {
  const t = useT();
  const modal = useConfirmModal();
  const toast = useToast();
  const [section, setSection] = useState<OAuthModelRulesSection>('excluded');
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
    // Open on the provider asked for, else one that already carries rules, so the drawer
    // shows the configuration that exists rather than an empty editor for the first name.
    const requested = normalizeOAuthModelAliasProvider(initialProvider ?? '');
    const first = (requested && isValidOAuthModelAliasProvider(requested) ? requested : undefined)
      ?? knownProviders.find((value) => savedAliases?.[value]?.length || savedRules?.[value]?.length)
      ?? knownProviders[0]
      ?? '';
    if (first) loadProvider(first);
  }, [initialProvider, isSettled, knownProviders, loadProvider, open, savedAliases, savedRules, selectedProvider]);

  useEffect(() => {
    if (!open) {
      setSection('excluded');
      setSelectedProvider('');
      setProviderSearch('');
      setAliasDrafts([]);
      setAliasBaseline([]);
      setRuleDrafts([]);
      setRuleBaseline([]);
    }
  }, [open]);

  const aliasMutation = useOptimisticOAuthAliasesMutation({
    formatError: (error) => safeError(error, t),
    onSuccess: (_provider, aliases) => {
      const next = createOAuthModelAliasDrafts(aliases);
      setAliasDrafts(next);
      setAliasBaseline(next);
      onSaved();
    },
  });
  const ruleMutation = useOptimisticOAuthExcludedModelsMutation({
    formatError: (error) => safeError(error, t),
    onSuccess: (_provider, models) => {
      setRuleDrafts(models);
      setRuleBaseline(models);
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
      await aliasMutation.mutateAsync({ provider: validation.provider, aliases: validation.aliases });
      toast.success(t('af.alias_saved'));
    } catch {
      // Error toast & cache rollback handled by useOptimisticOAuthAliasesMutation.
    }
  };

  const saveRules = async () => {
    if (!provider || !isValidOAuthModelAliasProvider(provider)) {
      toast.error(t('af.alias_error_provider'));
      return;
    }
    try {
      await ruleMutation.mutateAsync({ provider, models: normalizeExcludedModelRules(ruleDrafts) });
      toast.success(t('af.excluded_saved'));
    } catch {
      // Error toast & cache rollback handled by useOptimisticOAuthExcludedModelsMutation.
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
        if (isAliases) {
          await aliasMutation.mutateAsync({ provider, aliases: [] });
          toast.success(t('af.alias_delete_success', { provider }));
        } else {
          await ruleMutation.mutateAsync({ provider, models: [] });
          toast.success(t('af.excluded_delete_success', { provider }));
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

  const typedProvider = normalizeOAuthModelAliasProvider(providerSearch);
  const providerSelectOptions = useMemo(() => {
    const options = knownProviders.map((value) => ({
      value,
      searchText: `${value} ${providerDisplayName(value, pluginTitles)}`.toLowerCase(),
      label: (
        <span className={styles['provider-option']}>
          <ProviderIdentity provider={value} pluginLogos={pluginLogos} pluginTitles={pluginTitles} />
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
        searchText: `${typedProvider} ${providerDisplayName(typedProvider, pluginTitles)}`.toLowerCase(),
        label: (
          <span className={styles['provider-option']}>
            <ProviderIdentity provider={typedProvider} pluginLogos={pluginLogos} pluginTitles={pluginTitles} />
            <span className={styles['provider-option-meta']}>{t('af.rules_provider_use', { provider: typedProvider })}</span>
          </span>
        ),
      });
    }
    return options;
  }, [knownProviders, pluginLogos, pluginTitles, savedAliases, savedRules, t, typedProvider]);

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
      return <EmptyState size="compact" title={t('af.rules_no_provider')} />;
    }
    if (section === 'aliases') {
      return (
        <OAuthModelAliasPanel
          isVertex={provider === 'vertex'}
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

  const footerStart = (
    <Button
      danger
      variant="ghost"
      icon={<DeleteOutlined />}
      data-testid="oauth-model-rules-clear"
      disabled={!isSectionReady || !hasSavedSection || isSectionDirty || isSaving}
      onClick={confirmClear}
    >
      {t(section === 'aliases' ? 'af.alias_delete_provider' : 'af.excluded_delete_provider')}
    </Button>
  );
  const footer = (
    <>
      <Button
        data-testid="oauth-model-rules-revert"
        disabled={!isSectionDirty || isSaving}
        onClick={() => (section === 'aliases' ? setAliasDrafts(aliasBaseline) : setRuleDrafts(ruleBaseline))}
      >
        {t('af.rules_revert')}
      </Button>
      <Button
        variant="primary"
        icon={<SaveOutlined />}
        data-testid="oauth-model-rules-save"
        loading={isSaving}
        disabled={!isSectionReady || !isSectionDirty}
        onClick={() => void (section === 'aliases' ? saveAliases() : saveRules())}
      >
        {t(section === 'aliases' ? 'af.alias_save' : 'af.excluded_save')}
      </Button>
    </>
  );

  return (
    <AppDrawer
      widthKey="oauth_model_rules"
      data-testid="oauth-model-rules-drawer"
      title={t('af.rules_title')}
      width="wide"
      open={open}
      onClose={handleAttemptClose}
      footer={footer}
      footerStart={footerStart}
    >
      <div className={styles['drawer-content']}>
        {!isSettled ? (
          <ListLoading />
        ) : (
          <>
            <p className={styles['intro']}>{t('af.rules_intro')}</p>
            <div className={styles['scope']}>
              <label className={styles['scope-label']} htmlFor="oauth-model-rules-provider">{t('af.rules_provider_label')}</label>
              <div data-testid="oauth-model-rules-provider" data-provider={provider} className={styles['scope-control']}>
                <SearchSelect
                  label={t('af.rules_provider_label')}
                  id="oauth-model-rules-provider"
                  className={styles['provider-select']}
                  value={provider || undefined}
                  placeholder={t('af.rules_provider_placeholder')}
                  options={providerSelectOptions}
                  // Counts belong to the options and tabs; the selected identity matches the page's provider tabs.
                  labelRender={(option) => <ProviderIdentity provider={String(option.value ?? '')} pluginLogos={pluginLogos} pluginTitles={pluginTitles} />}
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
                // Disabling models is what operators come here for most, so it leads.
                { value: 'excluded', label: sectionLabel('excluded', ruleDrafts.length, isRuleDirty) },
                { value: 'aliases', label: sectionLabel('aliases', aliasDrafts.length, isAliasDirty) },
              ]}
            />
            {renderSection()}
          </>
        )}
      </div>
    </AppDrawer>
  );
};
