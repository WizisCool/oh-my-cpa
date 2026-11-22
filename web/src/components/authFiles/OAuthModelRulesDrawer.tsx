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
  useOptimisticOAuthRequestScopedErrorsMutation,
} from '../../hooks/useConfigMutations';
import { api, ApiError } from '../../api/client';
import { QUERY_KEYS } from '../../api/queryKeys';
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
import {
  oauthErrorRuleDraftsEqual,
  oauthErrorRuleProblem,
  validateOAuthErrorRuleDrafts,
} from './oauthRequestScopedErrorsLogic';
import { readErrorRuleDrafts, type ErrorRuleDraft } from '../policy/errorRules';
import { ErrorRulesEditor } from '../policy/ErrorRulesEditor';
import { OAuthExcludedModelsPanel, type OAuthModelCatalogState } from './OAuthExcludedModelsPanel';
import { OAuthModelAliasPanel } from './OAuthModelAliasPanel';
import styles from './OAuthModelRulesDrawer.module.css';
import { LoadFailure, Notice, useConfirmModal, useToast } from '../feedback';
import { EmptyState } from '../common/EmptyState';
import { ListLoading } from '../common/PageLoading';
import { SearchSelect } from '../common/SearchSelect';
import { Tooltip } from '../common/Tooltip';
import { AppDrawer } from '../common/AppDrawer';

