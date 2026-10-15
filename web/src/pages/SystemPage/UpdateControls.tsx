import React from 'react';
import { Button } from 'antd';
import clsx from 'clsx';
import { CloudDownloadOutlined, InfoCircleOutlined, LinkOutlined } from '../../components/icons';
import { ConfirmAction } from '../../components/common/ConfirmAction';
import { CopyButton } from '../../components/common/CopyButton';
import { SectionHeading } from '../../components/common/SectionHeading';
import { Notice } from '../../components/feedback';
import { useT } from '../../i18n';
import type { SystemProductVersion, SystemUpdaterResponse } from '../../types/system';
import { UPDATE_STAGE_ORDER } from './versionPresentation';
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

/**
 * Where a running replacement has got to, or why this product is not updated from the page.
 *
 * The step bar carries the updater's own four stages, not a measured percentage: the stages are
 * known and ordered, their durations are not. The sentence beside it is that stage in words, so
 * the reading never rests on the bar alone.
 */
export const UpdateStatusLine: React.FC<{ offer: UpdateOffer }> = ({ offer }) => {
  const t = useT();
  if (offer.kind === 'running') {
    const reached = UPDATE_STAGE_ORDER.indexOf(offer.stage);
    return (
      <div className={styles['update-progress']}>
        <span className={styles['update-steps']} data-testid="sys-update-steps" aria-hidden="true">
          {UPDATE_STAGE_ORDER.map((stage, index) => (
            <span
              key={stage}
              className={clsx(styles['update-step'], index <= reached && styles['update-step-reached'])}
              data-reached={index <= reached}
            />
          ))}
        </span>
        <div className={styles['version-detail']} role="status" data-testid="sys-update-stage">{t(offer.stageKey)}</div>
      </div>
    );
  }
  if (offer.kind === 'blocked') {
    // A quiet mark rather than a warning: a pinned image or a container that lives elsewhere is
    // an operator's decision, not a fault, and the sentence says which one it is.
    return (
      <div className={styles['update-blocked']} data-testid="sys-update-blocked">
        <span className={styles['update-blocked-icon']} aria-hidden="true"><InfoCircleOutlined /></span>
        <span>{t(offer.reasonKey, { image: offer.image })}</span>
      </div>
    );
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
      <SectionHeading
        level="group"
        title={t('sys.updater_install_title')}
        description={(
          <>
            {t('sys.updater_install_desc')}{' '}
            <a href={UPDATER_GUIDE_URL} target="_blank" rel="noopener noreferrer" className={styles['repo-link']}>
              {t('sys.updater_install_guide')} <LinkOutlined />
            </a>
          </>
        )}
      />
      <div className={styles['updater-command']}>
        <code>{UPDATER_INSTALL_COMMAND}</code>
        <CopyButton text={UPDATER_INSTALL_COMMAND} label={t('sys.updater_install_copy')} />
      </div>
    </section>
  );
};
