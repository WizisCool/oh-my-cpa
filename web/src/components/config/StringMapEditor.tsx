import React from 'react';
import { Button, Input } from 'antd';
import type { InputProps } from 'antd';
import { DeleteOutlined, PlusOutlined } from '../icons';
import type { useT } from '../../i18n';
import type { ConfigFieldDefinition } from '../../types/configSchema';

export interface StringMapRow {
  id: string;
  key: string;
  value: string;
}

export interface StringMapDraftState {
  rows: StringMapRow[];
  baseWire: Record<string, string>;
}

export type StringMapValidationIssue =
  | { kind: 'empty_key' }
  | { kind: 'duplicate_key'; key: string };

let nextRowId = 1;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setOwnStringEntry(target: Record<string, string>, key: string, entryValue: string): void {
  Object.defineProperty(target, key, {
    value: entryValue,
    enumerable: true,
    writable: true,
    configurable: true,
  });
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

function rowsFromWire(raw: unknown): StringMapRow[] {
  if (!isPlainRecord(raw)) return [];
  const usedIds = new Set<string>();
  return Object.entries(raw).map(([key, entryValue]) => ({
    id: uniqueRowId(usedIds, `smap_wire_${encodeURIComponent(key)}`),
    key,
    value: entryValue == null ? '' : String(entryValue),
  }));
}

export function stringMapRowsToWire(rows: readonly Pick<StringMapRow, 'key' | 'value'>[]): Record<string, string> {
  const wire: Record<string, string> = {};
  for (const row of rows) {
    const trimmedKey = row.key.trim();
    if (trimmedKey !== '') {
      setOwnStringEntry(wire, trimmedKey, row.value);
    }
  }
  return wire;
}

export function validateStringMapRows(rows: readonly Pick<StringMapRow, 'key' | 'value'>[]): {
  issue: StringMapValidationIssue | null;
  keyCounts: Map<string, number>;
} {
  const keyCounts = new Map<string, number>();
  let hasOrphanValue = false;
  for (const row of rows) {
    const trimmed = row.key.trim();
    if (trimmed !== '') {
      keyCounts.set(trimmed, (keyCounts.get(trimmed) ?? 0) + 1);
    } else if (row.value !== '') {
      hasOrphanValue = true;
    }
  }
  if (hasOrphanValue) {
    return { issue: { kind: 'empty_key' }, keyCounts };
  }
  const duplicateKey = [...keyCounts.entries()].find(([, count]) => count > 1)?.[0];
  if (duplicateKey !== undefined) {
    return { issue: { kind: 'duplicate_key', key: duplicateKey }, keyCounts };
  }
  return { issue: null, keyCounts };
}

function normalizeWireMap(raw: unknown): Record<string, string> {
  if (!isPlainRecord(raw)) return {};
  const normalized: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(raw)) {
    setOwnStringEntry(normalized, key, entryValue == null ? '' : String(entryValue));
  }
  return normalized;
}

function areWireMapsEqual(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeWireMap(left);
  const normalizedRight = normalizeWireMap(right);
  const leftKeys = Object.keys(normalizedLeft);
  if (leftKeys.length !== Object.keys(normalizedRight).length) return false;
  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(normalizedRight, key) && normalizedLeft[key] === normalizedRight[key],
  );
}

/**
 * Rebases retained draft rows onto a refreshed map value while preserving
 * invalid rows, uncommitted blank rows, draft edits/deletions, and distinct row IDs.
 */
export function rebaseStringMapDraft(draft: StringMapDraftState, nextValue: unknown): StringMapDraftState {
  const nextWire = normalizeWireMap(nextValue);
  if (areWireMapsEqual(nextWire, draft.baseWire)) {
    return draft;
  }

  const keyCounts = new Map<string, number>();
  for (const row of draft.rows) {
    const trimmed = row.key.trim();
    if (trimmed !== '') {
      keyCounts.set(trimmed, (keyCounts.get(trimmed) ?? 0) + 1);
    }
  }

  const rebasedRows: StringMapRow[] = [];
  for (const row of draft.rows) {
    const trimmed = row.key.trim();
    const isUniqueExistingKey =
      trimmed !== ''
      && (keyCounts.get(trimmed) ?? 0) === 1
      && Object.prototype.hasOwnProperty.call(draft.baseWire, trimmed);
    const isUntouchedBaselineRow = isUniqueExistingKey && row.value === draft.baseWire[trimmed];

    if (isUntouchedBaselineRow) {
      if (Object.prototype.hasOwnProperty.call(nextWire, trimmed)) {
        rebasedRows.push(nextWire[trimmed] === row.value ? row : { ...row, value: nextWire[trimmed] });
      }
      continue;
    }
    rebasedRows.push(row);
  }

  const usedIds = new Set(rebasedRows.map((row) => row.id));
  for (const [key, entryValue] of Object.entries(nextWire)) {
    const existedInBase = Object.prototype.hasOwnProperty.call(draft.baseWire, key);
    const presentInDraft = keyCounts.has(key);
    if (!existedInBase && !presentInDraft) {
      rebasedRows.push({
        id: uniqueRowId(usedIds, `smap_sync_${encodeURIComponent(key)}`),
        key,
        value: entryValue,
      });
    }
  }

  return { rows: rebasedRows, baseWire: nextWire };
}

