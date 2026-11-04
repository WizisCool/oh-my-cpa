import { useId } from 'react';
import { SecretInput } from '../../components/common/SecretInput';
import { CheckOutlined, CloseOutlined, WarningOutlined } from '../../components/icons';
import { useT } from '../../i18n';
import type { MessageKey } from '../../i18n/catalog';
import { isPassphraseLongEnough } from './backupModel';
import styles from './DatabaseBackups.module.css';

export const isPassphrasePairValid = (passphrase: string, confirmation: string) =>
  isPassphraseLongEnough(passphrase) && passphrase === confirmation;

/**
 * A passphrase typed twice, with the two rules it has to meet ticked off as they are met.
 *
 * Every place that asks for a backup passphrase - the first setup, a change, a one-off export -
 * asks for the same thing, so it is one form: the rules replace a sentence the reader had to
 * check against what they typed, and the warning that a lost passphrase loses the backups is said
 * once, under the fields it is about.
 */
export function PassphraseFields({
  passphrase,
  confirmation,
  label = 'sys.backup_passphrase',
  isDisabled = false,
  onPassphrase,
  onConfirmation,
}: {
  passphrase: string;
  confirmation: string;
  label?: MessageKey;
  isDisabled?: boolean;
  onPassphrase: (value: string) => void;
  onConfirmation: (value: string) => void;
}) {
  const t = useT();
  const id = useId();
  const isLong = isPassphraseLongEnough(passphrase);
  const isMatch = confirmation.length > 0 && passphrase === confirmation;
  const isMismatch = confirmation.length > 0 && !passphrase.startsWith(confirmation);
  return (
    <div className={styles['passphrase']}>
      <div className={styles['field-pair']}>
        <div className={styles['field']}>
          <label htmlFor={`${id}-passphrase`}>{t(label)}</label>
          <SecretInput
            id={`${id}-passphrase`}
            value={passphrase}
            maxLength={1024}
            autoComplete="new-password"
            disabled={isDisabled}
            onChange={(event) => onPassphrase(event.target.value)}
          />
        </div>
        <div className={styles['field']}>
          <label htmlFor={`${id}-confirmation`}>{t('sys.backup_confirm_passphrase')}</label>
          <SecretInput
            id={`${id}-confirmation`}
            value={confirmation}
            maxLength={1024}
            autoComplete="new-password"
            disabled={isDisabled}
            status={isMismatch ? 'error' : undefined}
            aria-invalid={isMismatch || undefined}
            onChange={(event) => onConfirmation(event.target.value)}
          />
        </div>
      </div>
      <ul className={styles['rules']}>
        <Rule isMet={isLong} metLabel={t('sys.backup_rule_met')}>{t('sys.backup_rule_length')}</Rule>
        <Rule isMet={isMatch} isBroken={isMismatch} metLabel={t('sys.backup_rule_met')} brokenLabel={t('sys.backup_rule_broken')}>
          {t('sys.backup_rule_match')}
        </Rule>
      </ul>
      <p className={styles['keep-safe']}>
        <WarningOutlined aria-hidden />
        <span>{t('sys.backup_keep_safe')}</span>
      </p>
    </div>
  );
}

/**
 * One rule: hollow while unmet, ticked when met, crossed when the typing has already gone wrong.
 * The glyph carries the state for sight and the hidden word carries it for a screen reader, so
 * neither rests on the colour.
 */
function Rule({
  isMet,
  isBroken = false,
  metLabel,
  brokenLabel,
  children,
}: {
  isMet: boolean;
  isBroken?: boolean;
  metLabel: string;
  brokenLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <li className={styles['rule']} data-met={isMet || undefined} data-broken={isBroken || undefined}>
      <span className={styles['rule-mark']} aria-hidden>
        {isBroken ? <CloseOutlined /> : <CheckOutlined />}
      </span>
      {children}
      {isMet && <span className="sr-only"> {metLabel}</span>}
      {isBroken && brokenLabel && <span className="sr-only"> {brokenLabel}</span>}
    </li>
  );
}
