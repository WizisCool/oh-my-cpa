// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../src/api/client';

afterEach(() => vi.unstubAllGlobals());

it.each(['', '/', '/omc'])('keeps backup transfer and confirmation mount-aware at %s', async (basePath) => {
  const mount = basePath === '/' ? '' : basePath;
  const calls: { path: string; options: RequestInit }[] = [];
  vi.stubGlobal('window', { __OMCPA_CONFIG__: { basePath }, location: { origin: 'https://omc.example' } });
  vi.stubGlobal('fetch', async (path: string, options: RequestInit) => {
    calls.push({ path, options });
    return new Response(JSON.stringify(options.method === 'POST' ? { id: 'job', state: 'ready' } : { items: [] }), { headers: { 'Content-Type': 'application/json' } });
  });
  await api.getDatabaseBackups();
  expect(calls.at(-1)?.path).toBe(`${mount}/api/v1/management/system/database-backups`);
  await api.createDatabaseBackup('independent backup passphrase');
  expect(JSON.parse(calls.at(-1)?.options.body as string)).toEqual({ passphrase: 'independent backup passphrase' });
  expect(calls.at(-1)?.options.credentials).toBe('same-origin');
  const file = new File(['encrypted content'], 'backup.omcbackup');
  await api.inspectDatabaseBackup(file, 'independent backup passphrase');
  expect(calls.at(-1)?.path).toBe(`${mount}/api/v1/management/system/database-restores`);
  const body = calls.at(-1)?.options.body as FormData;
  expect([...body.keys()]).toEqual(['passphrase', 'file']);
  expect(body.get('passphrase')).toBe('independent backup passphrase');
  expect((body.get('file') as File).name).toBe(file.name);
  await api.scheduleDatabaseRestore('job/with slash', 'validated digest');
  expect(calls.at(-1)?.path).toBe(`${mount}/api/v1/management/system/database-restores/job%2Fwith%20slash/apply`);
  expect(JSON.parse(calls.at(-1)?.options.body as string)).toEqual({ digest: 'validated digest' });
  expect(api.databaseBackupDownloadUrl('job')).toBe(`${mount}/api/v1/management/system/database-backups/job/download`);
  await api.startBackupAuthorization({ provider: 'onedrive' });
  expect(calls.at(-1)?.path).toBe(`${mount}/api/v1/management/system/database-backup-authorization`);
  expect(JSON.parse(calls.at(-1)?.options.body as string)).toEqual({ provider: 'onedrive' });
  await api.getBackupAuthorization('authorization/id');
  expect(calls.at(-1)?.path).toBe(`${mount}/api/v1/management/system/database-backup-authorization/authorization%2Fid`);
  await api.completeBackupAuthorization('authorization/id', 'http://localhost:53682/?code=fixture&state=state');
  expect(calls.at(-1)?.path).toBe(`${mount}/api/v1/management/system/database-backup-authorization/authorization%2Fid/complete`);
  expect(JSON.parse(calls.at(-1)?.options.body as string)).toEqual({ callback_url: 'http://localhost:53682/?code=fixture&state=state' });
  await api.cancelBackupAuthorization('authorization/id');
  expect(calls.at(-1)?.options.method).toBe('DELETE');
  expect(api.databaseBackupOAuthCallbackUrl()).toBe(`https://omc.example${mount}/api/auth/database-backup/callback`);
  await api.getDatabaseBackupAutomation();
  expect(calls.at(-1)?.path).toBe(`${mount}/api/v1/management/system/database-backup-automation`);
  await api.saveDatabaseBackupAutomation({ enabled: true, interval_hours: 24, keep_local: 7, keep_remote: 30, passphrase: 'automatic test passphrase', destinations: [] });
  expect(calls.at(-1)?.options.method).toBe('PUT');
  await api.runDatabaseBackupAutomation();
  expect(calls.at(-1)?.path).toBe(`${mount}/api/v1/management/system/database-backup-automation/run`);
  await api.probeDatabaseBackupDestination('remote/one');
  expect(calls.at(-1)?.path).toBe(`${mount}/api/v1/management/system/database-backup-destinations/remote%2Fone/probe`);
  await api.getDatabaseBackupArchives('remote/a&b');
  expect(calls.at(-1)?.path).toBe(`${mount}/api/v1/management/system/database-backup-archives?destination_id=remote%2Fa%26b`);
  await api.inspectDatabaseBackupArchive('remote', 'object', 'archive test passphrase');
  expect(JSON.parse(calls.at(-1)?.options.body as string)).toEqual({ destination_id: 'remote', key: 'object', passphrase: 'archive test passphrase' });
  expect(api.databaseBackupRecoveryProfileUrl()).toBe(`${mount}/api/v1/management/system/database-backup-recovery-profile`);
  expect(api.databaseBackupArchiveDownloadUrl('a/b')).toBe(`${mount}/api/v1/management/system/database-backup-archives/a%2Fb/download`);

});
