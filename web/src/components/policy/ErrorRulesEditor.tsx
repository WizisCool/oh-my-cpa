import { Button, Input, Select } from 'antd';

import { useT } from '../../i18n';
import { PROVIDER_ERROR_RULE_ACTIONS } from '../../types/providers';
import { ArrowDownOutlined, ArrowUpOutlined, CloseOutlined, DeleteOutlined, PlusOutlined } from '../icons';
import {
  createErrorRuleDraft,
  errorRuleProblem,
  moveErrorRule,
  type ErrorMatchDraft,
  type ErrorRuleDraft,
  type ErrorRuleProblem,
} from './errorRules';
import styles from './ErrorRulesEditor.module.css';

const ACTION_LABEL_KEYS: Record<string, string> = {
  stop: 'policy.rule_action_stop',
  'stop-and-cooldown': 'policy.rule_action_stop_cooldown',
  continue: 'policy.rule_action_continue',
  'continue-and-cooldown': 'policy.rule_action_continue_cooldown',
};

const PROBLEM_KEYS: Record<ErrorRuleProblem, string> = {
  status: 'policy.rule_problem_status',
  action: 'policy.rule_problem_action',
  no_match: 'policy.rule_problem_no_match',
  empty_match: 'policy.rule_problem_empty_match',
};

interface ErrorRulesEditorProps {
  rules: ErrorRuleDraft[];
  onChange: (rules: ErrorRuleDraft[]) => void;
  /** Problems are shown only after a save was attempted, so a rule being typed is not marked wrong. */
  showProblems: boolean;
}

// Drafts need ids that survive reordering; a counter is enough because they never leave the form.
let nextDraftSerial = 0;
const nextDraftId = (prefix: string) => `${prefix}-new-${++nextDraftSerial}`;

/**
 * The editor for CPA's request-scoped error rules: what the gateway does with the request that
 * hit a given upstream error. CPA takes the first rule that matches, so order is part of the
 * rule and each entry carries its position and its own move controls.
 */
export function ErrorRulesEditor({ rules, onChange, showProblems }: ErrorRulesEditorProps) {
  const t = useT();

  const updateRule = (id: string, patch: Partial<ErrorRuleDraft>) =>
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));

  const updateMatch = (rule: ErrorRuleDraft, matchId: string, patch: Partial<ErrorMatchDraft>) =>
    updateRule(rule.id, {
      matches: rule.matches.map((match) => (match.id === matchId ? { ...match, ...patch } : match)),
    });

  const actionOptions = (current: string) => {
    const options = PROVIDER_ERROR_RULE_ACTIONS.map((action) => ({
      value: action as string,
      label: t(ACTION_LABEL_KEYS[action]),
    }));
    // A stored action this console does not know stays selectable, so opening the form does not rewrite it.
    if (current && !options.some((option) => option.value === current)) {
      options.push({ value: current, label: current });
    }
    return options;
  };

  const kindOptions = [
    { value: 'text', label: t('policy.rule_match_text') },
    { value: 'regex', label: t('policy.rule_match_regex') },
  ];

  return (
    <div data-testid="error-rules-editor">
      <p className={styles['rule-note']}>{t('policy.rules_note')}</p>
      {rules.length > 0 && (
        <div className={styles['rule-list']}>
          {rules.map((rule, position) => {
            const problem = showProblems ? errorRuleProblem(rule) : null;
            const ruleLabel = t('policy.rule_label', { n: position + 1 });
            return (
              <div
                key={rule.id}
                className={`${styles['rule']}${problem ? ` ${styles['rule-invalid']}` : ''}`}
                data-error-rule={position}
              >
                <div className={styles['rule-head']}>
                  <span className={styles['rule-order']} aria-hidden="true">{position + 1}</span>
                  <Input
                    className={styles['rule-status']}
                    value={rule.status}
                    inputMode="numeric"
                    maxLength={3}
                    status={problem === 'status' ? 'error' : undefined}
                    placeholder={t('policy.rule_status_placeholder')}
                    aria-label={`${ruleLabel}: ${t('policy.rule_status')}`}
                    onChange={(event) => updateRule(rule.id, { status: event.target.value.replace(/\D/g, '') })}
                  />
                  <Select
                    className={styles['rule-action']}
                    value={rule.action}
                    status={problem === 'action' ? 'error' : undefined}
                    options={actionOptions(rule.action)}
                    aria-label={`${ruleLabel}: ${t('policy.rule_action')}`}
                    onChange={(action) => updateRule(rule.id, { action })}
                  />
                  <div className={styles['rule-tools']}>
                    <Button
                      size="small"
                      type="text"
                      icon={<ArrowUpOutlined />}
                      disabled={position === 0}
                      aria-label={`${ruleLabel}: ${t('policy.rule_move_up')}`}
                      onClick={() => onChange(moveErrorRule(rules, rule.id, -1))}
                    />
                    <Button
                      size="small"
                      type="text"
                      icon={<ArrowDownOutlined />}
                      disabled={position === rules.length - 1}
                      aria-label={`${ruleLabel}: ${t('policy.rule_move_down')}`}
                      onClick={() => onChange(moveErrorRule(rules, rule.id, 1))}
                    />
                    <Button
                      size="small"
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={`${ruleLabel}: ${t('common.delete')}`}
                      onClick={() => onChange(rules.filter((item) => item.id !== rule.id))}
                    />
                  </div>
                </div>
                <div className={styles['rule-body']}>
                  {rule.matches.map((match) => (
                    <div key={match.id} className={styles['match-row']}>
                      <Select
                        className={styles['match-kind']}
                        value={match.kind}
                        options={kindOptions}
                        aria-label={`${ruleLabel}: ${t('policy.rule_match_kind')}`}
                        onChange={(kind) => updateMatch(rule, match.id, { kind })}
                      />
                      <Input
                        className={styles['match-value']}
                        value={match.value}
                        status={problem === 'empty_match' && match.value === '' ? 'error' : undefined}
                        placeholder={t(match.kind === 'regex' ? 'policy.rule_regex_placeholder' : 'policy.rule_text_placeholder')}
                        aria-label={`${ruleLabel}: ${t('policy.rule_match_value')}`}
                        onChange={(event) => updateMatch(rule, match.id, { value: event.target.value })}
                      />
                      <Button
                        size="small"
                        type="text"
                        icon={<CloseOutlined />}
                        aria-label={`${ruleLabel}: ${t('policy.rule_remove_match')}`}
                        onClick={() =>
                          updateRule(rule.id, { matches: rule.matches.filter((item) => item.id !== match.id) })
                        }
                      />
                    </div>
                  ))}
                  <div>
                    <Button
                      size="small"
                      icon={<PlusOutlined />}
                      onClick={() =>
                        updateRule(rule.id, {
                          matches: [...rule.matches, { id: nextDraftId(rule.id), kind: 'text', value: '' }],
                        })
                      }
                    >
                      {t('policy.rule_add_match')}
                    </Button>
                  </div>
                  {problem && (
                    <p className={styles['rule-problem']} role="alert">{t(PROBLEM_KEYS[problem])}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Button
        type="dashed"
        icon={<PlusOutlined />}
        onClick={() => onChange([...rules, createErrorRuleDraft(nextDraftId('rule'))])}
      >
        {t('policy.rule_add')}
      </Button>
    </div>
  );
}
