import React from 'react';
import { Button } from 'antd';
import { CloudDownloadOutlined, LinkOutlined } from '../../components/icons';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import { CopyButton } from '../../components/common/CopyButton';
import { Notice } from '../../components/feedback';
import { useT } from '../../i18n';
import type { SystemProductVersion, SystemUpdaterResponse } from '../../types/system';
import type { UpdateOffer } from './versionPresentation';
import styles from '../SystemPage.module.css';

/** Run on the Docker host; `-u 0` because the socket it mounts belongs to root. */
export const UPDATER_INSTALL_COMMAND = 'docker run --rm --pull always -u 0 -v /var/run/docker.sock:/var/run/docker.sock wiziscool/oh-my-cpa:latest updater install';
const UPDATER_GUIDE_URL = 'https://github.com/WizisCool/oh-my-cpa/blob/master/docs/install.md#upgrading';

interface UpdateActionProps {
  version: SystemProductVersion;
  productTitle: string;
  offer: UpdateOffer;
  /** The request that starts this product's update has not been answered yet. */
  isSubmitting: boolean;
  onUpdate: () => void;
}

/**
 * The button that replaces a running container. It keeps one label through every state and asks
 * once before acting, because what it interrupts differs by product and is said in the question.
 */
export const UpdateAction: React.FC<UpdateActionProps> = ({ version, productTitle, offer, isSubmitting, onUpdate }) => {
  const t = useT();
  if (offer.kind !== 'available' && offer.kind !== 'running') return null;
  const isRunning = offer.kind === 'running';
  const isHeld = offer.kind === 'available' && offer.isBusy;
  const isConsole = version.product === 'omc';
  return (
    <ConfirmAction
      title={t(isConsole ? 'sys.update_confirm_omc_title' : 'sys.update_confirm_cpa_title', { version: version.latest_version })}
      description={<div className={styles['update-confirm']}>{t(isConsole ? 'sys.update_confirm_omc_desc' : 'sys.update_confirm_cpa_desc')}</div>}
      confirmLabel={t('sys.update_now')}
      onConfirm={onUpdate}
      disabled={isRunning || isHeld || isSubmitting}
    >
      <Button
        type="primary"
        size="small"
        className={styles['update-action']}
        icon={<CloudDownloadOutlined />}
        loading={isRunning || isSubmitting}
        disabled={isHeld}
        aria-label={t('sys.update_now_named', { product: productTitle, version: version.latest_version })}
        data-testid="sys-apply-update"
      >
        {t('sys.update_now')}
      </Button>
    </ConfirmAction>
  );
};

/** The stage of a running update, or why this product is not updated from the page. */
export const UpdateStatusLine: React.FC<{ offer: UpdateOffer }> = ({ offer }) => {
  const t = useT();
  if (offer.kind === 'running') {
    return <div className={styles['version-detail']} role="status" data-testid="sys-update-stage">{t(offer.stageKey)}</div>;
  }
  if (offer.kind === 'blocked') {
    return <div className={styles['version-detail']} data-testid="sys-update-blocked">{t(offer.reasonKey, { image: offer.image })}</div>;
  }
  return null;
};

/**
 * What stands between this deployment and updating from the page, when it is something the
 * operator can act on. A native install, a disabled updater and the demonstration draw nothing:
 * there is no step to offer them.
 */
export const UpdaterSetup: React.FC<{ updater: SystemUpdaterResponse | undefined }> = ({ updater }) => {
  const t = useT();
  if (updater?.state === 'rejected') {
    return <Notice tone="warning" className={styles['check-alert']} title={t('sys.updater_rejected')} data-testid="sys-updater-rejected" />;
  }
  if (updater?.state !== 'not_installed') return null;
  return (
    <section className={styles['updater-setup']} aria-label={t('sys.updater_install_title')} data-testid="sys-updater-setup">
      <div className={styles['updater-setup-title']}>{t('sys.updater_install_title')}</div>
      <div className={styles['version-detail']}>
        {t('sys.updater_install_desc')}{' '}
        <a href={UPDATER_GUIDE_URL} target="_blank" rel="noopener noreferrer" className={styles['repo-link']}>
          {t('sys.updater_install_guide')} <LinkOutlined />
        </a>
      </div>
      <div className={styles['updater-command']}>
        <code>{UPDATER_INSTALL_COMMAND}</code>
        <CopyButton text={UPDATER_INSTALL_COMMAND} label={t('sys.updater_install_copy')} />
      </div>
    </section>
  );
};
