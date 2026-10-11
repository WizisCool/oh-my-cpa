import React from 'react';
import { Button, Input } from 'antd';
import { DeleteOutlined, PlusOutlined } from '../icons';
import type { useT } from '../../i18n';
import { Notice } from '../feedback';
import type { ConfigFieldDefinition } from '../../types/configSchema';

// The placeholder the safe YAML carries for a stored secret, mirrored from
// UnchangedSentinel in internal/cpa/configyaml/configyaml.go. It round-trips
// untouched for a kept secret; the server restores the stored value.
export const ICE_UNCHANGED_SENTINEL = '__OMCPA_UNCHANGED__';

const ICE_URL_SCHEMES = ['stun', 'stuns', 'turn', 'turns'];

export interface IceServerWireValue {
  urls: string[];
  username?: string;
  credential?: string;
}

type IceSecretMode = 'keep' | 'set' | 'clear' | 'absent' | 'undecided';

interface IceServerRow {
  key: string;
  urlsText: string;
  hasStoredUsername: boolean;
  hasStoredCredential: boolean;
  usernameMode: IceSecretMode;
  usernameValue: string;
  credentialMode: IceSecretMode;
  credentialValue: string;
}

let nextRowKey = 1;

function parseUrls(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '');
}

function invalidUrl(text: string): string | null {
  for (const line of parseUrls(text)) {
    const scheme = line.split(':')[0]?.toLowerCase() ?? '';
    if (!ICE_URL_SCHEMES.includes(scheme)) return line;
  }
  return null;
}

function rowsFromWire(list: unknown): IceServerRow[] {
  const items = Array.isArray(list) ? list : [];
  return items.map((item) => rowFromWire({
    urls: Array.isArray((item as IceServerWireValue)?.urls) ? (item as IceServerWireValue).urls : [],
    username: (item as IceServerWireValue)?.username,
    credential: (item as IceServerWireValue)?.credential,
  }));
}

function rowFromWire(value: IceServerWireValue): IceServerRow {
  const usernameKept = value.username === ICE_UNCHANGED_SENTINEL;
  const credentialKept = value.credential === ICE_UNCHANGED_SENTINEL;
  return {
    key: `ice_${nextRowKey++}`,
    urlsText: (value.urls ?? []).join('\n'),
    hasStoredUsername: usernameKept,
    hasStoredCredential: credentialKept,
    usernameMode: usernameKept ? 'keep' : value.username != null && value.username !== '' ? 'set' : 'absent',
    usernameValue: usernameKept || value.username == null ? '' : value.username,
    credentialMode: credentialKept ? 'keep' : value.credential != null && value.credential !== '' ? 'set' : 'absent',
    credentialValue: credentialKept || value.credential == null ? '' : value.credential,
  };
}

function rowToWire(row: IceServerRow): IceServerWireValue {
  const wire: IceServerWireValue = { urls: parseUrls(row.urlsText) };
  // An empty replacement retains the stored secret via the sentinel. The
  // server refuses restoration if the server identities changed, rather than
  // pairing the secret with another server or silently clearing it.
  if (row.usernameMode === 'keep' || row.usernameMode === 'undecided') {
    wire.username = ICE_UNCHANGED_SENTINEL;
  } else if (row.usernameMode === 'set') {
    wire.username = row.usernameValue;
  } else if (row.usernameMode === 'clear') {
    wire.username = '';
  }
  if (row.credentialMode === 'keep' || row.credentialMode === 'undecided') {
    wire.credential = ICE_UNCHANGED_SENTINEL;
  } else if (row.credentialMode === 'set') {
    wire.credential = row.credentialValue;
  } else if (row.credentialMode === 'clear') {
    wire.credential = '';
  }
  return wire;
}

interface IceServersEditorProps {
  field: ConfigFieldDefinition;
  value: unknown;
  disabled?: boolean;
  t: ReturnType<typeof useT>;
  onChange: (field: ConfigFieldDefinition, value: unknown) => void;
}

/**
 * The codex live-media-relay ICE server list. Each server names its STUN/TURN
 * URLs in the clear and carries TURN secrets the browser never sees, so every
 * secret has an explicit state: keep the stored value, replace it, clear it,
 * or leave the server without one.
 *
 * The server restores kept secrets by position, which is why the list offers
 * no reorder: any change to the servers' identities or order turns remaining
 * keeps into explicit re-entry decisions, and a save that still carries a
 * sentinel for a moved entry is refused rather than mispaired.
 */