export type OAuthModelRulesSection = 'aliases' | 'excluded' | 'errors';

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
  const [errorRuleDrafts, setErrorRuleDrafts] = useState<ErrorRuleDraft[]>([]);
  const [errorRuleBaseline, setErrorRuleBaseline] = useState<ErrorRuleDraft[]>([]);
  const [showErrorRuleProblems, setShowErrorRuleProblems] = useState(false);

  const aliasesQuery = useQuery({
    queryKey: QUERY_KEYS.oauthModelAliases,
    queryFn: () => api.getManagementOAuthModelAliases(),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  const excludedQuery = useQuery({
    queryKey: QUERY_KEYS.oauthExcludedModels,
    queryFn: () => api.getManagementOAuthExcludedModels(),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  const errorRulesQuery = useQuery({
    queryKey: QUERY_KEYS.oauthRequestScopedErrors,
    queryFn: () => api.getManagementOAuthRequestScopedErrors(),
    enabled: open,
    staleTime: 30_000,
    retry: false,
  });
  const savedAliases = aliasesQuery.data?.aliases;
  const savedRules = excludedQuery.data?.excluded_models;
  const savedErrorRules = errorRulesQuery.data?.request_scoped_errors;

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
    [
      ...Object.keys(savedAliases ?? {}),
      ...Object.keys(savedRules ?? {}),
      ...Object.keys(savedErrorRules ?? {}),
      ...providerOptions,
    ].forEach((value) => {
      const normalized = normalizeOAuthModelAliasProvider(value);
      if (normalized && isValidOAuthModelAliasProvider(normalized)) values.add(normalized);
    });
    return Array.from(values).sort();
  }, [providerOptions, savedAliases, savedErrorRules, savedRules]);

  const isAliasDirty = !oauthModelAliasDraftsEqual(aliasDrafts, aliasBaseline);
  const isRuleDirty = !excludedModelRulesEqual(ruleDrafts, ruleBaseline);
  const isErrorRulesDirty = !oauthErrorRuleDraftsEqual(errorRuleDrafts, errorRuleBaseline);
  const isDirty = isAliasDirty || isRuleDirty || isErrorRulesDirty;

  const loadProvider = useCallback((providerValue: string) => {
    const normalized = normalizeOAuthModelAliasProvider(providerValue);
    const aliases = createOAuthModelAliasDrafts(savedAliases?.[normalized] ?? []);
    const rules = normalizeExcludedModelRules(savedRules?.[normalized] ?? []);
    const errorRules = readErrorRuleDrafts(savedErrorRules?.[normalized]);
    setSelectedProvider(normalized);
    setProviderSearch('');
    setAliasDrafts(aliases);
    setAliasBaseline(aliases);
    setRuleDrafts(rules);
    setRuleBaseline(rules);
    setErrorRuleDrafts(errorRules);
    setErrorRuleBaseline(errorRules);
    setShowErrorRuleProblems(false);
  }, [savedAliases, savedErrorRules, savedRules]);

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

  useEffect(() => {
    if (!open || !provider || isErrorRulesDirty || !savedErrorRules) return;
    const next = readErrorRuleDrafts(savedErrorRules[provider]);
    setErrorRuleDrafts(next);
    setErrorRuleBaseline(next);
    setShowErrorRuleProblems(false);
  }, [open, provider, isErrorRulesDirty, savedErrorRules]);

  const isSettled = !aliasesQuery.isLoading && !excludedQuery.isLoading && !errorRulesQuery.isLoading;
  useEffect(() => {
    if (!open || !isSettled || selectedProvider) return;
    // Open on the provider asked for, else one that already carries rules, so the drawer
    // shows the configuration that exists rather than an empty editor for the first name.
    const requested = normalizeOAuthModelAliasProvider(initialProvider ?? '');
    const first = (requested && isValidOAuthModelAliasProvider(requested) ? requested : undefined)
      ?? knownProviders.find(
        (value) => savedAliases?.[value]?.length || savedRules?.[value]?.length || savedErrorRules?.[value]?.length,
      )
      ?? knownProviders[0]
      ?? '';
    if (first) loadProvider(first);
  }, [initialProvider, isSettled, knownProviders, loadProvider, open, savedAliases, savedErrorRules, savedRules, selectedProvider]);

  useEffect(() => {
    if (!open) {
      setSection('excluded');
      setSelectedProvider('');
      setProviderSearch('');
      setAliasDrafts([]);
      setAliasBaseline([]);
      setRuleDrafts([]);
      setRuleBaseline([]);
      setErrorRuleDrafts([]);
      setErrorRuleBaseline([]);
      setShowErrorRuleProblems(false);
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
  const errorRulesMutation = useOptimisticOAuthRequestScopedErrorsMutation({
    formatError: (error) => safeError(error, t),
    onSuccess: (_provider, rules) => {
      const next = readErrorRuleDrafts(rules);
      setErrorRuleDrafts(next);
      setErrorRuleBaseline(next);
      setShowErrorRuleProblems(false);
      onSaved();
    },
  });
  const isSaving = aliasMutation.isPending || ruleMutation.isPending || errorRulesMutation.isPending;

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

  const saveErrorRules = async () => {
    setShowErrorRuleProblems(true);
    const validation = validateOAuthErrorRuleDrafts(provider, errorRuleDrafts);
    if (!validation.ok) {
      if (validation.error === 'provider') {
        toast.error(t('af.alias_error_provider'));
      } else if (validation.error === 'too_many') {
        toast.error(t('af.error_rules_error_too_many'));
      } else {
        toast.error(t('af.error_rules_error_invalid', { n: validation.position + 1 }));
      }
      return;
    }
    try {
      await errorRulesMutation.mutateAsync({ provider: validation.provider, rules: validation.rules });
      toast.success(t('af.error_rules_saved'));
    } catch {
      // Error toast & cache rollback handled by useOptimisticOAuthRequestScopedErrorsMutation.
    }
  };

  const hasSavedAliases = Boolean(provider && savedAliases?.[provider]?.length);
  const hasSavedRules = Boolean(provider && savedRules?.[provider]?.length);
  const hasSavedErrorRules = Boolean(provider && savedErrorRules?.[provider]?.length);

  const confirmClear = () => {
    const titleKey = section === 'aliases'
      ? 'af.alias_delete_confirm_title'
      : section === 'errors'
        ? 'af.error_rules_delete_confirm_title'
        : 'af.excluded_delete_confirm_title';
    const descKey = section === 'aliases'
      ? 'af.alias_delete_confirm_desc'
      : section === 'errors'
        ? 'af.error_rules_delete_confirm_desc'
        : 'af.excluded_delete_confirm_desc';
    modal.confirm({
      title: t(titleKey),
      content: t(descKey, { provider }),
      okText: t('common.confirm'),
      cancelText: t('common.cancel'),
      okButtonProps: { danger: true },
      onOk: async () => {
        if (section === 'aliases') {
          await aliasMutation.mutateAsync({ provider, aliases: [] });
          toast.success(t('af.alias_delete_success', { provider }));
        } else if (section === 'errors') {
          await errorRulesMutation.mutateAsync({ provider, rules: [] });
          toast.success(t('af.error_rules_delete_success', { provider }));
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
              errors: savedErrorRules?.[value]?.length ?? 0,
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
  }, [knownProviders, pluginLogos, pluginTitles, savedAliases, savedErrorRules, savedRules, t, typedProvider]);

  const sectionQuery = section === 'aliases'
    ? aliasesQuery
    : section === 'errors'
      ? errorRulesQuery
      : excludedQuery;
  const isSectionDirty = section === 'aliases'
    ? isAliasDirty
    : section === 'errors'
      ? isErrorRulesDirty
      : isRuleDirty;
  const hasSavedSection = section === 'aliases'
    ? hasSavedAliases
    : section === 'errors'
      ? hasSavedErrorRules
      : hasSavedRules;
  const isSectionReady = Boolean(provider) && sectionQuery.isSuccess;

  const sectionLabel = (value: OAuthModelRulesSection, count: number, isSectionChanged: boolean) => {
    const labelKey = value === 'aliases'
      ? 'af.rules_tab_aliases'
      : value === 'errors'
        ? 'af.rules_tab_errors'
        : 'af.rules_tab_excluded';
    return (
      <span className={styles['section-tab']} data-testid={`oauth-model-rules-tab-${value}`}>
        {t(labelKey, { n: count })}
        {isSectionChanged && <span className={styles['dirty-pip']} role="img" aria-label={t('af.rules_tab_unsaved')} />}
      </span>
    );
  };

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
    if (section === 'errors') {
      return (
        <div className={styles['excluded-box']} data-testid="oauth-error-rules-panel">
          <div className={styles['excluded-header']}>
            <span className={styles['summary-count']} data-testid="oauth-error-rules-summary">
              {t('af.error_rules_summary', { n: errorRuleDrafts.length })}
            </span>
          </div>
          <ErrorRulesEditor
            key={provider}
            rules={errorRuleDrafts}
            onChange={setErrorRuleDrafts}
            showProblems={showErrorRuleProblems}
            isDisabled={isSaving}
            validateRule={oauthErrorRuleProblem}
            isPatternEmpty={(value) => value.trim() === ''}
          />
        </div>
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

  const clearButtonKey = section === 'aliases'
    ? 'af.alias_delete_provider'
    : section === 'errors'
      ? 'af.error_rules_delete_provider'
      : 'af.excluded_delete_provider';
  const saveButtonKey = section === 'aliases'
    ? 'af.alias_save'
    : section === 'errors'
      ? 'af.error_rules_save'
      : 'af.excluded_save';

  const handleRevertSection = () => {
    if (section === 'aliases') {
      setAliasDrafts(aliasBaseline);
    } else if (section === 'errors') {
      setErrorRuleDrafts(errorRuleBaseline);
      setShowErrorRuleProblems(false);
    } else {
      setRuleDrafts(ruleBaseline);
    }
  };

  const handleSaveSection = () => {
    if (section === 'aliases') {
      void saveAliases();
    } else if (section === 'errors') {
      void saveErrorRules();
    } else {
      void saveRules();
    }
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
      {t(clearButtonKey)}
    </Button>
  );
  const footer = (
    <>
      <Button
        data-testid="oauth-model-rules-revert"
        disabled={!isSectionDirty || isSaving}
        onClick={handleRevertSection}
      >
        {t('af.rules_revert')}
      </Button>
      <Button
        variant="primary"
        icon={<SaveOutlined />}
        data-testid="oauth-model-rules-save"
        loading={isSaving}
        disabled={!isSectionReady || !isSectionDirty}
        onClick={handleSaveSection}
      >
        {t(saveButtonKey)}
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
              {/* Explains the locked picker where it is locked, instead of a notice that would push
                  the editor down the moment the first change is made. */}
              <Tooltip title={isDirty ? t('af.rules_dirty_hint') : undefined}>
                <div
                  data-testid="oauth-model-rules-provider"
                  data-provider={provider}
                  className={styles['scope-control']}
                  // The locked picker takes no focus, so the wrapper does: a keyboard reaches the reason.
                  tabIndex={isDirty ? 0 : undefined}
                >
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
              </Tooltip>
            </div>
            <Segmented
              block
              className={styles['sections']}
              value={section}
              onChange={(value) => setSection(value as OAuthModelRulesSection)}
              options={[
                // Disabling models is what operators come here for most, so it leads.
                { value: 'excluded', label: sectionLabel('excluded', ruleDrafts.length, isRuleDirty) },
                { value: 'aliases', label: sectionLabel('aliases', aliasDrafts.length, isAliasDirty) },
                { value: 'errors', label: sectionLabel('errors', errorRuleDrafts.length, isErrorRulesDirty) },
              ]}
            />
            {renderSection()}
          </>
        )}
      </div>
    </AppDrawer>
  );
};
