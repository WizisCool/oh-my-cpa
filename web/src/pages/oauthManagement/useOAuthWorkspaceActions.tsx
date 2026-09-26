import React from 'react';
import { App as AntdApp } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { useT, type TFunc } from '../../i18n';
import {
  chunkItems,
  executeBatchStatus,
  isAuthFileDisabled,
} from '../../components/authFiles/authFileLogic';
import {
  buildQuotaRefreshTargets,
  quotaRefreshOutcomeSurface,
  type OAuthWorkspaceRecord,
} from './oauthWorkspaceLogic';

export interface OAuthWorkspaceOperationReport {
  scope: 'single' | 'page' | 'filtered' | 'all';
  succeeded: number;
  failed: number;
  skipped: number;
  unknown: number;
  details: Array<{ name: string; reason: string }>;
}

export interface OAuthWorkspaceActions {
  busyFileKeys: Set<string>;
  busyQuotaIndexes: Set<string>;
  isOperating: boolean;
  quotaReport?: OAuthWorkspaceOperationReport;
  clearQuotaReport: () => void;
  upload: (files: File[]) => void;
  download: (record: OAuthWorkspaceRecord) => void;
  deleteOne: (record: OAuthWorkspaceRecord) => Promise<void>;
  toggleOne: (record: OAuthWorkspaceRecord) => Promise<void>;
  batchStatus: (disabled: boolean, records: OAuthWorkspaceRecord[]) => Promise<void>;
  batchDelete: (records: OAuthWorkspaceRecord[]) => Promise<void>;
  refreshQuotaForRecord: (record: OAuthWorkspaceRecord) => Promise<void>;
  refreshQuota: (
    scope: 'page' | 'filtered' | 'all',
    filteredRecords: OAuthWorkspaceRecord[],
    pageRecords: OAuthWorkspaceRecord[],
    allRecords: OAuthWorkspaceRecord[],
  ) => Promise<void>;
  clearCooldown: (record: OAuthWorkspaceRecord) => Promise<void>;
  redeemCredit: (record: OAuthWorkspaceRecord) => Promise<void>;
  isRecordBusy: (record: OAuthWorkspaceRecord) => boolean;
}

