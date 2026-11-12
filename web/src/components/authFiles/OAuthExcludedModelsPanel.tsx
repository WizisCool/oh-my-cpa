import React, { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapse } from '@/components/ui/accordion';
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
  type ExcludedActiveRule,
  type ExcludedCatalogModel,
  type ExcludedModelRuleError,
} from './oauthExcludedModelLogic';
import styles from './OAuthModelRulesDrawer.module.css';
import { SearchInput } from '../common/SearchInput';
import { FilterItem, FilterTransition } from '../../motion/filter';
import { Toolbar } from '../common/Toolbar';
import { ReorderHandle, RowReorder, useReorderRow } from '../common/RowReorder';
import { moveKey, type DropSide } from '../../types/displayOrder';

export type OAuthModelCatalogState = 'loading' | 'ready' | 'unavailable' | 'error';

interface OAuthExcludedModelsPanelProps {
  rules: string[];
  onChange: (rules: string[]) => void;
  catalog: ManagementOAuthProviderModel[];
  catalogState: OAuthModelCatalogState;
  catalogError?: unknown;
  onRetryCatalog: () => void;
  isDisabled: boolean;
  /**
   * Whose list this is: a provider's defaults, inherited by credentials without a list of their
   * own, or one credential's own list, which replaces those defaults.
   */
  scope?: 'provider' | 'credential';
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

function activeRuleMeta(entry: ExcludedActiveRule, hasCatalog: boolean, t: TFunc): string | undefined {
  if (entry.isWildcard) {
    if (!hasCatalog) return undefined;
    return entry.matchCount > 0
      ? t('af.excluded_rule_matches', { n: entry.matchCount })
      : t('af.excluded_rule_matches_none');
  }
  if (hasCatalog && !entry.inCatalog) return t('af.excluded_rule_not_listed');
  return entry.displayName;
}

const ExcludedRuleRow: React.FC<{
  entry: ExcludedActiveRule;
  meta?: string;
  isDisabled: boolean;
  onRemove: (rule: string) => void;
}> = ({ entry, meta, isDisabled, onRemove }) => {
  const t = useT();
  const { row, handle } = useReorderRow(entry.rule);
  return (
    <li {...row} className={styles['row']} data-rule={entry.rule}>
      <div className={styles['row-main']}>
        <ReorderHandle {...handle} name={entry.rule} variant="inline" />
        <span className={styles['row-copy']}>
          <span className={styles['row-id']}>{entry.rule}</span>
          {meta && <span className={styles['row-meta']}>{meta}</span>}
        </span>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className={styles['row-action']}
        icon={<CloseOutlined />}
        aria-label={t('af.excluded_rule_remove', { rule: entry.rule })}
        disabled={isDisabled}
        onClick={() => onRemove(entry.rule)}
      />
    </li>
  );
};

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
  scope = 'provider',
}) => {
  const summaryKey = scope === 'credential' ? 'af.excluded_summary_models_credential' : 'af.excluded_summary_models';
  const t = useT();
  const hintId = useId();
  const [ruleInput, setRuleInput] = useState('');
  const [ruleError, setRuleError] = useState<ExcludedModelRuleError>();
  const [query, setQuery] = useState('');
  const [isCatalogOpen, setIsCatalogOpen] = useState(false);

  const view = useMemo(() => describeExcludedModels(rules, catalog), [rules, catalog]);
  const visibleModels = useMemo(() => filterCatalogModels(view.models, query), [view.models, query]);
  const hasCatalog = catalogState === 'ready' && view.totalCount > 0;
  const selectableVisible = visibleModels.filter((model) => !model.isExcluded);
  const exactVisible = visibleModels.filter((model) => model.isExactlyExcluded);
  const orderedRules = useMemo(() => view.activeRules.map((entry) => entry.rule), [view.activeRules]);

  const handleMoveRule = (key: string, target: string, side: DropSide) => {
    const next = moveKey(orderedRules, key, target, side);
    if (next !== orderedRules) onChange([...next]);
  };

  const handleStepRule = (key: string, direction: -1 | 1) => {
    const index = orderedRules.indexOf(key);
    const neighbour = orderedRules[index + direction];
    if (index >= 0 && neighbour !== undefined) {
      handleMoveRule(key, neighbour, direction < 0 ? 'before' : 'after');
    }
  };

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
    <div className={styles['excluded-box']} data-testid="oauth-excluded-models-panel">
      <div className={styles['excluded-header']}>
        <span className={styles['summary-count']} data-testid="oauth-excluded-models-summary">
          {hasCatalog
            ? t(summaryKey, { excluded: view.excludedCount, total: view.totalCount })
            : t('af.excluded_summary_rules', { n: view.activeRules.length })}
        </span>
      </div>

      {view.isEverythingExcluded && (scope === 'credential'
        ? <Notice tone="warning" title={t('af.excluded_all_title_credential')} />
        : <Notice tone="warning" title={t('af.excluded_all_title')} description={t('af.excluded_all_desc')} />)}

      <div className={styles['section']}>
        <div className={styles['rule-entry']}>
          <Input
            className={styles['rule-input']}
            data-testid="oauth-excluded-models-rule-input"
            value={ruleInput}
            status={ruleError ? 'error' : undefined}
            placeholder={t('af.excluded_rule_placeholder')}
            aria-label={t('af.excluded_rules_title')}
            aria-describedby={hintId}
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
        <p id={hintId} className={ruleError ? styles['field-error'] : styles['hint']} role={ruleError ? 'alert' : undefined}>
          {ruleError ? ruleErrorMessage(ruleError, t) : t('af.excluded_rule_hint')}
        </p>
        {view.activeRules.length > 0 && (
          <RowReorder
            items={orderedRules}
            isEnabled={!isDisabled && orderedRules.length > 1}
            onMove={handleMoveRule}
            onStep={handleStepRule}
          >
            <ul className={styles['rows']} data-testid="oauth-excluded-models-typed-rules">
              {view.activeRules.map((entry) => (
                <ExcludedRuleRow
                  key={entry.rule}
                  entry={entry}
                  meta={activeRuleMeta(entry, hasCatalog, t)}
                  isDisabled={isDisabled}
                  onRemove={(rule) => onChange(setExcludedModelRule(rules, rule, false))}
                />
              ))}
            </ul>
          </RowReorder>
        )}
      </div>

      {/* The catalogue folds: a provider can list hundreds of models, and the summary above already
          says how many are excluded. It starts folded and opens on the reader's click. */}
      <Collapse
        ghost
        className={styles['catalog-fold']}
        activeKey={isCatalogOpen ? ['catalog'] : []}
        onChange={(keys) => setIsCatalogOpen(keys.includes('catalog'))}
        items={[{
          key: 'catalog',
          label: (
            <span className={styles['catalog-fold-label']} data-testid="oauth-excluded-models-catalog-toggle">
              {t('af.excluded_catalog_title')}
              {hasCatalog && <span className={styles['catalog-fold-count']}>{view.totalCount}</span>}
            </span>
          ),
          children: (
            <div className={styles['section']}>
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
                <FilterTransition itemKeys={visibleModels.map((model) => model.id)}>
                  {visibleModels.map((model) => {
                    const meta = catalogModelMeta(model, t);
                    // A row only a pattern covers cannot be cleared here: its rule is
                    // above, and unchecking would change nothing the gateway does.
                    const isHeldByPattern = Boolean(model.patternRule) && !model.isExactlyExcluded;
                    return (
                      <FilterItem as="li" key={model.id} className={styles['row']} data-model={model.id}>
                        <Checkbox
                          className={styles['row-check']}
                          checked={model.isExcluded}
                          disabled={isDisabled || isHeldByPattern}
                          onCheckedChange={(checked) => {
                            if (checked && rules.length >= OAUTH_EXCLUDED_MODEL_RULE_LIMIT) {
                              setRuleError('too_many');
                              return;
                            }
                            setRuleError(undefined);
                            onChange(setExcludedModelRule(rules, model.id, checked));
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
                      </FilterItem>
                    );
                  })}
                </FilterTransition>
              </ul>
            )}
          </>
        )}
            </div>
          ),
        }]}
      />
    </div>
  );
};
