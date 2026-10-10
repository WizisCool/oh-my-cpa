import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useT } from '../../i18n';
import { copyText } from '../../utils/clipboard';
import { useToast } from '../feedback';
import { CopyOutlined } from '../icons';

/**
 * Why one failed request failed, for the list's hover popup.
 *
 * The list carries only the status: the upstream body can quote account detail,
 * so it is read from the single-record view on intent. The query key is the
 * request detail's own, so opening the record afterwards costs no second read.
 */
export function RequestFailureDetail({ eventId, statusLabel }: { eventId: number; statusLabel: string }) {
  const t = useT();
  const toast = useToast();
  const result = useQuery({
    queryKey: ['usage-event', eventId],
    queryFn: () => api.getUsageEvent(eventId),
  });
  const body = result.data?.event?.fail_body?.trim() ?? '';
  const copyBody = async () => {
    if (await copyText(body)) toast.success(t('res.copied'));
    else toast.error(t('events.copy_failed'));
  };
  return (
    <div className="request-failure-detail">
      <header>
        <strong>{statusLabel}</strong>
        {body ? (
          <button type="button" aria-label={t('events.fail_copy')} title={t('events.fail_copy')} onClick={() => void copyBody()}>
            <CopyOutlined />
          </button>
        ) : null}
      </header>
      {body ? (
        <pre>{body}</pre>
      ) : (
        <p>{t(result.isPending ? 'common.loading' : result.isError ? 'events.fail_load_failed' : 'events.fail_no_body')}</p>
      )}
    </div>
  );
}
