import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import { requestFailureCause } from '../../types/requestDetailSummary';
import { CopyButton } from '../common/CopyButton';
import './RequestFailureDetail.css';
import './requestMarks.css';

/**
 * Why one failed request failed, for the list's hover popup.
 *
 * The list carries only the status: the classification and upstream body are
 * read from the single-record view on intent. The query key is the
 * request detail's own, so opening the record afterwards costs no second read.
 */
export function RequestFailureDetail({ id, eventId, statusLabel }: { id?: string; eventId: number; statusLabel: string }) {
  const t = useT();
  const result = useQuery({
    queryKey: ['usage-event', eventId],
    queryFn: () => api.getUsageEvent(eventId),
  });
  const body = result.data?.event?.fail_body?.trim() ?? '';
  const cause = requestFailureCause(undefined, result.data?.event?.fail_code);
  return (
    <div id={id} className="request-failure-detail">
      <header>
        <span className="req-overview-error-status">{statusLabel}</span>
        {body ? (
          <CopyButton text={body} label={t('events.fail_copy')} />
        ) : null}
      </header>
      {cause !== 'unknown' && <p><strong>{t(`events.cause_${cause}`)}</strong></p>}
      {body ? (
        <pre className="req-overview-error-body">{body}</pre>
      ) : (
        <p>{t(result.isPending ? 'common.loading' : result.isError ? 'events.fail_load_failed' : 'events.fail_no_body')}</p>
      )}
    </div>
  );
}
