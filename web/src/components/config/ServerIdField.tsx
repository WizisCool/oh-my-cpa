import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CopyButton } from '../common/CopyButton';
import { EditOutlined, ReloadOutlined } from '../icons';
import type { useT } from '../../i18n';
import type { ConfigFieldDefinition } from '../../types/configSchema';

const UUID_HYPHENATED_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export type ServerIdValidationIssue =
  | { kind: 'empty' }
  | { kind: 'invalid_uuid' };

export interface ServerIdDraftState {
  isEditing: boolean;
  inputValue: string;
  /** Value held when entering edit mode, so Cancel restores cleanly. */
  previousValue: string;
}

/**
 * Reconciles an open edit session's rollback snapshot when the server baseline
 * advances: if the rollback snapshot matched the superseded baseline (no
 * pre-edit unsaved change), advance it to the new baseline so Cancel never
 * writes stale server state back into the document.
 */
export function reconcileServerIdDraft(
  draft: ServerIdDraftState,
  previousBaseValue: string,
  nextBaseValue: string,
): ServerIdDraftState {
  if (draft.previousValue !== previousBaseValue || previousBaseValue === nextBaseValue) {
    return draft;
  }
  return {
    ...draft,
    previousValue: nextBaseValue,
    inputValue: draft.inputValue === previousBaseValue ? nextBaseValue : draft.inputValue,
  };
}

/**
 * Matches CPA's server.server-id format: a 36-character nonzero hyphenated UUID.
 */
export function isValidServerId(raw: string): boolean {
  const trimmed = raw.trim();
  return UUID_HYPHENATED_RE.test(trimmed) && trimmed.toLowerCase() !== NIL_UUID;
}

export function validateServerIdInput(raw: string): ServerIdValidationIssue | null {
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'empty' };
  if (!isValidServerId(trimmed)) return { kind: 'invalid_uuid' };
  return null;
}

/**
 * Generates a lowercase RFC 4122 UUIDv4, falling back to crypto.getRandomValues
 * for non-HTTPS LAN consoles where crypto.randomUUID is unavailable.
 */
export function generateServerId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID().toLowerCase();
  }
  const bytes = new Uint8Array(16);
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') {
    cryptoObj.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function formatServerIdIssue(issue: ServerIdValidationIssue, t: ReturnType<typeof useT>): string {
  if (issue.kind === 'empty') {
    return t('cfg.f_server_id_err_empty');
  }
  return t('cfg.f_server_id_err_invalid');
}

export interface ServerIdFieldProps {
  field: ConfigFieldDefinition;
  value: unknown;
  disabled?: boolean;
  ariaDescribedBy?: string;
  draftState?: ServerIdDraftState;
  issue?: ServerIdValidationIssue;
  onDraftStateChange: (fieldId: string, state: ServerIdDraftState | null) => void;
  onValidationChange: (fieldId: string, issue: ServerIdValidationIssue | null) => void;
  t: ReturnType<typeof useT>;
  onChange: (field: ConfigFieldDefinition, next: unknown) => void;
}

