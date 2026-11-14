import React from 'react';
import { Button } from '@/components/ui/button';
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '../icons';
import { ReorderHandle, RowReorder, useReorderRow } from '../common/RowReorder';
import type { useT } from '../../i18n';
import type { ConfigFieldDefinition } from '../../types/configSchema';
import { applyKeyOrder, moveKey, type DropSide } from '../../types/displayOrder';
import { ComposingTextInput } from './ComposingTextInput';

export interface PatternRuleWire {
  pattern: string;
  replacement: string;
}

export interface PatternRuleRow {
  id: string;
  pattern: string;
  replacement: string;
}

export interface PatternRulesDraftState {
  rows: PatternRuleRow[];
  baseWire: PatternRuleWire[];
}

export type PatternRulesValidationIssue =
  | { kind: 'empty_pattern' }
  | { kind: 'unsupported_re2'; pattern: string }
  | { kind: 'trailing_backslash'; pattern: string };

let nextRowId = 1;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueRowId(usedIds: Set<string>, baseId: string): string {
  let candidate = baseId;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${baseId}_${suffix++}`;
  }
  usedIds.add(candidate);
  return candidate;
}

export function normalizeWirePatternRules(raw: unknown): PatternRuleWire[] {
  if (!Array.isArray(raw)) return [];
  const rules: PatternRuleWire[] = [];
  for (const item of raw) {
    if (!isPlainRecord(item)) continue;
    rules.push({
      pattern: item.pattern == null ? '' : String(item.pattern),
      replacement: item.replacement == null ? '' : String(item.replacement),
    });
  }
  return rules;
}

export function reconcileWirePatternRows(
  incoming: readonly PatternRuleWire[],
  previousRows: readonly PatternRuleRow[],
  allocateId: () => string,
): PatternRuleRow[] {
  const m = incoming.length;
  const n = previousRows.length;
  const usedPrevIndices = new Set<number>();
  const matchedIds: Array<string | undefined> = Array(m).fill(undefined);

  // Pass 1: LCS on exact (pattern, replacement) preserves order & duplicate identities across insertions/deletions.
  if (m > 0 && n > 0) {
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        if (
          incoming[i].pattern === previousRows[j].pattern
          && incoming[i].replacement === previousRows[j].replacement
        ) {
          dp[i][j] = 1 + dp[i + 1][j + 1];
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (
        incoming[i].pattern === previousRows[j].pattern
        && incoming[i].replacement === previousRows[j].replacement
      ) {
        matchedIds[i] = previousRows[j].id;
        usedPrevIndices.add(j);
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        i += 1;
      } else {
        j += 1;
      }
    }
  }

  // Pass 2: exact (pattern, replacement) match for reordered rules.
  for (let i = 0; i < m; i += 1) {
    if (matchedIds[i] !== undefined) continue;
    const matchIndex = previousRows.findIndex(
      (prev, prevIndex) =>
        !usedPrevIndices.has(prevIndex)
        && prev.pattern === incoming[i].pattern
        && prev.replacement === incoming[i].replacement,
    );
    if (matchIndex !== -1) {
      usedPrevIndices.add(matchIndex);
      matchedIds[i] = previousRows[matchIndex].id;
    }
  }

  // Pass 3: match by pattern alone when replacement updated concurrently.
  for (let i = 0; i < m; i += 1) {
    if (matchedIds[i] !== undefined) continue;
    const matchIndex = previousRows.findIndex(
      (prev, prevIndex) => !usedPrevIndices.has(prevIndex) && prev.pattern === incoming[i].pattern,
    );
    if (matchIndex !== -1) {
      usedPrevIndices.add(matchIndex);
      matchedIds[i] = previousRows[matchIndex].id;
    }
  }

  return incoming.map((rule, i) => ({
    id: matchedIds[i] ?? allocateId(),
    pattern: rule.pattern,
    replacement: rule.replacement,
  }));
}

export function patternRulesRowsToWire(rows: readonly Pick<PatternRuleRow, 'pattern' | 'replacement'>[]): PatternRuleWire[] {
  const wire: PatternRuleWire[] = [];
  for (const row of rows) {
    if (row.pattern.trim() === '') continue;
    wire.push({ pattern: row.pattern, replacement: row.replacement });
  }
  return wire;
}

/**
 * Checks constructs that Go RE2 always rejects without false-positively refusing
 * valid RE2 syntax (`(?i)`, `(?P<name>...)`, `\Q...\E`, escaped `\\1` or `\(?=`).
 */
export function findRe2PatternProblem(pattern: string): 'unsupported_re2' | 'trailing_backslash' | null {
  let inCharClass = false;
  let inLiteralQuote = false;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (inLiteralQuote) {
      if (ch === '\\' && pattern[i + 1] === 'E') {
        inLiteralQuote = false;
        i += 1;
      }
      continue;
    }
    if (ch === '\\') {
      if (i + 1 >= pattern.length) {
        return 'trailing_backslash';
      }
      const next = pattern[i + 1];
      if (!inCharClass && next === 'Q') {
        inLiteralQuote = true;
        i += 1;
        continue;
      }
      if (!inCharClass && next >= '1' && next <= '9') {
        const afterDigit = pattern[i + 2] ?? '';
        const isOctalEscape = next <= '7' && afterDigit >= '0' && afterDigit <= '7';
        if (isOctalEscape) {
          // Go RE2 accepts 2- or 3-digit octal escapes (\10..\777) and consumes up to 3 octal digits.
          const third = pattern[i + 3] ?? '';
          const consumedDigits = third >= '0' && third <= '7' ? 3 : 2;
          i += consumedDigits;
          continue;
        }
        return 'unsupported_re2';
      }
      i += 1;
      continue;
    }
    if (inCharClass) {
      if (ch === '[' && pattern[i + 1] === ':') {
        const closePosix = pattern.indexOf(':]', i + 2);
        if (closePosix !== -1) {
          i = closePosix + 1;
          continue;
        }
      }
      if (ch === ']') {
        inCharClass = false;
      }
      continue;
    }
    if (ch === '[') {
      inCharClass = true;
      if (pattern[i + 1] === '^') i += 1;
      if (pattern[i + 1] === ']') i += 1;
      continue;
    }
    if (
      ch === '('
      && (pattern.startsWith('(?=', i)
        || pattern.startsWith('(?!', i)
        || pattern.startsWith('(?<=', i)
        || pattern.startsWith('(?<!', i))
    ) {
      return 'unsupported_re2';
    }
  }
  return null;
}

export function validatePatternRuleRows(rows: readonly Pick<PatternRuleRow, 'pattern' | 'replacement'>[]): {
  issue: PatternRulesValidationIssue | null;
  rowErrors: boolean[];
} {
  let firstIssue: PatternRulesValidationIssue | null = null;
  const rowErrors = rows.map((row) => {
    if (row.pattern.trim() === '') {
      if (row.pattern !== '' || row.replacement !== '') {
        firstIssue ??= { kind: 'empty_pattern' };
        return true;
      }
      return false;
    }
    const re2Problem = findRe2PatternProblem(row.pattern);
    if (re2Problem !== null) {
      firstIssue ??= { kind: re2Problem, pattern: row.pattern };
      return true;
    }
    return false;
  });
  return { issue: firstIssue, rowErrors };
}

function areWireRuleListsEqual(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeWirePatternRules(left);
  const normalizedRight = normalizeWirePatternRules(right);
  if (normalizedLeft.length !== normalizedRight.length) return false;
  return normalizedLeft.every(
    (rule, index) =>
      rule.pattern === normalizedRight[index].pattern
      && rule.replacement === normalizedRight[index].replacement,
  );
}

/**
 * Rebases retained draft rows onto a refreshed sequence value while preserving
 * invalid rows, uncommitted blank rows, draft edits/reordering, and unique row IDs.
 */
export function rebasePatternRulesDraft(
  draft: PatternRulesDraftState,
  nextValue: unknown,
): PatternRulesDraftState {
  const nextWire = normalizeWirePatternRules(nextValue);
  if (areWireRuleListsEqual(nextWire, draft.baseWire)) {
    return draft;
  }

  const validRows = draft.rows.filter((row) => row.pattern.trim() !== '');
  const matchesBase =
    validRows.length === draft.baseWire.length
    && validRows.every(
      (row, index) =>
        row.pattern === draft.baseWire[index].pattern
        && row.replacement === draft.baseWire[index].replacement,
    );

  if (matchesBase) {
    const extraRows = draft.rows.filter((row) => row.pattern.trim() === '');
    const retainedFlags = nextWire.map((rule, index) => {
      const existing = validRows[index];
      return Boolean(existing && existing.pattern === rule.pattern && existing.replacement === rule.replacement);
    });
    const usedIds = new Set<string>(extraRows.map((row) => row.id));
    retainedFlags.forEach((isRetained, index) => {
      if (isRetained) usedIds.add(validRows[index].id);
    });
    const syncedRows: PatternRuleRow[] = nextWire.map((rule, index) => {
      if (retainedFlags[index]) {
        return validRows[index];
      }
      return {
        id: uniqueRowId(usedIds, `prule_sync_${index}`),
        pattern: rule.pattern,
        replacement: rule.replacement,
      };
    });
    if (validRows.length === 0) {
      return { rows: [...syncedRows, ...extraRows], baseWire: nextWire };
    }
    const mergedRows: PatternRuleRow[] = [];
    let validIndex = 0;
    for (const row of draft.rows) {
      if (row.pattern.trim() === '') {
        mergedRows.push(row);
      } else {
        const synced = syncedRows[validIndex];
        if (synced) mergedRows.push(synced);
        validIndex += 1;
        if (validIndex === validRows.length && syncedRows.length > validRows.length) {
          mergedRows.push(...syncedRows.slice(validRows.length));
        }
      }
    }
    return { rows: mergedRows, baseWire: nextWire };
  }

  return { rows: draft.rows, baseWire: nextWire };
}

export function formatPatternRulesIssue(
  issue: PatternRulesValidationIssue,
  t: ReturnType<typeof useT>,
): string {
  switch (issue.kind) {
    case 'empty_pattern':
      return t('cfg.pattern_rules_empty_pattern');
    case 'trailing_backslash':
      return t('cfg.pattern_rules_trailing_backslash', { pattern: issue.pattern });
    case 'unsupported_re2':
      return t('cfg.pattern_rules_unsupported_re2', { pattern: issue.pattern });
  }
}

interface PatternRuleRowViewProps {
  fieldId: string;
  rule: PatternRuleRow;
  index: number;
  count: number;
  hasError: boolean;
  disabled?: boolean;
  ariaDescribedBy?: string;
  patternPlaceholder: string;
  replacementPlaceholder: string;
  t: ReturnType<typeof useT>;
  onUpdate: (id: string, patch: Partial<Pick<PatternRuleRow, 'pattern' | 'replacement'>>) => void;
  onStep: (id: string, direction: -1 | 1) => void;
  onRemove: (id: string) => void;
}

const PatternRuleRowView: React.FC<PatternRuleRowViewProps> = ({
  fieldId,
  rule,
  index,
  count,
  hasError,
  disabled,
  ariaDescribedBy,
  patternPlaceholder,
  replacementPlaceholder,
  t,
  onUpdate,
  onStep,
  onRemove,
}) => {
  const { row, handle } = useReorderRow(rule.id);
  const handleLabel = rule.pattern.trim() || t('cfg.pattern_rules_rule_label', { n: index + 1 });

  return (
    <div
      {...row}
      className="pattern-rule-row"
      data-testid={`pattern-rule-row-${fieldId}-${index}`}
    >
      <ReorderHandle {...handle} name={handleLabel} variant="inline" />
      <ComposingTextInput
        id={index === 0 ? `cfg-${fieldId}` : undefined}
        aria-describedby={index === 0 ? ariaDescribedBy : undefined}
        aria-label={`${patternPlaceholder} ${index + 1}`}
        className="config-mono-input pattern-rule-pattern"
        value={rule.pattern}
        disabled={disabled}
        placeholder={patternPlaceholder}
        status={hasError ? 'error' : undefined}
        spellCheck={false}
        onCommit={(nextPattern) => onUpdate(rule.id, { pattern: nextPattern })}
        data-testid={`pattern-rule-pattern-${fieldId}-${index}`}
      />
      <span className="pattern-rules-arrow" aria-hidden="true">
        →
      </span>
      <ComposingTextInput
        aria-label={`${replacementPlaceholder} ${index + 1}`}
        className="config-mono-input pattern-rule-replacement"
        value={rule.replacement}
        disabled={disabled}
        placeholder={replacementPlaceholder}
        spellCheck={false}
        onCommit={(nextReplacement) => onUpdate(rule.id, { replacement: nextReplacement })}
        data-testid={`pattern-rule-replacement-${fieldId}-${index}`}
      />
      <div className="pattern-rule-actions">
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowUpOutlined />}
          disabled={disabled || index === 0}
          aria-label={t('cfg.pattern_rules_move_up', { n: index + 1 })}
          onClick={() => onStep(rule.id, -1)}
          data-testid={`pattern-rule-up-${fieldId}-${index}`}
        />
        <Button
          size="sm"
          variant="ghost"
          icon={<ArrowDownOutlined />}
          disabled={disabled || index === count - 1}
          aria-label={t('cfg.pattern_rules_move_down', { n: index + 1 })}
          onClick={() => onStep(rule.id, 1)}
          data-testid={`pattern-rule-down-${fieldId}-${index}`}
        />
        <Button
          size="sm"
          variant="ghost"
          danger
          icon={<DeleteOutlined />}
          disabled={disabled}
          aria-label={t('cfg.pattern_rules_remove', { n: index + 1 })}
          onClick={() => onRemove(rule.id)}
          data-testid={`pattern-rule-remove-${fieldId}-${index}`}
        />
      </div>
    </div>
  );
};

interface PatternRulesEditorProps {
  field: ConfigFieldDefinition;
  value: unknown;
  disabled?: boolean;
  ariaDescribedBy?: string;
  draftState?: PatternRulesDraftState;
  onDraftStateChange?: (fieldId: string, state: PatternRulesDraftState | null) => void;
  onValidationChange?: (fieldId: string, issue: PatternRulesValidationIssue | null) => void;
  t: ReturnType<typeof useT>;
  onChange: (field: ConfigFieldDefinition, value: PatternRuleWire[]) => void;
}

/**
 * Editable ordered list of Go RE2 pattern-replacement rules (`{ pattern, replacement }[]`).
 *
 * Rule order determines evaluation precedence for overlapping matches, and explicit
 * empty replacements (`""`) delete matched spans while clearing all rules removes the key.
 */
export const PatternRulesEditor: React.FC<PatternRulesEditorProps> = ({
  field,
  value,
  disabled,
  ariaDescribedBy,
  draftState,
  onDraftStateChange,
  onValidationChange,
  t,
  onChange,
}) => {
  const [localDraftState, setLocalDraftState] = React.useState<PatternRulesDraftState | null>(null);
  const activeDraftState = onDraftStateChange ? (draftState ?? null) : localDraftState;

  const normalizedValue = React.useMemo(() => normalizeWirePatternRules(value), [value]);
  const prevWireRowsRef = React.useRef<PatternRuleRow[]>([]);
  const wireRows = React.useMemo(() => {
    const reconciled = reconcileWirePatternRows(
      normalizedValue,
      prevWireRowsRef.current,
      () => `prule_wire_${nextRowId++}`,
    );
    prevWireRowsRef.current = reconciled;
    return reconciled;
  }, [normalizedValue]);

  const resolvedDraft = React.useMemo(
    () => (activeDraftState ? rebasePatternRulesDraft(activeDraftState, value) : null),
    [activeDraftState, value],
  );

  const rows = resolvedDraft ? resolvedDraft.rows : wireRows;

  const setDraft = React.useCallback(
    (next: PatternRulesDraftState | null) => {
      if (onDraftStateChange) {
        onDraftStateChange(field.id, next);
      } else {
        setLocalDraftState(next);
      }
    },
    [field.id, onDraftStateChange],
  );

  const commitRows = React.useCallback(
    (nextRows: PatternRuleRow[], currentBaseWire: PatternRuleWire[]) => {
      const { issue } = validatePatternRuleRows(nextRows);
      onValidationChange?.(field.id, issue);
      if (issue !== null) {
        setDraft({ rows: nextRows, baseWire: currentBaseWire });
        return;
      }
      const wire = patternRulesRowsToWire(nextRows);
      setDraft({ rows: nextRows, baseWire: wire });
      if (!areWireRuleListsEqual(wire, value)) {
        onChange(field, wire);
      }
    },
    [field, onChange, onValidationChange, setDraft, value],
  );

  const currentBaseWire = resolvedDraft ? resolvedDraft.baseWire : normalizedValue;

  const addRow = React.useCallback(() => {
    const usedIds = new Set(rows.map((row) => row.id));
    const newId = uniqueRowId(usedIds, `prule_${nextRowId++}`);
    setDraft({
      rows: [...rows, { id: newId, pattern: '', replacement: '' }],
      baseWire: currentBaseWire,
    });
  }, [currentBaseWire, rows, setDraft]);

  const updateRow = React.useCallback(
    (id: string, patch: Partial<Pick<PatternRuleRow, 'pattern' | 'replacement'>>) => {
      commitRows(
        rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
        currentBaseWire,
      );
    },
    [commitRows, currentBaseWire, rows],
  );

  const removeRow = React.useCallback(
    (id: string) => {
      commitRows(
        rows.filter((row) => row.id !== id),
        currentBaseWire,
      );
    },
    [commitRows, currentBaseWire, rows],
  );

  const rowIds = React.useMemo(() => rows.map((row) => row.id), [rows]);

  const moveRow = React.useCallback(
    (key: string, target: string, side: DropSide) => {
      if (disabled) return;
      const nextIds = moveKey(rowIds, key, target, side);
      if (nextIds !== rowIds) {
        commitRows(applyKeyOrder(rows, (row) => row.id, nextIds), currentBaseWire);
      }
    },
    [commitRows, currentBaseWire, disabled, rowIds, rows],
  );

  const stepRow = React.useCallback(
    (key: string, direction: -1 | 1) => {
      if (disabled) return;
      const index = rowIds.indexOf(key);
      const neighbour = rowIds[index + direction];
      if (index >= 0 && neighbour !== undefined) {
        moveRow(key, neighbour, direction < 0 ? 'before' : 'after');
      }
    },
    [disabled, moveRow, rowIds],
  );

  const { issue, rowErrors } = validatePatternRuleRows(rows);

  React.useEffect(() => {
    if (activeDraftState) {
      onValidationChange?.(field.id, issue);
    }
  }, [activeDraftState, field.id, issue, onValidationChange]);

  const patternPlaceholder = field.keyPlaceholderKey
    ? t(field.keyPlaceholderKey)
    : t('cfg.pattern_rules_pattern');
  const replacementPlaceholder = field.placeholderKey
    ? t(field.placeholderKey)
    : (field.placeholder ?? t('cfg.pattern_rules_replacement'));

  if (rows.length === 0) {
    return (
      <div className="pattern-rules-editor">
        <Button
          id={`cfg-${field.id}`}
          aria-describedby={ariaDescribedBy}
          icon={<PlusOutlined />}
          disabled={disabled}
          onClick={addRow}
          data-testid={`pattern-rules-add-${field.id}`}
        >
          {t('cfg.pattern_rules_add')}
        </Button>
      </div>
    );
  }

  return (
    <div className="pattern-rules-editor has-rows">
      <RowReorder items={rowIds} isEnabled={!disabled} onMove={moveRow} onStep={stepRow}>
        <div className="pattern-rules-list" data-testid={`pattern-rules-list-${field.id}`}>
          {rows.map((rule, index) => (
            <PatternRuleRowView
              key={rule.id}
              fieldId={field.id}
              rule={rule}
              index={index}
              count={rows.length}
              hasError={rowErrors[index]}
              disabled={disabled}
              ariaDescribedBy={ariaDescribedBy}
              patternPlaceholder={patternPlaceholder}
              replacementPlaceholder={replacementPlaceholder}
              t={t}
              onUpdate={updateRow}
              onStep={stepRow}
              onRemove={removeRow}
            />
          ))}
        </div>
      </RowReorder>
      {issue !== null && (
        <div className="pattern-rules-error" role="alert">
          {formatPatternRulesIssue(issue, t)}
        </div>
      )}
      <div className="pattern-rules-footer">
        <Button
          size="sm"
          variant="dashed"
          icon={<PlusOutlined />}
          disabled={disabled}
          onClick={addRow}
          data-testid={`pattern-rules-add-${field.id}`}
        >
          {t('cfg.pattern_rules_add')}
        </Button>
      </div>
    </div>
  );
};