function errorMessage(error: unknown, t: TFunc): string {
  if (error instanceof ApiError && error.status === 501) return t('af.unsupported');
  return error instanceof Error ? error.message : t('af.request_failed');
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Owns mutations for the unified workspace. The feature layer, not a global
 * transaction system, is responsible for blocking conflicting writes to one
 * credential while leaving unrelated records readable.
 */
export function useOAuthWorkspaceActions(
  records: OAuthWorkspaceRecord[],
  selectedKeys: string[],
  setSelectedKeys: React.Dispatch<React.SetStateAction<string[]>>,
  onTargetGone: (recordKey: string) => void,
): OAuthWorkspaceActions {
  const t = useT();
  const { message, modal } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const recordsRef = React.useRef(records);
  const selectedRef = React.useRef(selectedKeys);
  const operationLockRef = React.useRef(false);
  const reservedTargetsRef = React.useRef(new Set<string>());
  const [isOperating, setIsOperating] = React.useState(false);
  const [busyFileKeys, setBusyFileKeys] = React.useState<Set<string>>(new Set());
  const [busyQuotaIndexes, setBusyQuotaIndexes] = React.useState<Set<string>>(new Set());
  const [quotaReport, setQuotaReport] = React.useState<OAuthWorkspaceOperationReport>();

  React.useEffect(() => {
    recordsRef.current = records;
  }, [records]);
  React.useEffect(() => {
    selectedRef.current = selectedKeys;
  }, [selectedKeys]);

  const invalidateWorkspace = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['management-auth-files'] }),
      queryClient.invalidateQueries({ queryKey: ['management-quota'] }),
      queryClient.invalidateQueries({ queryKey: ['management-overview'] }),
    ]);
  }, [queryClient]);

  const acquireFileLock = React.useCallback(() => {
    if (operationLockRef.current) return false;
    operationLockRef.current = true;
    setIsOperating(true);
    return true;
  }, []);

  const releaseFileLock = React.useCallback(() => {
    operationLockRef.current = false;
    setIsOperating(false);
  }, []);

  const reserveTargets = React.useCallback((keys: string[]): string[] => {
    const reserved: string[] = [];
    for (const key of keys) {
      if (!key || reservedTargetsRef.current.has(key)) continue;
      reservedTargetsRef.current.add(key);
      reserved.push(key);
    }
    return reserved;
  }, []);

  const releaseTargets = React.useCallback((keys: string[]) => {
    for (const key of keys) reservedTargetsRef.current.delete(key);
  }, []);

  const recordTargetKeys = React.useCallback((record: OAuthWorkspaceRecord): string[] => {
    const keys = [`file:${record.fileName}`];
    if (record.authIndex) keys.push(`quota:${record.authIndex}`);
    return keys;
  }, []);
  const reserveRecordSet = React.useCallback((candidates: OAuthWorkspaceRecord[]) => {
    const reservedRecords: OAuthWorkspaceRecord[] = [];
    const reservedKeys: string[] = [];
    const conflicts: OAuthWorkspaceRecord[] = [];
    for (const record of candidates) {
      const keys = recordTargetKeys(record);
      if (keys.some((key) => reservedTargetsRef.current.has(key))) {
        conflicts.push(record);
        continue;
      }
      keys.forEach((key) => reservedTargetsRef.current.add(key));
      reservedKeys.push(...keys);
      reservedRecords.push(record);
    }
    return { reservedRecords, reservedKeys, conflicts };
  }, [recordTargetKeys]);

  const markFileBusy = React.useCallback((keys: string[], isBusy: boolean) => {
    setBusyFileKeys((previous) => {
      const next = new Set(previous);
      keys.forEach((key) => {
        if (isBusy) next.add(key);
        else next.delete(key);
      });
      return next;
    });
  }, []);

  const markQuotaBusy = React.useCallback((indexes: string[], isBusy: boolean) => {
    setBusyQuotaIndexes((previous) => {
      const next = new Set(previous);
      indexes.forEach((index) => {
        if (isBusy) next.add(index);
        else next.delete(index);
      });
      return next;
    });
  }, []);

  const uploadMutation = useMutation({
    mutationFn: (files: File[]) => api.uploadManagementAuthFiles(files),
    onSuccess: async (result) => {
      if (result.failed && result.failed.length > 0) {
        modal.warning({
          title: t('af.failure_details_title'),
          content: (
            <div className="operation-detail-scroll">
              {result.failed.map((item) => (
                <div key={item.name}><span className="mono-num">{item.name}</span>: {item.error}</div>
              ))}
            </div>
          ),
        });
      } else {
        message.success(t('af.uploaded', { n: result.uploaded ?? 0 }));
      }
      await invalidateWorkspace();
    },
    onError: (error) => message.error(errorMessage(error, t)),
    onSettled: () => releaseFileLock(),
  });

  const downloadMutation = useMutation({
    mutationFn: async (record: OAuthWorkspaceRecord) => {
      const latest = recordsRef.current.find((candidate) => candidate.key === record.key);
      if (!latest || !latest.canDownloadFile || latest.file.runtime_only) {
        throw new Error(t('af.runtime_only_badge'));
      }
      return { record: latest, blob: await api.downloadManagementAuthFile(latest.fileName) };
    },
    onSuccess: ({ record, blob }) => downloadBlob(blob, record.fileName),
    onError: (error) => message.error(errorMessage(error, t)),
  });

  const upload = React.useCallback((files: File[]) => {
    if (files.length === 0 || !acquireFileLock()) return;
    uploadMutation.mutate(files);
  }, [acquireFileLock, uploadMutation]);

  const download = React.useCallback((record: OAuthWorkspaceRecord) => {
    downloadMutation.mutate(record);
  }, [downloadMutation]);

  const confirmSingleDeletion = React.useCallback(async (name: string): Promise<boolean> => {
    const refreshed = await api.getManagementAuthFiles();
    return !refreshed.files.some((file) => file.name === name);
  }, []);

  const deleteOne = React.useCallback(async (record: OAuthWorkspaceRecord) => {
    if (!record.canDeleteFile || !acquireFileLock()) return;
    const reservation = reserveRecordSet([record]);
    if (reservation.reservedRecords.length === 0) {
      message.warning(t('omc.operation_conflict'));
      releaseFileLock();
      return;
    }
    const targets = reservation.reservedKeys;
    markFileBusy([record.key], true);
    try {
      const result = await api.deleteManagementAuthFiles([record.fileName]);
      const confirmedByResponse = Boolean(result.files?.includes(record.fileName));
      const confirmed = confirmedByResponse || await confirmSingleDeletion(record.fileName);
      if (!confirmed) {
        message.error(result.failed?.[0]?.error || t('af.request_failed'));
        return;
      }
      setSelectedKeys((previous) => previous.filter((key) => key !== record.key));
      onTargetGone(record.key);
      message.success(t('af.deleted', { n: 1 }));
      await invalidateWorkspace();
    } catch (error) {
      message.error(errorMessage(error, t));
    } finally {
      markFileBusy([record.key], false);
      releaseTargets(targets);
      releaseFileLock();
    }
  }, [
    acquireFileLock,
    confirmSingleDeletion,
    invalidateWorkspace,
    markFileBusy,
    message,
    onTargetGone,
    releaseFileLock,
    releaseTargets,
    reserveRecordSet,
    setSelectedKeys,
    t,
  ]);

  const toggleOne = React.useCallback(async (record: OAuthWorkspaceRecord) => {
    if (!record.canToggleFile || !acquireFileLock()) return;
    const reservation = reserveRecordSet([record]);
    if (reservation.reservedRecords.length === 0) {
      message.warning(t('omc.operation_conflict'));
      releaseFileLock();
      return;
    }
    const targets = reservation.reservedKeys;
    markFileBusy([record.key], true);
    try {
      const latest = recordsRef.current.find((candidate) => candidate.key === record.key);
      if (!latest || !latest.canToggleFile) return;
      await api.setManagementAuthFileStatus(latest.fileName, !isAuthFileDisabled(latest.file), latest.authIndex);
      await invalidateWorkspace();
    } catch (error) {
      message.error(errorMessage(error, t));
    } finally {
      markFileBusy([record.key], false);
      releaseTargets(targets);
      releaseFileLock();
    }
  }, [acquireFileLock, invalidateWorkspace, markFileBusy, message, releaseFileLock, releaseTargets, reserveRecordSet, t]);

  const batchStatus = React.useCallback(async (disabled: boolean, selectedRecords: OAuthWorkspaceRecord[]) => {
    const eligible = selectedRecords.filter((record) => record.canToggleFile);
    if (eligible.length === 0 || !acquireFileLock()) return;
    const reservation = reserveRecordSet(eligible);
    const targetRecords = reservation.reservedRecords;
    if (targetRecords.length === 0) {
      message.warning(t('omc.operation_conflict'));
      releaseFileLock();
      return;
    }
    const targets = reservation.reservedKeys;
    markFileBusy(targetRecords.map((record) => record.key), true);
    try {
      const outcome = await executeBatchStatus(
        targetRecords.map((record) => record.file),
        disabled,
        (name, nextDisabled, authIndex) => api.setManagementAuthFileStatus(name, nextDisabled, authIndex),
        5,
      );
      const succeededNames = new Set(outcome.succeeded);
      const succeededKeys = new Set(
        targetRecords.filter((record) => succeededNames.has(record.fileName)).map((record) => record.key),
      );
      const failures = [
        ...outcome.failed,
        ...reservation.conflicts.map((record) => ({ name: record.fileName, error: t('omc.operation_conflict') })),
      ];
      setSelectedKeys((previous) => previous.filter((key) => !succeededKeys.has(key)));
      if (failures.length > 0) {
        modal.warning({
          title: t('af.failure_details_title'),
          content: (
            <div className="operation-detail-scroll">
              {failures.map((item) => (
                <div key={item.name}><span className="mono-num">{item.name}</span>: {item.error}</div>
              ))}
            </div>
          ),
        });
      } else {
        message.success(
          disabled
            ? t('af.batch_disable_success', { n: outcome.succeeded.length })
            : t('af.batch_enable_success', { n: outcome.succeeded.length }),
        );
      }
      await invalidateWorkspace();
    } catch (error) {
      message.error(errorMessage(error, t));
    } finally {
      markFileBusy(targetRecords.map((record) => record.key), false);
      releaseTargets(targets);
      releaseFileLock();
    }
  }, [acquireFileLock, invalidateWorkspace, markFileBusy, message, modal, releaseFileLock, releaseTargets, reserveRecordSet, setSelectedKeys, t]);

  const batchDelete = React.useCallback(async (selectedRecords: OAuthWorkspaceRecord[]) => {
    const eligible = selectedRecords.filter((record) => record.canDeleteFile);
    if (eligible.length === 0 || !acquireFileLock()) return;
    const reservation = reserveRecordSet(eligible);
    const targetRecords = reservation.reservedRecords;
    if (targetRecords.length === 0) {
      message.warning(t('omc.operation_conflict'));
      releaseFileLock();
      return;
    }
    const targets = reservation.reservedKeys;
    markFileBusy(targetRecords.map((record) => record.key), true);
    const confirmedNames: string[] = [];
    const failures: Array<{ name: string; error: string }> = reservation.conflicts.map((record) => ({
      name: record.fileName,
      error: t('omc.operation_conflict'),
    }));
    try {
      for (const chunk of chunkItems(targetRecords, 100)) {
        try {
          const response = await api.deleteManagementAuthFiles(chunk.map((record) => record.fileName));
          confirmedNames.push(...(response.files ?? []));
          failures.push(...(response.failed ?? []).map((item) => ({
            name: item.name,
            error: item.error || t('af.request_failed'),
          })));
          const reported = new Set([...(response.files ?? []), ...(response.failed ?? []).map((item) => item.name)]);
          for (const record of chunk) {
            if (!reported.has(record.fileName)) {
              failures.push({ name: record.fileName, error: t('omc.deletion_unconfirmed') });
            }
          }
        } catch (error) {
          const reason = errorMessage(error, t);
          chunk.forEach((record) => failures.push({ name: record.fileName, error: reason }));
        }
      }
      const confirmedSet = new Set(confirmedNames);
      const confirmedKeys = targetRecords.filter((record) => confirmedSet.has(record.fileName));
      setSelectedKeys((previous) => previous.filter((key) => !confirmedKeys.some((record) => record.key === key)));
      confirmedKeys.forEach((record) => onTargetGone(record.key));
      if (failures.length > 0) {
        modal.warning({
          title: t('af.failure_details_title'),
          content: (
            <div className="operation-detail-scroll">
              {failures.map((item) => (
                <div key={item.name}><span className="mono-num">{item.name}</span>: {item.error}</div>
              ))}
            </div>
          ),
        });
      } else if (confirmedNames.length > 0) {
        message.success(t('af.deleted', { n: confirmedNames.length }));
      }
      await invalidateWorkspace();
    } finally {
      markFileBusy(targetRecords.map((record) => record.key), false);
      releaseTargets(targets);
      releaseFileLock();
    }
  }, [acquireFileLock, invalidateWorkspace, markFileBusy, message, modal, onTargetGone, releaseFileLock, releaseTargets, reserveRecordSet, setSelectedKeys, t]);

  const mergeReturnedQuota = React.useCallback((returned: Array<{ auth_index: string }>) => {
    queryClient.setQueryData(['management-quota'], (previous: unknown) => {
      if (!previous || typeof previous !== 'object' || !('quotas' in previous)) return previous;
      const current = previous as { quotas: Array<{ auth_index: string }>; [key: string]: unknown };
      // Rewrite in place and append what the cache did not have. Rebuilding from a
      // Map keyed by auth_index would delete the duplicate and empty observations an
      // operator is reading: those are exactly the rows whose ambiguity diagnostics
      // (`ambiguous-quota-index`, quota-only) must survive the refresh.
      const returnedByIndex = new Map(
        returned.filter((item) => item.auth_index).map((item) => [item.auth_index, item]),
      );
      const cachedIndexes = new Set(current.quotas.map((item) => item.auth_index));
      const quotas = current.quotas.map(
        (item) => (item.auth_index && returnedByIndex.get(item.auth_index)) || item,
      );
      returnedByIndex.forEach((item, index) => {
        if (!cachedIndexes.has(index)) quotas.push(item);
      });
      return { ...current, quotas };
    });
  }, [queryClient]);

  const refreshQuotaIndexes = React.useCallback(async (
    scope: OAuthWorkspaceOperationReport['scope'],
    planIndexes: string[],
    skipped: Array<{ name: string; reason: string }>,
  ) => {
    if (planIndexes.length === 0) {
      // The previous run's report has to go, or the toast saying nothing was eligible appears
      // beside a report describing the run before it - two surfaces, two outcomes, one click.
      setQuotaReport(undefined);
      message.info(t('omc.quota_refresh_none'));
      return;
    }
    const reserved = reserveTargets(planIndexes.map((index) => `quota:${index}`));
    const targetIndexes = planIndexes.filter((index) => reserved.includes(`quota:${index}`));
    const conflicting = planIndexes.filter((index) => !reserved.includes(`quota:${index}`));
    const details = [...skipped, ...conflicting.map((index) => ({ name: index, reason: t('omc.operation_conflict') }))];
    let succeeded = 0;
    let failed = 0;
    // A target held by another operation was not refreshed either. Counting it as skipped
    // would let a run that refreshed nothing report a clean acknowledgement, so it is
    // unrefreshed: the run reports in the page, with the conflict named per target.
    let unknown = conflicting.length;
    markQuotaBusy(targetIndexes, true);
    try {
      for (const chunk of chunkItems(targetIndexes, 10)) {
        try {
          const response = await api.batchRefreshCredentialQuotas(chunk);
          const returned = new Map(response.quotas.map((item) => [item.auth_index, item]));
          mergeReturnedQuota(response.quotas);
          for (const index of chunk) {
            const item = returned.get(index);
            if (!item) {
              unknown += 1;
              details.push({ name: index, reason: t('omc.quota_refresh_unknown') });
            } else if (item.status === 'error' || item.error) {
              failed += 1;
              details.push({ name: item.name || index, reason: item.error || t('quota.status_error') });
            } else {
              succeeded += 1;
            }
          }
        } catch (error) {
          const reason = errorMessage(error, t);
          failed += chunk.length;
          chunk.forEach((index) => details.push({ name: index, reason }));
        }
      }
      // One surface reports the outcome, chosen by whether it needs inspecting. A clean run -
      // including one that skipped targets which were never eligible - is an acknowledgement,
      // so it arrives as a toast and leaves no block behind. A failure keeps the in-page
      // report, because a toast cannot carry the per-target reason and would have to be
      // dismissed before the reason could be read.
      const skippedCount = details.length - failed - unknown;
      const outcome = { scope, succeeded, failed, skipped: skippedCount, unknown, details };
      if (quotaRefreshOutcomeSurface(outcome) === 'report') {
        setQuotaReport(outcome);
      } else {
        setQuotaReport(undefined);
        message.success(t('omc.quota_refresh_report_clean', { succeeded, skipped: skippedCount }));
      }
      await queryClient.invalidateQueries({ queryKey: ['management-quota'] });
    } finally {
      markQuotaBusy(targetIndexes, false);
      releaseTargets(reserved);
    }
  }, [mergeReturnedQuota, message, queryClient, releaseTargets, reserveTargets, t]);

  const refreshQuotaForRecord = React.useCallback(async (record: OAuthWorkspaceRecord) => {
    if (!record.canRefreshQuota || !record.authIndex) return;
    await refreshQuotaIndexes('single', [record.authIndex], []);
  }, [refreshQuotaIndexes]);

  const refreshQuota = React.useCallback(async (
    scope: 'page' | 'filtered' | 'all',
    filteredRecords: OAuthWorkspaceRecord[],
    pageRecords: OAuthWorkspaceRecord[],
    allRecords: OAuthWorkspaceRecord[],
  ) => {
    const source = scope === 'page' ? pageRecords : scope === 'all' ? allRecords : filteredRecords;
    const plan = buildQuotaRefreshTargets(source);
    await refreshQuotaIndexes(scope, plan.eligibleIndexes, plan.skipped.map((item) => ({
      name: item.name,
      reason: t(`omc.quota_skip_${item.reason}`),
    })));
  }, [refreshQuotaIndexes, t]);

  const clearCooldown = React.useCallback(async (record: OAuthWorkspaceRecord) => {
    if (!record.canClearCooldown || !record.authIndex) return;
    const reserved = reserveTargets([`quota:${record.authIndex}`]);
    if (reserved.length === 0) {
      // A batch refresh or another quota action can hold this target. Returning silently
      // would leave a confirmed menu action looking like it did nothing.
      message.warning(t('omc.operation_conflict'));
      return;
    }
    markQuotaBusy([record.authIndex], true);
    try {
      await api.clearCredentialCooldown(record.authIndex);
      message.success(t('quota.clear_cooldown_success'));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['management-quota'] }),
        queryClient.invalidateQueries({ queryKey: ['management-auth-files'] }),
      ]);
    } catch (error) {
      message.error(t('quota.clear_cooldown_failed', { msg: errorMessage(error, t) }));
    } finally {
      markQuotaBusy([record.authIndex], false);
      releaseTargets(reserved);
    }
  }, [markQuotaBusy, message, queryClient, releaseTargets, reserveTargets, t]);

  const redeemCredit = React.useCallback(async (record: OAuthWorkspaceRecord) => {
    // Redemption spends an entitlement, so the target is re-resolved from the latest
    // records: the row's own projection may predate a refresh that took the credit away
    // or left it ambiguous.
    const latest = recordsRef.current.find((candidate) => candidate.key === record.key);
    if (!latest || !latest.canRedeemCredit || !latest.authIndex) return;
    const reserved = reserveTargets([`quota:${latest.authIndex}`]);
    if (reserved.length === 0) {
      message.warning(t('omc.operation_conflict'));
      return;
    }
    markQuotaBusy([latest.authIndex], true);
    try {
      await api.redeemCodexResetCredit(latest.authIndex);
      message.success(t('quota.redeem_credit_success'));
      await queryClient.invalidateQueries({ queryKey: ['management-quota'] });
    } catch (error) {
      message.error(t('quota.redeem_credit_failed', { msg: errorMessage(error, t) }));
    } finally {
      markQuotaBusy([latest.authIndex], false);
      releaseTargets(reserved);
    }
  }, [markQuotaBusy, message, queryClient, releaseTargets, reserveTargets, t]);

  const isRecordBusy = React.useCallback((record: OAuthWorkspaceRecord) => {
    if (busyFileKeys.has(record.key)) return true;
    if (record.authIndex && busyQuotaIndexes.has(record.authIndex)) return true;
    return recordTargetKeys(record).some((key) => reservedTargetsRef.current.has(key));
  }, [busyFileKeys, busyQuotaIndexes, recordTargetKeys]);

  return {
    busyFileKeys,
    busyQuotaIndexes,
    isOperating,
    quotaReport,
    clearQuotaReport: () => setQuotaReport(undefined),
    upload,
    download,
    deleteOne,
    toggleOne,
    batchStatus,
    batchDelete,
    refreshQuotaForRecord,
    refreshQuota,
    clearCooldown,
    redeemCredit,
    isRecordBusy,
  };
}