export const ServerIdField: React.FC<ServerIdFieldProps> = ({
  field,
  value,
  disabled = false,
  ariaDescribedBy,
  draftState,
  issue,
  onDraftStateChange,
  onValidationChange,
  t,
  onChange,
}) => {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const editButtonRef = React.useRef<HTMLButtonElement>(null);
  const shouldFocusEditRef = React.useRef(false);
  const currentValue = typeof value === 'string' ? value.trim() : '';
  const isEditing = draftState?.isEditing === true;
  const inputValue = draftState ? draftState.inputValue : currentValue;
  const wasEditingRef = React.useRef(false);

  React.useEffect(() => {
    if (isEditing && !wasEditingRef.current) {
      shouldFocusEditRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (!isEditing && wasEditingRef.current && shouldFocusEditRef.current) {
      shouldFocusEditRef.current = false;
      editButtonRef.current?.focus();
    }
    wasEditingRef.current = isEditing;
  }, [isEditing]);

  const handleStartEdit = () => {
    onValidationChange(field.id, null);
    onDraftStateChange(field.id, {
      isEditing: true,
      inputValue: currentValue,
      previousValue: currentValue,
    });
  };

  const handleCancel = () => {
    const previousValue = draftState?.previousValue ?? currentValue;
    shouldFocusEditRef.current = true;
    onValidationChange(field.id, null);
    onDraftStateChange(field.id, null);
    onChange(field, previousValue === '' ? undefined : previousValue);
  };

  const handleInputChange = (nextRaw: string) => {
    const trimmed = nextRaw.trim();
    const previousValue = draftState?.previousValue ?? currentValue;
    onDraftStateChange(field.id, {
      isEditing: true,
      inputValue: nextRaw,
      previousValue,
    });
    if (trimmed === '' && previousValue === '') {
      onValidationChange(field.id, null);
      onChange(field, undefined);
      return;
    }
    const nextIssue = validateServerIdInput(nextRaw);
    onValidationChange(field.id, nextIssue);
    if (nextIssue === null) {
      onChange(field, trimmed);
    }
  };

  const handleRegenerate = () => {
    let generated = generateServerId();
    if (generated === currentValue.toLowerCase()) {
      generated = generateServerId();
    }
    onValidationChange(field.id, null);
    if (isEditing) {
      onDraftStateChange(field.id, {
        isEditing: true,
        inputValue: generated,
        previousValue: draftState?.previousValue ?? currentValue,
      });
    }
    onChange(field, generated);
  };

  const errorId = `err-${field.id}`;
  const describedBy = [ariaDescribedBy, issue ? errorId : undefined].filter(Boolean).join(' ') || undefined;

  if (isEditing) {
    return (
      <div className="server-id-field" data-testid="cfg-server-id-field">
        <div className="server-id-row">
          <Input
            id={`cfg-${field.id}`}
            ref={inputRef}
            monospace
            className="server-id-input"
            aria-describedby={describedBy}
            aria-invalid={issue !== undefined}
            status={issue ? 'error' : undefined}
            disabled={disabled}
            placeholder={field.placeholder ?? 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}
            value={inputValue}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => handleInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                handleCancel();
              }
            }}
            data-testid="cfg-server-id-input"
          />
          <div className="server-id-actions">
            <Button
              icon={<ReloadOutlined />}
              disabled={disabled}
              onClick={handleRegenerate}
              data-testid="cfg-server-id-regenerate"
            >
              {t('cfg.f_server_id_regenerate')}
            </Button>
            <Button
              variant="ghost"
              disabled={disabled}
              onClick={handleCancel}
              data-testid="cfg-server-id-cancel"
            >
              {t('common.cancel')}
            </Button>
          </div>
        </div>
        {issue && (
          <div id={errorId} className="server-id-error" role="alert" data-testid="cfg-server-id-error">
            {formatServerIdIssue(issue, t)}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="server-id-field" data-testid="cfg-server-id-field">
      <div className="server-id-row">
        <div className="server-id-readout" data-testid="cfg-server-id-readout">
          {currentValue ? (
            <>
              <code
                className="server-id-code"
                data-tip={currentValue}
                data-tip-overflow=""
                data-testid="cfg-server-id-value"
              >
                {currentValue}
              </code>
              <CopyButton
                text={currentValue}
                label={t('cfg.f_server_id_copy')}
                size="sm"
                className="server-id-copy"
              />
            </>
          ) : (
            <span className="server-id-empty" data-testid="cfg-server-id-empty">
              {t('cfg.f_server_id_unset')}
            </span>
          )}
        </div>
        <div className="server-id-actions">
          <Button
            ref={editButtonRef}
            id={`cfg-${field.id}`}
            aria-describedby={ariaDescribedBy}
            icon={<EditOutlined />}
            disabled={disabled}
            onClick={handleStartEdit}
            data-testid="cfg-server-id-edit"
          >
            {currentValue ? t('cfg.f_server_id_edit') : t('cfg.f_server_id_set')}
          </Button>
          <Button
            icon={<ReloadOutlined />}
            disabled={disabled}
            onClick={handleRegenerate}
            data-testid="cfg-server-id-regenerate"
          >
            {t('cfg.f_server_id_regenerate')}
          </Button>
        </div>
      </div>
    </div>
  );
};
