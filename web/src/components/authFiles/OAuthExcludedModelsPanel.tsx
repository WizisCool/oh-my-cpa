import React, { useMemo, useState } from 'react';
import { Button, Checkbox, Input } from 'antd';
import { CloseOutlined, PlusOutlined } from '../icons';
import { useT, type TFunc } from '../../i18n';
import type { ManagementOAuthProviderModel } from '../../types/managementOAuthModelAlias';
import { LoadFailure, Notice } from '../feedback';
import {
  describeExcludedModels,
  filterCatalogModels,
  normalizeExcludedModelRules,
  OAUTH_EXCLUDED_MODEL_RULE_LIMIT,
  setExcludedModelRule,
  validateExcludedModelRule,
  type ExcludedCatalogModel,
  type ExcludedModelRuleError,
  type ExcludedRuleSummary,
} from './oauthExcludedModelLogic';
import styles from './OAuthModelRulesDrawer.module.css';
import { SearchInput } from '../common/SearchInput';
import { SectionHeading } from '../common/SectionHeading';
import { Toolbar } from '../common/Toolbar';
import { Meter } from '../common/Meter';

export type OAuthModelCatalogState = 'loading' | 'ready' | 'unavailable' | 'error';

interface OAuthExcludedModelsPanelProps {
  rules: string[];
  onChange: (rules: string[]) => void;
  catalog: ManagementOAuthProviderModel[];
  catalogState: OAuthModelCatalogState;
  catalogError?: unknown;
  onRetryCatalog: () => void;
  isDisabled: boolean;
}

function ruleErrorMessage(error: ExcludedModelRuleError, t: TFunc): string {
  switch (error) {
    case 'empty':
      return t('af.excluded_error_empty');
    case 'whitespace':
      return t('af.excluded_error_whitespace');
    case 'too_long':
      return t('af.excluded_error_too_long');
    case 'duplicate':
      return t('af.excluded_error_duplicate');
    case 'too_many':
      return t('af.excluded_error_too_many');
  }
}

function typedRuleMeta(entry: ExcludedRuleSummary, hasCatalog: boolean, t: TFunc): string | undefined {
  if (!hasCatalog) return undefined;
  if (!entry.isWildcard) return t('af.excluded_rule_not_listed');
  return entry.matchCount > 0
    ? t('af.excluded_rule_matches', { n: entry.matchCount })
    : t('af.excluded_rule_matches_none');
}

function catalogModelMeta(model: ExcludedCatalogModel, t: TFunc): string | undefined {
  if (!model.patternRule) return undefined;
  return model.isExactlyExcluded
    ? t('af.excluded_model_also_by_rule', { rule: model.patternRule })
    : t('af.excluded_model_by_rule', { rule: model.patternRule });
}

