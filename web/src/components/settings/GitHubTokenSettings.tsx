import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { api, apiErrorCode, describeError } from '../../api/client';
import { useT } from '../../i18n';
import dayjs from '../../utils/time';
import { useTimeZone } from '../../utils/TimeZoneProvider';
import {
  GITHUB_TOKEN_QUERY_KEY,
  type GitHubTokenStatus,
  type GitHubTokenTestResult,
} from '../../types/githubToken';
import { SettingsGroup } from './SettingsGroup';
import { SettingRow } from '../common/SettingRow';
import { SecretInput } from '../common/SecretInput';
import { StatusLabel } from '../common/StatusLabel';
import { ConfirmAction } from '../common/ConfirmAction';
import { MetaLine } from '../common/MetaLine';
import { LoadFailure, Notice, useToast } from '../feedback';
import styles from './GitHubTokenSettings.module.css';

function GitHubTokenForm({ status }: { status: GitHubTokenStatus }) {
  useTimeZone();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = React.useState('');
  const [testResult, setTestResult] = React.useState<GitHubTokenTestResult | null>(null);
  const trimmedDraft = draft.trim();
  const tokenStateKey = `${status.cpa_revision}\0${status.configured ? '1' : '0'}\0${trimmedDraft}`;
  const activeTokenStateRef = React.useRef(tokenStateKey);
  activeTokenStateRef.current = tokenStateKey;

  // Discard any previous quota-test notice as soon as the draft or saved-token revision moves.
  React.useEffect(() => {
    setTestResult(null);
  }, [tokenStateKey]);

  const syncCaches = (saved: GitHubTokenStatus) => {
    queryClient.setQueryData(GITHUB_TOKEN_QUERY_KEY, saved);
    if (!saved.cpa_revision) void queryClient.invalidateQueries({ queryKey: GITHUB_TOKEN_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ['management-config'] });
    void queryClient.invalidateQueries({ queryKey: ['management-system-info'] });
    void queryClient.invalidateQueries({ queryKey: ['management-plugin-store'] });
  };

  const saveMutation = useMutation({
    mutationFn: (token: string) => api.setGitHubToken({
      token,
      cpa_revision: status.cpa_revision,
    }),
    onSuccess: (saved, submittedToken) => {
      setDraft('');
      setTestResult(null);
      syncCaches(saved);
      toast.success(submittedToken === '' ? t('omc.github_token_cleared') : t('omc.github_token_saved'));
    },
    onError: (error) => {
      if (apiErrorCode(error) === 'config_conflict') {
        toast.warning(t('omc.github_token_conflict'));
      } else {
        toast.error(t('omc.github_token_save_failed', { msg: describeError(error) }));
      }
      void queryClient.invalidateQueries({ queryKey: GITHUB_TOKEN_QUERY_KEY });
    },
  });

  const testMutation = useMutation({
    mutationFn: ({ candidate }: { candidate?: string; stateKey: string }) => api.testGitHubToken(candidate),
    onSuccess: (result, variables) => {
      if (variables.stateKey !== activeTokenStateRef.current) return;
      setTestResult(result);
    },
    onError: (error, variables) => {
      if (variables.stateKey !== activeTokenStateRef.current) return;
      toast.error(t('omc.github_token_test_failed', { msg: describeError(error) }));
    },
  });

  const isWriting = saveMutation.isPending;
  const canSave = !isWriting && Boolean(status.cpa_revision) && trimmedDraft.length > 0;

  const renderTestNotice = (result: GitHubTokenTestResult) => {
    const quotaLine = result.limit !== undefined && result.limit > 0 && result.remaining !== undefined ? (
      <MetaLine>
        <span>
          {t('omc.github_token_quota_remaining', {
            remaining: result.remaining.toLocaleString(),
            limit: result.limit.toLocaleString(),
          })}
        </span>
        {result.reset_at_ms ? (
          <span>{t('omc.github_token_quota_reset', { time: dayjs(result.reset_at_ms).format('HH:mm') })}</span>
        ) : null}
      </MetaLine>
    ) : null;

    if (result.status === 'valid') {
      return <Notice tone="success" title={t('omc.github_token_test_valid')} description={quotaLine} />;
    }
    if (result.status === 'anonymous') {
      return <Notice tone="info" title={t('omc.github_token_test_anonymous')} description={quotaLine} />;
    }
    if (result.status === 'invalid') {
      return <Notice tone="error" title={t('omc.github_token_test_invalid')} />;
    }
    return <Notice tone="warning" title={t('omc.github_token_test_error')} description={result.message} />;
  };

  return (
    <>
      <SettingRow
        label={t('omc.github_token_status')}
        description={status.configured && status.masked_token
          ? <code className={`terminal-mono ${styles['masked-token']}`}>{status.masked_token}</code>
          : undefined}
        control={(
          <div className={styles['status-control']}>
            <StatusLabel tone={status.configured ? 'success' : 'neutral'}>
              {status.configured ? t('omc.github_token_configured') : t('omc.github_token_not_configured')}
            </StatusLabel>
            <Button
              size="sm"
              loading={testMutation.isPending}
              disabled={isWriting || testMutation.isPending}
              onClick={() => testMutation.mutate({ candidate: trimmedDraft || undefined, stateKey: tokenStateKey })}
            >
              {t('omc.github_token_test')}
            </Button>
            {status.configured && (
              <ConfirmAction
                isDanger
                title={t('omc.github_token_clear_title')}
                description={t('omc.github_token_clear_desc')}
                confirmLabel={t('omc.github_token_clear')}
                isConfirming={isWriting}
                disabled={isWriting || !status.cpa_revision}
                onConfirm={() => saveMutation.mutateAsync('')}
              >
                <Button size="sm" variant="ghost" danger disabled={isWriting || !status.cpa_revision}>
                  {t('omc.github_token_clear')}
                </Button>
              </ConfirmAction>
            )}
          </div>
        )}
      />
      <SettingRow
        label={t('omc.github_token_input')}
        description={t('omc.github_token_desc')}
        control={(
          <div className={styles['input-control']}>
            <SecretInput
              className={styles['token-input']}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={status.configured ? t('omc.github_token_replace_placeholder') : 'ghp_...'}
              disabled={isWriting || !status.cpa_revision}
              aria-label={t('omc.github_token_input')}
            />
            <Button
              variant="primary"
              loading={isWriting}
              disabled={!canSave}
              onClick={() => saveMutation.mutate(trimmedDraft)}
            >
              {t('common.save')}
            </Button>
          </div>
        )}
      />
      {testResult && (
        <div className="settings-inline-notice">
          {renderTestNotice(testResult)}
        </div>
      )}
    </>
  );
}

/**
 * GitHubTokenSettings manages CPA's `server.github-token` directly from OMC Settings.
 * Both CPA (plugin store & artifact downloads) and OMC (release & star checks) share
 * that single value, so edits from OMC Settings, Configuration, or config.yaml stay unified.
 */
export const GitHubTokenSettings: React.FC = () => {
  const t = useT();
  const query = useQuery({
    queryKey: GITHUB_TOKEN_QUERY_KEY,
    queryFn: api.getGitHubToken,
  });

  return (
    <SettingsGroup id="github-token" title={t('omc.section_github_token')} testId="omc-github-token-settings">
      {query.isError && (
        <LoadFailure
          title={t('omc.github_token_load_failed')}
          error={query.error}
          onRetry={() => { void query.refetch(); }}
        />
      )}
      {query.data && <GitHubTokenForm status={query.data} />}
    </SettingsGroup>
  );
};
