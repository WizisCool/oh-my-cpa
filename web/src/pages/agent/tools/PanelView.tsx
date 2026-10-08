import { Link } from 'react-router-dom';
import type { DisplayView, ViewBlock, ViewItem } from '../../../agent/types';
import { useI18n } from '../../../i18n';
import { AgentIcon } from './AgentIcon';
import styles from '../AgentPage.module.css';

/**
 * A panel (ADR 0079): the blocks a model chose, drawn from the console's own tokens. The model
 * decides what to say and in which block; every pixel of how a block looks is decided here, which
 * is what lets a view follow a theme switch and stay legible at any width.
 */
export function PanelView({ view }: { view: DisplayView }) {
  return (
    <figure className={`${styles['view']} ${styles['panel']}`} data-testid="agent-view" data-kind="panel">
      <figcaption className={styles['view-title']}>{view.title}</figcaption>
      {(view.blocks ?? []).map((block, index) => (
        <section key={index} className={styles['block']} data-block={block.type}>
          {block.title && <h4 className={styles['block-title']}>{block.title}</h4>}
          <Block block={block} />
        </section>
      ))}
    </figure>
  );
}

function Block({ block }: { block: ViewBlock }) {
  const { t } = useI18n();
  const items = block.items ?? [];
  switch (block.type) {
    case 'stats':
      return (
        <dl className={styles['stats']}>
          {items.map((item, index) => (
            <div key={index} className={styles['stat']} data-tone={item.tone ?? 'neutral'}>
              <dt className={styles['stat-label']}>
                {item.icon && <AgentIcon icon={item.icon} size={13} />}
                <span>{item.label}</span>
              </dt>
              <dd className={styles['stat-value']}>
                <span>{item.value}</span>
                {item.delta && <span className={styles['stat-delta']}>{item.delta}</span>}
              </dd>
            </div>
          ))}
        </dl>
      );
    case 'fields':
      return (
        <dl className={styles['fields']}>
          {items.map((item, index) => (
            <div key={index} className={styles['field']}>
              <dt>{item.label}</dt>
              <dd>{item.value}</dd>
            </div>
          ))}
        </dl>
      );
    case 'callout':
      return <p className={styles['callout']} data-tone={block.tone ?? 'info'}>{block.text}</p>;
    case 'steps':
      return (
        <ol className={styles['steps']}>
          {items.map((item, index) => (
            <li key={index} className={styles['step']} data-status={item.status ?? 'pending'}>
              <span className={styles['step-mark']} role="img" aria-label={t(`agent.view.step.${item.status ?? 'pending'}`)} />
              <span className={styles['step-label']}>{item.label}</span>
              {item.text && <span className={styles['step-text']}>{item.text}</span>}
            </li>
          ))}
        </ol>
      );
    case 'meters':
      return (
        <div className={styles['meters']}>
          {items.map((item, index) => <Meter key={index} item={item} />)}
        </div>
      );
    case 'links':
      return (
        <nav className={styles['links']} aria-label={block.title}>
          {items.map((item, index) => (
            <Link key={index} className={styles['link']} to={`/${item.route ?? ''}`}>
              <AgentIcon icon={item.icon ?? 'arrow-up-right'} size={13} />
              <span>{item.label}</span>
            </Link>
          ))}
        </nav>
      );
    default:
      return null;
  }
}

function Meter({ item }: { item: ViewItem }) {
  const share = Math.min(1, Math.max(0, item.share ?? 0));
  return (
    <div className={styles['meter']} data-tone={item.tone ?? 'neutral'}>
      <span className={styles['meter-label']}>{item.label}</span>
      <span className={styles['meter-value']}>{item.value || `${Math.round(share * 100)}%`}</span>
      <span
        className={styles['meter-track']}
        role="meter"
        aria-label={item.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
      >
        <span className={styles['meter-fill']} style={{ width: `${share * 100}%` }} />
      </span>
    </div>
  );
}