export function formatStringMapIssue(issue: StringMapValidationIssue, t: ReturnType<typeof useT>): string {
  return issue.kind === 'empty_key'
    ? t('cfg.string_map_empty_key')
    : t('cfg.string_map_duplicate_key', { key: issue.key });
}

function isComposing(event: React.ChangeEvent<HTMLInputElement>): boolean {
  return (event.nativeEvent as InputEvent | undefined)?.isComposing === true;
}

interface ComposingTextInputProps extends Omit<InputProps, 'value' | 'onChange'> {
  value: string;
  onCommit: (value: string) => void;
  'data-testid'?: string;
}

const ComposingTextInput: React.FC<ComposingTextInputProps> = ({ value, onCommit, onBlur, ...rest }) => {
  const [composingDraft, setComposingDraft] = React.useState<string | null>(null);
  const isComposingSessionRef = React.useRef(false);
  const lastCommittedRef = React.useRef<string>(value);

  React.useEffect(() => {
    lastCommittedRef.current = value;
    if (!isComposingSessionRef.current) {
      setComposingDraft(null);
    }
  }, [value]);

  const commit = React.useCallback(
    (text: string) => {
      isComposingSessionRef.current = false;
      setComposingDraft(null);
      if (text === lastCommittedRef.current) return;
      lastCommittedRef.current = text;
      onCommit(text);
    },
    [onCommit],
  );

  return (
    <Input
      {...rest}
      value={composingDraft ?? value}
      onChange={(event) => {
        if (isComposing(event)) {
          isComposingSessionRef.current = true;
          setComposingDraft(event.target.value);
          return;
        }
        commit(event.target.value);
      }}
      onCompositionStart={() => {
        isComposingSessionRef.current = true;
        setComposingDraft((prev) => prev ?? value);
      }}
      onCompositionEnd={(event) => commit(event.currentTarget.value)}
      onBlur={(event) => {
        if (composingDraft !== null) commit(event.currentTarget.value);
        else isComposingSessionRef.current = false;
        onBlur?.(event);
      }}
    />
  );
};

interface StringMapEditorProps {
  field: ConfigFieldDefinition;
  value: unknown;
  disabled?: boolean;
  ariaDescribedBy?: string;
  draftState?: StringMapDraftState;
  onDraftStateChange?: (fieldId: string, state: StringMapDraftState | null) => void;
  onValidationChange?: (fieldId: string, issue: StringMapValidationIssue | null) => void;
  t: ReturnType<typeof useT>;
  onChange: (field: ConfigFieldDefinition, value: Record<string, string>) => void;
}

/**
 * Editable literal string-to-string mapping (`Record<string, string>`).
 *
 * Draft rows are retained while the operator types interior spaces, holds an
 * uncommitted blank row, or resolves a validation error; invalid rows block
 * saving without overwriting the YAML document with a partial or collapsed map.
 */
