import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isAuthFileDisabled,
  isAuthFileProblem,
  isAuthFileHealthy,
  hasAuthFileStatusWarning,
  deriveAuthFileIdentity,
  matchesStatusFilter,
  sortAuthFiles,
  filterAuthFiles,
  executeBatchStatus,
} from '../web/src/components/authFiles/authFileLogic.ts';
import type { ManagementAuthFile } from '../web/src/types/managementAuthFile.ts';

const baseFile: ManagementAuthFile = {
  name: 'claude-1.json',
  disabled: false,
  unavailable: false,
  runtime_only: false,
  success: 10,
  failed: 1,
};

test('Status classification: disabled takes precedence', () => {
  const disabledFile: ManagementAuthFile = {
    ...baseFile,
    disabled: true,
    unavailable: true,
    status: 'error',
    status_message: 'token expired',
  };
  assert.equal(isAuthFileDisabled(disabledFile), true);
  assert.equal(isAuthFileProblem(disabledFile), false, 'Deliberately disabled files must not be classified as problem');
  assert.equal(isAuthFileHealthy(disabledFile), false);
});

test('Status classification: problem detects unavailable, error status, or warning message', () => {
  const unavailableFile: ManagementAuthFile = { ...baseFile, unavailable: true };
  assert.equal(isAuthFileProblem(unavailableFile), true);
  assert.equal(isAuthFileHealthy(unavailableFile), false);

  const errorStatusFile: ManagementAuthFile = { ...baseFile, status: 'error' };
  assert.equal(isAuthFileProblem(errorStatusFile), true);

  const warningMsgFile: ManagementAuthFile = { ...baseFile, status_message: 'Rate limit exceeded' };
  assert.equal(hasAuthFileStatusWarning(warningMsgFile), true);
  assert.equal(isAuthFileProblem(warningMsgFile), true);

  const healthyMsgFile: ManagementAuthFile = { ...baseFile, status_message: 'healthy' };
  assert.equal(hasAuthFileStatusWarning(healthyMsgFile), false);
  assert.equal(isAuthFileProblem(healthyMsgFile), false);
  assert.equal(isAuthFileHealthy(healthyMsgFile), true);
});

test('Identity derivation: account-first display', () => {
  const emailFile: ManagementAuthFile = { ...baseFile, email: 'user@example.com' };
  const identity1 = deriveAuthFileIdentity(emailFile);
  assert.equal(identity1.primary, 'user@example.com');
  assert.equal(identity1.secondary, 'claude-1.json');
  assert.equal(identity1.isAccountPrimary, true);

  const projectFile: ManagementAuthFile = { ...baseFile, project_id: 'gcp-proj-123' };
  const identity2 = deriveAuthFileIdentity(projectFile);
  assert.equal(identity2.primary, 'gcp-proj-123');
  assert.equal(identity2.secondary, 'claude-1.json');

  const plainFile: ManagementAuthFile = { ...baseFile };
  const identity3 = deriveAuthFileIdentity(plainFile);
  assert.equal(identity3.primary, 'claude-1.json');
  assert.equal(identity3.secondary, undefined);
  assert.equal(identity3.isAccountPrimary, false);
});

test('Sorting: handles name, requests, priority, weight', () => {
  const fA: ManagementAuthFile = { ...baseFile, name: 'a.json', success: 5, failed: 5, priority: 1, weight: 10 };
  const fB: ManagementAuthFile = { ...baseFile, name: 'b.json', success: 20, failed: 0, priority: 10, weight: 2 };

  const byNameAsc = sortAuthFiles([fB, fA], 'name-asc');
  assert.equal(byNameAsc[0].name, 'a.json');

  const byNameDesc = sortAuthFiles([fA, fB], 'name-desc');
  assert.equal(byNameDesc[0].name, 'b.json');

  const byRequests = sortAuthFiles([fA, fB], 'requests-desc');
  assert.equal(byRequests[0].name, 'b.json', 'b.json has 20 total requests vs 10');

  const byPriority = sortAuthFiles([fA, fB], 'priority-desc');
  assert.equal(byPriority[0].name, 'b.json', 'b.json has priority 10 vs 1');

  const byWeight = sortAuthFiles([fB, fA], 'weight-desc');
  assert.equal(byWeight[0].name, 'a.json', 'a.json has weight 10 vs 2');
});

test('Filtering: matches query, provider, and status', () => {
  const f1: ManagementAuthFile = { ...baseFile, name: 'claude.json', provider: 'claude', email: 'alice@corp.com' };
  const f2: ManagementAuthFile = { ...baseFile, name: 'codex.json', provider: 'codex', disabled: true };
  const f3: ManagementAuthFile = { ...baseFile, name: 'gemini.json', provider: 'gemini', unavailable: true };

  const all = [f1, f2, f3];

  // Provider filter
  assert.equal(filterAuthFiles(all, '', 'claude', 'all').length, 1);
  assert.equal(filterAuthFiles(all, '', 'claude', 'all')[0].name, 'claude.json');

  // Status filter
  assert.equal(filterAuthFiles(all, '', 'all', 'enabled').length, 1);
  assert.equal(filterAuthFiles(all, '', 'all', 'disabled').length, 1);
  assert.equal(filterAuthFiles(all, '', 'all', 'problem').length, 1);

  // Text search
  assert.equal(filterAuthFiles(all, 'alice', 'all', 'all').length, 1);
  assert.equal(filterAuthFiles(all, 'none-such', 'all', 'all').length, 0);
});

test('Batch status execution: skips runtime-only and handles partial errors', async () => {
  const files: ManagementAuthFile[] = [
    { ...baseFile, name: 'f1.json', runtime_only: false },
    { ...baseFile, name: 'f2.json', runtime_only: true },
    { ...baseFile, name: 'f3.json', runtime_only: false },
  ];

  const calls: string[] = [];
  const setStatusFn = async (name: string, disabled: boolean) => {
    calls.push(name);
    if (name === 'f3.json') {
      throw new Error('network timeout');
    }
  };

  const outcome = await executeBatchStatus(files, true, setStatusFn, 2);
  assert.deepEqual(calls, ['f1.json', 'f3.json'], 'f2.json must be skipped as runtime_only');
  assert.deepEqual(outcome.succeeded, ['f1.json']);
  assert.equal(outcome.failed.length, 1);
  assert.equal(outcome.failed[0].name, 'f3.json');
});
