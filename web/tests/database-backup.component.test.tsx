import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import englishSystem from '../src/i18n/locales/en/system';
import { DatabaseBackups } from '../src/pages/SystemPage/DatabaseBackups';
import type { BackupAutomation, BackupAutomationInput, DatabaseBackupJob } from '../src/types/databaseBackup';
import { installOmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';

const preview: DatabaseBackupJob = {
  id: 'ready-import', kind: 'import', state: 'ready', created_at_ms: 1_800_000_000_000,
  expires_at_ms: 1_800_000_100_000, size_bytes: 4096, digest: 'validated-digest',
  source_version: 'v1.0.0', source_schema_version: 50, backup_created_at_ms: 1_799_999_900_000, has_audit_error: false,
};
const automatic: BackupAutomation = {
  enabled: false, interval_hours: 24, keep_local: 7, keep_remote: 30, has_passphrase: false,
  destinations: [], next_run_at_ms: 0, last_run_at_ms: 0, last_success_at_ms: 0, last_error: '',
};
const configured: BackupAutomation = { ...automatic, enabled: true, has_passphrase: true };
const cloud = { id: 'cloud-fixture', name: 'Cloud fixture', provider: 'webdav' as const, root: 'backups', has_config: true };
const archiveKey = 'omc-11223344-5566-4788-99aa-bbccddeeff00-1800000000000-11223344-5566-4788-99aa-bbccddeeff01.omcbackup';

function open(server: ReturnType<typeof installOmcApi>, value: BackupAutomation, jobs: () => DatabaseBackupJob[] = () => []) {
  server.on('GET', '/management/system/database-backup-automation', () => value);
  server.on('GET', '/management/system/database-backups', () => ({ items: jobs() }));
  renderWithOmc(<DatabaseBackups isDemo={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage backups' }));
}
const puts = (server: ReturnType<typeof installOmcApi>) =>
  server.requests.filter((request) => request.method === 'PUT').map((request) => request.body as BackupAutomationInput);

it('requires a matching export passphrase and clears it after admission', async () => {
  const server = installOmcApi();
  server.on('POST', '/management/system/database-backups', () => ({ ...preview, kind: 'export' }));
  open(server, configured, () => [{ ...preview, kind: 'export' }]);
  fireEvent.click(await screen.findByRole('button', { name: /Export a backup file/ }));
  const download = await screen.findByRole('link', { name: /Download/ });
  expect(download.getAttribute('target')).toBe('_blank');
  expect(download.getAttribute('rel')).toContain('noopener');
  const passphrase = screen.getByLabelText('Backup passphrase');
  const confirmation = screen.getByLabelText('Confirm passphrase');
  const create = screen.getByRole('button', { name: 'Create backup file' }) as HTMLButtonElement;
  fireEvent.change(passphrase, { target: { value: 'independent backup passphrase' } });
  expect(create.disabled).toBe(true);
  fireEvent.change(confirmation, { target: { value: 'independent backup passphrase' } });
  expect(create.disabled).toBe(false);
  fireEvent.click(create);
  await waitFor(() => expect((passphrase as HTMLInputElement).value).toBe(''));
  expect(server.requests.find((request) => request.method === 'POST')?.body).toEqual({ passphrase: 'independent backup passphrase' });
});

it('binds restore confirmation to the preview digest and shows that restart is required', async () => {
  const server = installOmcApi();
  let isScheduled = false;
  server.on('POST', `/management/system/database-restores/${preview.id}/apply`, () => {
    isScheduled = true;
    return { requires_restart: true };
  });
  open(server, configured, () => [{ ...preview, state: isScheduled ? 'scheduled' : 'ready' }]);
  fireEvent.click(await screen.findByRole('button', { name: /Recent operations/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Restore on next restart' }));
  await screen.findByText('Restore this database backup?');
  expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  fireEvent.click(screen.getAllByRole('button', { name: 'Restore on next restart' }).at(-1)!);
  await screen.findByText('Restart required');
  expect(server.requests.find((request) => request.method === 'POST')?.body).toEqual({ digest: preview.digest });
});

it('exposes the completed restore ID and requires confirmation before removing its local recovery files', async () => {
  const server = installOmcApi();
  const completed: DatabaseBackupJob = { ...preview, id: '11223344-5566-4788-99aa-bbccddeeff00', state: 'completed' };
  let hasRecoveryFiles = true;
  server.on('DELETE', `/management/system/database-backup-jobs/${completed.id}`, () => {
    hasRecoveryFiles = false;
    return new Response(null, { status: 204 });
  });
  open(server, configured, () => (hasRecoveryFiles ? [completed] : []));
  fireEvent.click(await screen.findByRole('button', { name: /Recent operations/ }));
  await screen.findByText(completed.id);
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  const confirm = await screen.findByRole('button', { name: 'Confirm' });
  expect(server.requests.filter((request) => request.method === 'DELETE')).toHaveLength(0);
  fireEvent.click(confirm);
  await waitFor(() => expect(server.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1));
  await waitFor(() => expect(screen.queryByText(completed.id)).toBeNull());
});

it('opens on the passphrase, turns the schedule on with it and then folds the form away', async () => {
  const server = installOmcApi();
  let saved = automatic;
  server.on('PUT', '/management/system/database-backup-automation', (request) => {
    saved = { ...saved, ...(request.body as BackupAutomationInput), has_passphrase: true, destinations: [] };
    return saved;
  });
  server.on('GET', '/management/system/database-backup-automation', () => saved);
  server.on('GET', '/management/system/database-backups', () => ({ items: [] }));
  renderWithOmc(<DatabaseBackups isDemo={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage backups' }));
  expect(screen.queryByRole('button', { name: 'Back up now' })).toBeNull();
  const save = (await screen.findByRole('button', { name: 'Save and turn on' })) as HTMLButtonElement;
  expect(screen.queryByRole('switch', { name: 'Automatic backups' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Backup passphrase'), { target: { value: 'scheduled independent passphrase' } });
  fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: 'scheduled independent passphras' } });
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: 'scheduled independent passphrase' } });
  fireEvent.click(save);
  await screen.findByRole('button', { name: 'Back up now' });
  expect(puts(server)).toEqual([{ enabled: true, interval_hours: 24, keep_local: 7, keep_remote: 30, destinations: [], passphrase: 'scheduled independent passphrase' }]);
  expect(screen.queryByLabelText('Backup passphrase')).toBeNull();
  expect((screen.getByRole('switch', { name: 'Automatic backups' }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
});

it('says why the local disk cannot be switched off while it is the only location', async () => {
  const server = installOmcApi();
  open(server, { ...configured, destinations: [] });
  const local = (await screen.findByRole('switch', { name: 'Local disk' })) as HTMLButtonElement;
  expect(local.disabled).toBe(true);
  const reason = document.getElementById(local.getAttribute('aria-describedby') ?? '');
  expect(reason?.textContent).toBe('Add a cloud location first');
  fireEvent.click(screen.getByRole('button', { name: 'Add cloud storage' }));
  expect(screen.getByRole('button', { name: 'OneDrive' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Google Drive' })).toBeTruthy();
});

it('adds a typed connection, then lets the local disk go, without resending saved secrets', async () => {
  const server = installOmcApi();
  let saved = configured;
  server.on('PUT', '/management/system/database-backup-automation', (request) => {
    const input = request.body as BackupAutomationInput;
    saved = { ...saved, ...input, destinations: input.destinations.map((destination) => ({ id: destination.id || 'destination-id', name: destination.name, root: destination.root, provider: destination.provider, has_config: true })) };
    return saved;
  });
  server.on('GET', '/management/system/database-backup-automation', () => saved);
  server.on('GET', '/management/system/database-backups', () => ({ items: [] }));
  renderWithOmc(<DatabaseBackups isDemo={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage backups' }));
  // With nowhere else to keep backups, the local disk cannot be switched off.
  expect(((await screen.findByRole('switch', { name: 'Local disk' })) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Add cloud storage' }));
  fireEvent.click(screen.getByRole('button', { name: 'WebDAV' }));
  fireEvent.change(screen.getByLabelText('WebDAV URL'), { target: { value: 'https://fixture.invalid/dav' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'fixture-user' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'fixture-cloud-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  const edit = await screen.findByRole('button', { name: 'Edit connection' });
  expect(puts(server)[0].passphrase).toBeUndefined();
  expect(puts(server)[0].destinations[0].options).toEqual({ url: 'https://fixture.invalid/dav', user: 'fixture-user', pass: 'fixture-cloud-secret' });
  fireEvent.click(edit);
  expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Edit connection' });
  expect(puts(server).at(-1)?.destinations[0].options).toBeUndefined();
  const local = screen.getByRole('switch', { name: 'Local disk' }) as HTMLButtonElement;
  expect(local.disabled).toBe(false);
  fireEvent.click(local);
  await waitFor(() => expect(puts(server)).toHaveLength(3));
  expect(puts(server)[2]).toMatchObject({ keep_local: 0, destinations: [{ id: 'destination-id', provider: 'webdav' }] });
  expect(puts(server)[2].passphrase).toBeUndefined();
});

it('validates a retained cloud archive before exposing the restore confirmation', async () => {
  const server = installOmcApi();
  let hasPreview = false;
  const previousRestore = { ...preview, id: 'older-completed-restore', state: 'completed' as const };
  server.on('GET', '/management/system/database-backup-archives', () => ({ items: [{ key: archiveKey, size_bytes: 4096, created_at_ms: 1_800_000_000_000 }] }));
  server.on('POST', '/management/system/database-backup-archives/inspect', () => { hasPreview = true; return preview; });
  server.on('POST', `/management/system/database-restores/${preview.id}/apply`, () => ({ requires_restart: true }));
  open(server, { ...configured, destinations: [cloud] }, () => (hasPreview ? [previousRestore, preview] : [previousRestore]));
  fireEvent.click(await screen.findByRole('button', { name: 'More settings' }));
  expect((await screen.findByRole('link', { name: /Download/ })).getAttribute('target')).toBe('_blank');
  fireEvent.click(await screen.findByRole('button', { name: /Restore from a backup/ }));
  fireEvent.click(await screen.findByText('Cloud fixture'));
  fireEvent.click(await screen.findByRole('button', { name: 'Restore this' }));
  fireEvent.change(screen.getByLabelText('Backup passphrase'), { target: { value: 'retained archive passphrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Validate backup' }));
  await screen.findByText('Backup validated');
  expect(screen.queryByLabelText('Backup passphrase')).toBeNull();
  expect(screen.queryByText(previousRestore.id)).toBeNull();
  expect(server.requests.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([{ destination_id: cloud.id, key: archiveKey, passphrase: 'retained archive passphrase' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Restore on next restart' }));
  fireEvent.click(within(await screen.findByRole('tooltip')).getByRole('button', { name: 'Restore on next restart' }));
  await waitFor(() => expect(server.requests.find((r) => r.path.endsWith('/apply'))?.body).toEqual({ digest: preview.digest }));
});

it('preserves the server validation refusal instead of blaming the cloud connection', async () => {
  const server = installOmcApi();
  server.on('GET', '/management/system/database-backup-archives', () => ({ items: [{ key: archiveKey, size_bytes: 4096, created_at_ms: 1_800_000_000_000 }] }));
  server.on('POST', '/management/system/database-backup-archives/inspect', () => new Response(JSON.stringify({ error: 'unsupported schema', code: 'database_backup_version' }), { status: 422, headers: { 'Content-Type': 'application/json' } }));
  open(server, configured);
  fireEvent.click(await screen.findByRole('button', { name: /Restore from a backup/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Restore this' }));
  fireEvent.change(screen.getByLabelText('Backup passphrase'), { target: { value: 'archive passphrase fixture' } });
  fireEvent.click(screen.getByRole('button', { name: 'Validate backup' }));
  await screen.findByText(englishSystem['sys.backup_error_version']);
  expect(screen.queryByText(englishSystem['sys.backup_auto_error'])).toBeNull();
});

it('guides first account authorization and saves only its server-side handle', async () => {
  const server = installOmcApi();
  const authorization = { id: 'cloud-auth-id', status: 'waiting', expires_at_ms: 1_900_000_000_000, authorization_url: 'https://provider.example/authorize?state=fixture-state' };
  server.on('POST', '/management/system/database-backup-authorization', () => authorization);
  server.on('POST', '/management/system/database-backup-authorization/cloud-auth-id/complete', () => ({ ...authorization, status: 'connected', authorization_url: undefined }));
  server.on('PUT', '/management/system/database-backup-automation', () => ({ ...configured, destinations: [{ id: 'cloud', name: 'Google Drive', provider: 'drive', root: 'OMC Backups', has_config: true }] }));
  open(server, configured);
  fireEvent.click(await screen.findByRole('button', { name: 'Add cloud storage' }));
  fireEvent.click(screen.getByRole('button', { name: 'Google Drive' }));
  fireEvent.click(screen.getByRole('button', { name: 'Connect account' }));
  const link = await screen.findByRole('link', { name: 'Open sign-in page' });
  expect(link.getAttribute('href')).toBe(authorization.authorization_url);
  fireEvent.change(await screen.findByLabelText('Browser address after authorization'), { target: { value: 'http://127.0.0.1:53682/?state=fixture-state&code=fixture-code' } });
  fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /Finish connecting/ })));
  await screen.findByText('Account connected. You can continue.');
  expect(server.requests.find((request) => request.method === 'POST' && request.path.endsWith('/complete'))?.body).toEqual({ callback_url: 'http://127.0.0.1:53682/?state=fixture-state&code=fixture-code' });
  expect(screen.queryByLabelText('Browser address after authorization')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(puts(server)).toHaveLength(1));
  expect(puts(server)[0].destinations).toEqual([{ id: '', name: 'Google Drive', provider: 'drive', root: 'OMC Backups', options: {}, authorization_id: 'cloud-auth-id' }]);
  expect(JSON.stringify(puts(server)[0])).not.toContain('fixture-code');
  expect(server.requests.find((request) => request.path.endsWith('database-backup-authorization'))?.body).toEqual({ provider: 'drive', client_id: '', client_secret: '', automatic_callback: false });
});
