import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { ManagementAuthFile } from '../types/managementAuthFile';

export type SIWCPhase = 'starting' | 'waiting' | 'verifying' | 'success' | 'error' | 'cancelled';
export interface SIWCSession {
  phase: SIWCPhase;
  state?: string;
  url?: string;
  callbackUrl: string;
  isBusy: boolean;
  confirmedFile?: ManagementAuthFile;
  sourceFile?: ManagementAuthFile;
  wasCancelRefused?: boolean;
  error?: 'start' | 'callback' | 'cancel' | 'read' | 'expired' | 'failed' | 'conflict';
}
export interface SIWCBindings {
  sessions: Record<string, SIWCSession>;
  start: (file: ManagementAuthFile, shouldRebind?: boolean) => Promise<void>;
  submit: (file: ManagementAuthFile) => Promise<void>;
  cancel: (file: ManagementAuthFile) => Promise<void>;
  setCallback: (file: ManagementAuthFile, value: string) => void;
}
export function siwcTargetKey(file: ManagementAuthFile): string {
  return JSON.stringify([file.name, file.auth_index ?? '']);
}
export function isSIWCPending(session?: SIWCSession): boolean {
  return session?.phase === 'starting' || session?.phase === 'waiting' || session?.phase === 'verifying';
}
const POLL_INTERVAL_MS = 3000;

// The workspace owns these attempts, not the selected credential's drawer. A
// close, tab switch or another credential selection cannot discard a live flow.
export function useSIWCBindings(): SIWCBindings {
  const queryClient = useQueryClient();
  const [sessions, setSessions] = React.useState<Record<string, SIWCSession>>({});
  const current = React.useRef(sessions);
  const timers = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const isDisposed = React.useRef(false);
  const operationVersions = React.useRef<Record<string, number>>({});
  React.useEffect(() => {
    isDisposed.current = false;
    return () => {
      isDisposed.current = true;
      Object.values(timers.current).forEach(clearTimeout);
      timers.current = {};
    };
  }, []);
  function update(key: string, patch: Partial<SIWCSession>) {
    if (isDisposed.current) return;
    const previous = current.current[key] ?? { phase: 'starting', callbackUrl: '', isBusy: false };
    current.current = { ...current.current, [key]: { ...previous, ...patch } };
    setSessions(current.current);
  }
  function stop(key: string) {
    clearTimeout(timers.current[key]);
    delete timers.current[key];
  }
  function owns(key: string, state: string) {
    return !isDisposed.current && current.current[key]?.state === state && isSIWCPending(current.current[key]);
  }
  function schedule(key: string, state: string) {
    stop(key);
    if (owns(key, state)) timers.current[key] = setTimeout(() => { void check(key, state); }, POLL_INTERVAL_MS);
  }
  async function check(key: string, state: string) {
    if (!owns(key, state) || current.current[key].isBusy) return;
    const version = operationVersions.current[key] ?? 0;
    const canApply = () => owns(key, state) && version === (operationVersions.current[key] ?? 0);
    try {
      const result = await api.getSIWCBindingStatus(state);
      if (!canApply()) return;
      if (result.status === 'ok' && result.file) {
        stop(key);
        update(key, { phase: 'success', isBusy: false, confirmedFile: result.file, state: undefined, url: undefined, callbackUrl: '', error: undefined });
        void queryClient.invalidateQueries({ queryKey: ['management-auth-files'] });
        void queryClient.invalidateQueries({ queryKey: ['management-quota'] });
        void queryClient.invalidateQueries({ queryKey: ['management-overview'] });
        return;
      }
      if (result.status === 'error') {
        stop(key);
        update(key, { phase: 'error', isBusy: false, callbackUrl: '', url: undefined, error: 'failed' });
        return;
      }
      update(key, { phase: result.completed ? 'verifying' : 'waiting', error: undefined });
    } catch (error) {
      if (!canApply()) return;
      if (error instanceof ApiError && [404, 409, 410].includes(error.status)) {
        update(key, { phase: 'error', isBusy: false, callbackUrl: '', url: undefined, error: 'expired' });
        return;
      }
      update(key, { error: 'read' });
    }
    schedule(key, state);
  }
  async function start(file: ManagementAuthFile, shouldRebind = file.siwc_bound === true) {
    const key = siwcTargetKey(file);
    if (file.siwc_bind_supported !== true || isSIWCPending(current.current[key])) return;
    update(key, { phase: 'starting', isBusy: true, sourceFile: file, state: undefined, url: undefined, callbackUrl: '', error: undefined, wasCancelRefused: false });
    try {
      const result = await api.bindSIWC({ name: file.name, auth_index: file.auth_index ?? '', rebind: shouldRebind });
      if (isDisposed.current) return;
      update(key, { phase: 'waiting', isBusy: false, state: result.state, url: result.url });
      schedule(key, result.state);
    } catch (error) {
      update(key, { phase: 'error', isBusy: false, error: error instanceof ApiError && error.status === 409 ? 'conflict' : 'start' });
    }
  }
  async function submit(file: ManagementAuthFile) {
    const key = siwcTargetKey(file);
    const session = current.current[key];
    if (!session?.state || session.isBusy || session.phase !== 'waiting') return;
    stop(key);
    operationVersions.current[key] = (operationVersions.current[key] ?? 0) + 1;
    update(key, { isBusy: true, error: undefined });
    try {
      await api.submitSIWCCallback(session.state, session.callbackUrl.trim());
      if (!owns(key, session.state)) return;
      update(key, { callbackUrl: '', isBusy: false });
      await check(key, session.state);
    } catch (error) {
      if (!owns(key, session.state)) return;
      update(key, { isBusy: false, error: error instanceof ApiError && error.status === 409 ? 'conflict' : 'callback' });
      schedule(key, session.state);
    }
  }
  async function cancel(file: ManagementAuthFile) {
    const key = siwcTargetKey(file);
    const session = current.current[key];
    if (!session?.state || session.isBusy || session.phase !== 'waiting') return;
    stop(key);
    operationVersions.current[key] = (operationVersions.current[key] ?? 0) + 1;
    update(key, { isBusy: true, error: undefined });
    try {
      const result = await api.cancelSIWCBinding(session.state);
      if (!owns(key, session.state)) return;
      if (result.cancelled === true) {
        update(key, { phase: 'cancelled', isBusy: false, callbackUrl: '', url: undefined, state: undefined });
      } else {
        update(key, { isBusy: false, wasCancelRefused: true });
        await check(key, session.state);
      }
    } catch {
      if (!owns(key, session.state)) return;
      update(key, { isBusy: false, error: 'cancel' });
      schedule(key, session.state);
    }
  }
  return { sessions, start, submit, cancel, setCallback: (file, value) => update(siwcTargetKey(file), { callbackUrl: value }) };
}