export const StringMapEditor: React.FC<StringMapEditorProps> = ({
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
  const [localDraftState, setLocalDraftState] = React.useState<StringMapDraftState | null>(null);
  const activeDraftState = onDraftStateChange ? (draftState ?? null) : localDraftState;

  const wireRows = React.useMemo(() => rowsFromWire(value), [value]);
  const normalizedValue = React.useMemo(() => normalizeWireMap(value), [value]);

  const resolvedDraft = React.useMemo(
    () => (activeDraftState ? rebaseStringMapDraft(activeDraftState, value) : null),
    [activeDraftState, value],
  );

  const rows = resolvedDraft ? resolvedDraft.rows : wireRows;

  const setDraft = React.useCallback(
    (next: StringMapDraftState | null) => {
      if (onDraftStateChange) {
        onDraftStateChange(field.id, next);
      } else {
        setLocalDraftState(next);
      }
    },
    [field.id, onDraftStateChange],
  );

  const commitRows = React.useCallback(
    (nextRows: StringMapRow[], currentBaseWire: Record<string, string>) => {
      const { issue } = validateStringMapRows(nextRows);
      onValidationChange?.(field.id, issue);
      if (issue !== null) {
        setDraft({ rows: nextRows, baseWire: currentBaseWire });
        return;
      }
      const wire = stringMapRowsToWire(nextRows);
      setDraft({ rows: nextRows, baseWire: wire });
      if (!areWireMapsEqual(wire, value)) {
        onChange(field, wire);
      }
    },
    [field, onChange, onValidationChange, setDraft, value],
  );

  const currentBaseWire = resolvedDraft ? resolvedDraft.baseWire : normalizedValue;

  const addRow = React.useCallback(() => {
    const usedIds = new Set(rows.map((row) => row.id));
    const newId = uniqueRowId(usedIds, `smap_${nextRowId++}`);
    setDraft({
      rows: [...rows, { id: newId, key: '', value: '' }],
      baseWire: currentBaseWire,
    });
  }, [currentBaseWire, rows, setDraft]);

  const updateRow = React.useCallback(
    (id: string, patch: Partial<Pick<StringMapRow, 'key' | 'value'>>) => {
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

  const { issue, keyCounts } = validateStringMapRows(rows);

  const keyPlaceholder = field.keyPlaceholderKey ? t(field.keyPlaceholderKey) : t('cfg.string_map_key');
  const valuePlaceholder = field.placeholderKey
    ? t(field.placeholderKey)
    : (field.placeholder ?? t('cfg.string_map_value'));

  if (rows.length === 0) {
    return (
      <div className="string-map-editor">
        <Button
          id={`cfg-${field.id}`}
          aria-describedby={ariaDescribedBy}
          icon={<PlusOutlined />}
          disabled={disabled}
          onClick={addRow}
          data-testid={`string-map-add-${field.id}`}
        >
          {t('cfg.string_map_add')}
        </Button>
      </div>
    );
  }

  return (
    <div className="string-map-editor has-rows">
      <div className="string-map-list">
        {rows.map((row, index) => {
          const trimmed = row.key.trim();
          const hasKeyError =
            (trimmed === '' && row.value !== '')
            || (trimmed !== '' && (keyCounts.get(trimmed) ?? 0) > 1);
          return (
            <div key={row.id} className="string-map-row">
              <ComposingTextInput
                id={index === 0 ? `cfg-${field.id}` : undefined}
                aria-describedby={index === 0 ? ariaDescribedBy : undefined}
                aria-label={`${keyPlaceholder} ${index + 1}`}
                className="config-mono-input"
                value={row.key}
                disabled={disabled}
                placeholder={keyPlaceholder}
                status={hasKeyError ? 'error' : undefined}
                spellCheck={false}
                onCommit={(nextKey) => updateRow(row.id, { key: nextKey })}
                data-testid={`string-map-key-${field.id}-${index}`}
              />
              <span className="string-map-arrow" aria-hidden="true">
                →
              </span>
              <ComposingTextInput
                aria-label={`${valuePlaceholder} ${index + 1}`}
                className="config-mono-input"
                value={row.value}
                disabled={disabled}
                placeholder={valuePlaceholder}
                spellCheck={false}
                onCommit={(nextValue) => updateRow(row.id, { value: nextValue })}
                data-testid={`string-map-value-${field.id}-${index}`}
              />
              <Button
                size="small"
                type="text"
                danger
                icon={<DeleteOutlined />}
                disabled={disabled}
                aria-label={t('cfg.string_map_remove', { n: index + 1 })}
                onClick={() => removeRow(row.id)}
                data-testid={`string-map-remove-${field.id}-${index}`}
              />
            </div>
          );
        })}
      </div>
      {issue !== null && (
        <div className="string-map-error" role="alert">
          {formatStringMapIssue(issue, t)}
        </div>
      )}
      <div className="string-map-footer">
        <Button
          size="small"
          type="dashed"
          icon={<PlusOutlined />}
          disabled={disabled}
          onClick={addRow}
          data-testid={`string-map-add-${field.id}`}
        >
          {t('cfg.string_map_add')}
        </Button>
      </div>
    </div>
  );
};