export const IceServersEditor: React.FC<IceServersEditorProps> = ({
  field,
  value,
  disabled,
  t,
  onChange,
}) => {
  // Rows live in local state rather than deriving from the value prop on every
  // render: keep and undecided share a sentinel on the wire, but only one
  // displays a replacement input. Own echoes must not erase that distinction.
  // An external change (discard, or an edit in the source view) resyncs; the
  // editor's own emits echo back identically and are ignored.
  const [rows, setRows] = React.useState<IceServerRow[]>(() => rowsFromWire(value));
  const lastWireRef = React.useRef<unknown>(rows.map(rowToWire));
  // The server identities the operator was shown: a kept secret stays valid
  // only while the list still names the same servers in order.
  const snapshotRef = React.useRef<string[]>(rows.map((row) => row.urlsText));
  if (JSON.stringify(value ?? null) !== JSON.stringify(lastWireRef.current)) {
    const next = rowsFromWire(value);
    setRows(next);
    // Remember what was received, not what it normalized to: key order or
    // dropped empty fields would otherwise keep the comparison unequal and
    // resync on every render. Own emits echo back identically either way.
    lastWireRef.current = value;
    snapshotRef.current = next.map((row) => row.urlsText);
  }
  const snapshot = snapshotRef.current;
  const shapeChanged = rows.length !== snapshot.length
    || rows.some((row, index) => row.urlsText !== snapshot[index]);

  const emit = React.useCallback((next: IceServerRow[]) => {
    const wire = next.map(rowToWire);
    lastWireRef.current = wire;
    setRows(next);
    onChange(field, wire);
  }, [field, onChange]);

  const patchRow = React.useCallback((key: string, patch: Partial<IceServerRow>) => {
    const next = rows.map((row) => {
      if (row.key !== key) return row;
      const merged = { ...row, ...patch };
      // A server whose URLs no longer match what was shown cannot keep its
      // stored secrets: they become explicit re-entry decisions.
      if (patch.urlsText !== undefined && patch.urlsText !== snapshot[rows.indexOf(row)]) {
        if (merged.usernameMode === 'keep') merged.usernameMode = 'undecided';
        if (merged.credentialMode === 'keep') merged.credentialMode = 'undecided';
      }
      return merged;
    });
    // Adding, removing or rewording any server invalidates every other keep,
    // because the server pairs kept secrets with entries by position.
    const nextShapeChanged = next.length !== snapshot.length
      || next.some((row, index) => row.urlsText !== snapshot[index]);
    emit(nextShapeChanged
      ? next.map((row) => ({
        ...row,
        usernameMode: row.usernameMode === 'keep' ? 'undecided' as IceSecretMode : row.usernameMode,
        credentialMode: row.credentialMode === 'keep' ? 'undecided' as IceSecretMode : row.credentialMode,
      }))
      : next);
  }, [rows, snapshot, emit]);

  const addRow = React.useCallback(() => {
    emit([...rows, {
      key: `ice_${nextRowKey++}`,
      urlsText: '',
      hasStoredUsername: false,
      hasStoredCredential: false,
      usernameMode: 'absent',
      usernameValue: '',
      credentialMode: 'absent',
      credentialValue: '',
    }]);
  }, [rows, emit]);

  const removeRow = React.useCallback((key: string) => {
    const next = rows.filter((row) => row.key !== key);
    emit(next.map((row) => ({
      ...row,
      usernameMode: row.usernameMode === 'keep' ? 'undecided' as IceSecretMode : row.usernameMode,
      credentialMode: row.credentialMode === 'keep' ? 'undecided' as IceSecretMode : row.credentialMode,
    })));
  }, [rows, emit]);

  const setSecretMode = React.useCallback((key: string, secret: 'username' | 'credential', mode: IceSecretMode) => {
    patchRow(key, secret === 'username' ? { usernameMode: mode } : { credentialMode: mode });
  }, [patchRow]);

  const needsReentry = rows.some((row) => row.usernameMode === 'undecided' || row.credentialMode === 'undecided');

  const renderSecret = (row: IceServerRow, secret: 'username' | 'credential') => {
    const mode = secret === 'username' ? row.usernameMode : row.credentialMode;
    const secretValue = secret === 'username' ? row.usernameValue : row.credentialValue;
    const label = secret === 'username' ? t('cfg.ice_username') : t('cfg.ice_credential');
    const hasStoredSecret = secret === 'username' ? row.hasStoredUsername : row.hasStoredCredential;
    const startReplacement = () => patchRow(row.key, secret === 'username'
      ? { usernameMode: hasStoredSecret ? 'undecided' : 'set', usernameValue: '' }
      : { credentialMode: hasStoredSecret ? 'undecided' : 'set', credentialValue: '' });
    const updateReplacement = (text: string) => {
      const nextMode: IceSecretMode = text !== '' ? 'set' : hasStoredSecret ? 'undecided' : 'absent';
      patchRow(row.key, secret === 'username'
        ? { usernameMode: nextMode, usernameValue: text }
        : { credentialMode: nextMode, credentialValue: text });
    };
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 12, marginBottom: 4 }}>{label}</div>
        {mode === 'keep' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input value="••••••••" disabled style={{ maxWidth: 220 }} aria-label={label} />
            <Button size="small" disabled={disabled} onClick={startReplacement}>
              {t('cfg.ice_replace')}
            </Button>
            <Button size="small" disabled={disabled} onClick={() => setSecretMode(row.key, secret, 'clear')}>
              {t('cfg.ice_clear')}
            </Button>
          </div>
        )}
        {mode === 'set' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Input
              value={secretValue}
              disabled={disabled}
              style={{ maxWidth: 220 }}
              aria-label={label}
              placeholder={label}
              onChange={(event) => updateReplacement(event.target.value)}
            />
            <Button size="small" disabled={disabled} onClick={() => setSecretMode(row.key, secret, 'clear')}>
              {t('cfg.ice_clear')}
            </Button>
          </div>
        )}
        {mode === 'clear' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, opacity: 0.65 }}>{t('cfg.ice_will_clear')}</span>
            <Button size="small" disabled={disabled} onClick={startReplacement}>
              {t('cfg.ice_replace')}
            </Button>
          </div>
        )}
        {mode === 'absent' && (
          <Button size="small" disabled={disabled} onClick={startReplacement}>
            {t('cfg.ice_add_secret', { secret: label })}
          </Button>
        )}
        {mode === 'undecided' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Input
              value={secretValue}
              disabled={disabled}
              style={{ maxWidth: 220 }}
              aria-label={label}
              placeholder={t('cfg.ice_reenter_placeholder')}
              onChange={(event) => updateReplacement(event.target.value)}
            />
            <Button size="small" disabled={disabled} onClick={() => setSecretMode(row.key, secret, 'clear')}>
              {t('cfg.ice_clear')}
            </Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {shapeChanged && (
        <div style={{ marginBottom: 8 }}>
          <Notice tone="warning" title={t('cfg.ice_reentry_notice')} />
        </div>
      )}
      {rows.map((row, index) => {
        const badUrl = invalidUrl(row.urlsText);
        const emptyUrls = parseUrls(row.urlsText).length === 0;
        return (
          <div key={row.key} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontWeight: 600 }}>{t('cfg.ice_server_title', { n: index + 1 })}</span>
              <Button
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={disabled}
                aria-label={t('cfg.ice_remove_server', { n: index + 1 })}
                onClick={() => removeRow(row.key)}
              />
            </div>
            <div style={{ fontSize: 12, marginBottom: 4 }}>{t('cfg.ice_urls')}</div>
            <Input.TextArea
              value={row.urlsText}
              disabled={disabled}
              autoSize={{ minRows: 1, maxRows: 4 }}
              placeholder={t('cfg.ice_urls_placeholder')}
              aria-label={t('cfg.ice_urls')}
              onChange={(event) => patchRow(row.key, { urlsText: event.target.value })}
            />
            {emptyUrls && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>{t('cfg.ice_urls_required')}</div>}
            {badUrl && <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: 4 }}>{t('cfg.ice_bad_url', { url: badUrl })}</div>}
            {renderSecret(row, 'username')}
            {renderSecret(row, 'credential')}
          </div>
        );
      })}
      <Button icon={<PlusOutlined />} disabled={disabled} onClick={addRow}>
        {t('cfg.ice_add_server')}
      </Button>
      {shapeChanged && needsReentry && (
        <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>{t('cfg.ice_reentry_hint')}</div>
      )}
    </div>
  );
};