export const OAuthExcludedModelsPanel: React.FC<OAuthExcludedModelsPanelProps> = ({
  rules,
  onChange,
  catalog,
  catalogState,
  catalogError,
  onRetryCatalog,
  isDisabled,
}) => {
  const t = useT();
  const [ruleInput, setRuleInput] = useState('');
  const [ruleError, setRuleError] = useState<ExcludedModelRuleError>();
  const [query, setQuery] = useState('');

  const view = useMemo(() => describeExcludedModels(rules, catalog), [rules, catalog]);
  const visibleModels = useMemo(() => filterCatalogModels(view.models, query), [view.models, query]);
  const hasCatalog = catalogState === 'ready' && view.totalCount > 0;
  const selectableVisible = visibleModels.filter((model) => !model.isExcluded);
  const exactVisible = visibleModels.filter((model) => model.isExactlyExcluded);

  const addTypedRule = () => {
    const error = validateExcludedModelRule(ruleInput, rules);
    if (error) {
      setRuleError(error);
      return;
    }
    onChange(setExcludedModelRule(rules, ruleInput, true));
    setRuleInput('');
    setRuleError(undefined);
  };

  const excludeVisible = () => {
    const next = normalizeExcludedModelRules([...rules, ...selectableVisible.map((model) => model.id)]);
    if (next.length > OAUTH_EXCLUDED_MODEL_RULE_LIMIT) {
      setRuleError('too_many');
      return;
    }
    setRuleError(undefined);
    onChange(next);
  };

  const clearVisible = () => {
    const cleared = new Set(exactVisible.map((model) => model.id.toLowerCase()));
    onChange(rules.filter((rule) => !cleared.has(rule)));
  };


  return (
    <div className={styles['pane']} data-testid="oauth-excluded-models-panel">
      <div className={styles['summary']}>
        <span className={styles['summary-count']} data-testid="oauth-excluded-models-summary">
          {hasCatalog
            ? t('af.excluded_summary_models', { excluded: view.excludedCount, total: view.totalCount })
            : t('af.excluded_summary_rules', { n: rules.length })}
        </span>
        {hasCatalog && (
          <Meter
            value={view.excludedCount}
            max={view.totalCount}
            label={t('af.excluded_summary_models', { excluded: view.excludedCount, total: view.totalCount })}
          />
        )}
      </div>

      {view.isEverythingExcluded && (
        <Notice tone="warning" title={t('af.excluded_all_title')} description={t('af.excluded_all_desc')} />
      )}

      <section className={styles['section']} aria-labelledby="oauth-excluded-rules-heading">
        <SectionHeading level="label" id="oauth-excluded-rules-heading" title={t('af.excluded_rules_title')} />
        <div className={styles['rule-entry']}>
          <Input
            className={styles['rule-input']}
            data-testid="oauth-excluded-models-rule-input"
            value={ruleInput}
            status={ruleError ? 'error' : undefined}
            placeholder={t('af.excluded_rule_placeholder')}
            aria-label={t('af.excluded_rules_title')}
            aria-describedby="oauth-excluded-rules-hint"
            disabled={isDisabled}
            onChange={(event) => {
              setRuleInput(event.target.value);
              setRuleError(undefined);
            }}
            onPressEnter={addTypedRule}
          />
          <Button
            icon={<PlusOutlined />}
            data-testid="oauth-excluded-models-rule-add"
            disabled={isDisabled || !ruleInput.trim()}
            onClick={addTypedRule}
          >
            {t('af.excluded_rule_add')}
          </Button>
        </div>
        <p id="oauth-excluded-rules-hint" className={ruleError ? styles['field-error'] : styles['hint']} role={ruleError ? 'alert' : undefined}>
          {ruleError ? ruleErrorMessage(ruleError, t) : t('af.excluded_rule_hint')}
        </p>
        {view.typedRules.length > 0 && (
          <ul className={styles['rows']} data-testid="oauth-excluded-models-typed-rules">
            {view.typedRules.map((entry) => {
              const meta = typedRuleMeta(entry, hasCatalog, t);
              return (
                <li key={entry.rule} className={styles['row']} data-rule={entry.rule}>
                  <span className={styles['row-copy']}>
                    <span className={styles['row-id']}>{entry.rule}</span>
                    {meta && <span className={styles['row-meta']}>{meta}</span>}
                  </span>
                  <Button
                    type="text"
                    className={styles['row-action']}
                    icon={<CloseOutlined />}
                    aria-label={t('af.excluded_rule_remove', { rule: entry.rule })}
                    disabled={isDisabled}
                    onClick={() => onChange(setExcludedModelRule(rules, entry.rule, false))}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className={styles['section']} aria-labelledby="oauth-excluded-catalog-heading">
        <SectionHeading level="label" id="oauth-excluded-catalog-heading" title={t('af.excluded_catalog_title')} />
        {catalogState === 'loading' && <p className={styles['hint']}>{t('af.rules_catalog_loading')}</p>}
        {catalogState === 'error' && (
          <LoadFailure title={t('af.rules_catalog_failed')} error={catalogError} onRetry={onRetryCatalog} />
        )}
        {(catalogState === 'unavailable' || (catalogState === 'ready' && view.totalCount === 0)) && (
          <Notice tone="info" title={t('af.excluded_catalog_unavailable')} />
        )}
        {hasCatalog && (
          <>
            <Toolbar>
              <SearchInput
                className={styles['catalog-search']}
                value={query}
                label={t('af.excluded_catalog_search')}
                onChange={setQuery}
              />
              <Button disabled={isDisabled || selectableVisible.length === 0} onClick={excludeVisible}>
                {query.trim() ? t('af.excluded_catalog_exclude_shown') : t('af.excluded_catalog_exclude_all')}
              </Button>
              <Button disabled={isDisabled || exactVisible.length === 0} onClick={clearVisible}>
                {t('af.excluded_catalog_clear')}
              </Button>
            </Toolbar>
            {visibleModels.length === 0 ? (
              <p className={styles['hint']}>{t('af.excluded_catalog_no_match', { query: query.trim() })}</p>
            ) : (
              <ul className={`${styles['rows']} ${styles['catalog']}`} data-testid="oauth-excluded-models-catalog">
                {visibleModels.map((model) => {
                  const meta = catalogModelMeta(model, t);
                  // A row only a pattern covers cannot be cleared here: its rule is
                  // above, and unchecking would change nothing the gateway does.
                  const isHeldByPattern = Boolean(model.patternRule) && !model.isExactlyExcluded;
                  return (
                    <li key={model.id} className={styles['row']} data-model={model.id}>
                      <Checkbox
                        className={styles['row-check']}
                        checked={model.isExcluded}
                        disabled={isDisabled || isHeldByPattern}
                        onChange={(event) => {
                          if (event.target.checked && rules.length >= OAUTH_EXCLUDED_MODEL_RULE_LIMIT) {
                            setRuleError('too_many');
                            return;
                          }
                          setRuleError(undefined);
                          onChange(setExcludedModelRule(rules, model.id, event.target.checked));
                        }}
                      >
                        <span className={styles['row-copy']}>
                          <span className={styles['row-id']}>{model.id}</span>
                          {(model.displayName || meta) && (
                            <span className={styles['row-meta']}>
                              {[model.displayName, meta].filter(Boolean).join(' · ')}
                            </span>
                          )}
                        </span>
                      </Checkbox>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </section>
    </div>
  );
};
