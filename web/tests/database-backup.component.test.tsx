import { fireEvent, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import englishSystem from '../src/i18n/locales/en/system';
import { DatabaseBackups } from '../src/pages/SystemPage/DatabaseBackups';
import type { BackupAutomation, DatabaseBackupJob } from '../src/types/databaseBackup';
import { installOmcApi } from './support/omcApi';
import { renderWithOmc } from './support/render';

const preview: DatabaseBackupJob = {
  id: 'ready-import', kind: 'import', state: 'ready', created_at_ms: 1_800_000_000_000,
  expires_at_ms: 1_800_000_100_000, size_bytes: 4096, digest: 'validated-digest',
  source_version: 'v1.0.0', source_schema_version: 50, backup_created_at_ms: 1_799_999_900_000, has_audit_error: false,
};

it('requires a matching export passphrase and clears it after admission', async () => {
  const server = installOmcApi();
  server.on('GET', '/management/system/database-backup-automation', () => automatic);
  server.on('GET', '/management/system/database-backups', () => ({ items: [{ ...preview, kind: 'export' }] }));
  server.on('POST', '/management/system/database-backups', () => ({ ...preview, kind: 'export' }));
  renderWithOmc(<DatabaseBackups isDemo={false} />);
  expect(server.requests.some((request) => request.path.includes('database-backups'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Manage backups' }));
  fireEvent.click(await screen.findByRole('button', { name: /Download a backup/ }));
  const download = await screen.findByRole('link', { name: 'Download' });
  expect(download.getAttribute('target')).toBe('_blank');
  expect(download.getAttribute('rel')).toContain('noopener');
  const passphrase = await screen.findByLabelText('Backup passphrase');
  const confirmation = screen.getByLabelText('Confirm passphrase');
  const create = screen.getByRole('button', { name: 'Create backup' }) as HTMLButtonElement;
  fireEvent.change(passphrase, { target: { value: 'independent backup passphrase' } });
  expect(create.disabled).toBe(true);
  fireEvent.change(confirmation, { target: { value: 'independent backup passphrase' } });
  expect(create.disabled).toBe(false);
  fireEvent.click(create);
  await waitFor(() => expect(server.requests.some((request) => request.method === 'POST')).toBe(true));
  await waitFor(() => expect((passphrase as HTMLInputElement).value).toBe(''));
  expect(server.requests.find((request) => request.method === 'POST')?.body).toEqual({ passphrase: 'independent backup passphrase' });
});

it('binds restore confirmation to the preview digest and shows that restart is required', async () => {
  const server = installOmcApi();
  server.on('GET', '/management/system/database-backup-automation', () => automatic);
  let isScheduled = false;
  server.on('GET', '/management/system/database-backups', () => ({ items: [{ ...preview, state: isScheduled ? 'scheduled' : 'ready' }] }));
  server.on('POST', `/management/system/database-restores/${preview.id}/apply`, () => {
    isScheduled = true;
    return { requires_restart: true };
  });
  renderWithOmc(<DatabaseBackups isDemo={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage backups' }));
  fireEvent.click(await screen.findByRole('button', { name: /Recent operations/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Restore on next restart' }));
  await screen.findByText('Restore this database backup?');
  expect(server.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  const buttons = screen.getAllByRole('button', { name: 'Restore on next restart' });
  fireEvent.click(buttons[buttons.length - 1]);
  await screen.findByText('Restart required');
  expect(server.requests.find((request) => request.method === 'POST')?.body).toEqual({ digest: preview.digest });
});


it('exposes the completed restore ID and requires confirmation before removing its local recovery files', async () => {
  const server = installOmcApi();
  server.on('GET', '/management/system/database-backup-automation', () => automatic);
  const completed: DatabaseBackupJob = { ...preview, id: '11223344-5566-4788-99aa-bbccddeeff00', state: 'completed' };
  let hasRecoveryFiles = true;
  server.on('GET', '/management/system/database-backups', () => ({ items: hasRecoveryFiles ? [completed] : [] }));
  server.on('DELETE', `/management/system/database-backup-jobs/${completed.id}`, () => {
    hasRecoveryFiles = false;
    return new Response(null, { status: 204 });
  });
  renderWithOmc(<DatabaseBackups isDemo={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage backups' }));
  fireEvent.click(await screen.findByRole('button', { name: /Recent operations/ }));
  await screen.findByText(completed.id);
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  const confirm = await screen.findByRole('button', { name: 'Confirm' });
  expect(server.requests.filter((request) => request.method === 'DELETE')).toHaveLength(0);
  fireEvent.click(confirm);
  await waitFor(() => expect(server.requests.filter((request) => request.method === 'DELETE')).toHaveLength(1));
  await waitFor(() => expect(screen.queryByText(completed.id)).toBeNull());
});

const automatic: BackupAutomation = {
  enabled: false, interval_hours: 24, keep_local: 7, keep_remote: 30, has_passphrase: false,
  destinations: [], next_run_at_ms: 0, last_run_at_ms: 0, last_success_at_ms: 0, last_error: '',
};

it('reveals setup progressively and saves typed connection fields without resending saved secrets', async () => {
  const server = installOmcApi();
  let saved = automatic;
  server.on('GET', '/management/system/database-backups', () => ({ items: [] }));
  server.on('GET', '/management/system/database-backup-automation', () => saved);
  server.on('PUT', '/management/system/database-backup-automation', (request) => {
    const input = request.body as import('../src/types/databaseBackup').BackupAutomationInput;
    saved = { ...saved, ...input, has_passphrase: true, destinations: input.destinations.map((destination) => ({ id: destination.id || 'destination-id', name: destination.name, root: destination.root, provider: destination.provider, has_config: true })) };
    return saved;
  });
  renderWithOmc(<DatabaseBackups isDemo={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage backups' }));
  expect(screen.queryByLabelText('Automatic backup passphrase')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Set up automatic backups' }));
  expect(screen.queryByLabelText('Automatic backup passphrase')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  const secret = screen.getByLabelText('Automatic backup passphrase');
  const confirm = screen.getByLabelText('Confirm passphrase');
  const save = screen.getByRole('button', { name: 'Save backup settings' }) as HTMLButtonElement;
  fireEvent.change(secret, { target: { value: 'scheduled independent passphrase' } });
  expect(save.disabled).toBe(true);
  fireEvent.change(confirm, { target: { value: 'scheduled independent passphrase' } });
  fireEvent.click(save);
  await screen.findByText('Your backup plan is ready');
  expect(server.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
  expect(screen.queryByLabelText('Automatic backup passphrase')).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Back to backups' }).at(-1)!);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit backup plan' }));
  fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: 'confirmation without new passphrase' } });
  expect((screen.getByRole('button', { name: 'Save backup settings' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(await screen.findByRole('button', { name: /Cloud destinations/ }));
  fireEvent.click(screen.getByText('Other storage services'));
  fireEvent.click(screen.getByRole('button', { name: 'WebDAV' }));
  expect(screen.queryByLabelText('Connection settings (JSON)')).toBeNull();
  fireEvent.change(screen.getByLabelText('WebDAV URL'), { target: { value: 'https://fixture.invalid/dav' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'fixture-user' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'fixture-cloud-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('button', { name: 'Edit connection' });
  const sent = server.requests.filter((request) => request.method === 'PUT').at(-1)?.body as import('../src/types/databaseBackup').BackupAutomationInput;
  expect(sent.passphrase).toBeUndefined();
  expect(sent.destinations[0].options).toEqual({ url: 'https://fixture.invalid/dav', user: 'fixture-user', pass: 'fixture-cloud-secret' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit connection' }));
  expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findByRole('button', { name: 'Edit connection' });
  const next = server.requests.filter((request) => request.method === 'PUT').at(-1)?.body as import('../src/types/databaseBackup').BackupAutomationInput;
  expect(next.destinations[0].options).toBeUndefined();
});

it('validates a retained cloud archive before exposing the normal restore confirmation', async () => {
  const server = installOmcApi();
  server.on('GET', '/management/system/database-backup-automation', () => automatic);
  let hasPreview = false;
  const previousRestore = { ...preview, id: 'older-completed-restore', state: 'completed' as const };
  const key = 'omc-11223344-5566-4788-99aa-bbccddeeff00-1800000000000-11223344-5566-4788-99aa-bbccddeeff01.omcbackup';
  server.on('GET', '/management/system/database-backups', () => ({ items: hasPreview ? [previousRestore, preview] : [previousRestore] }));
  server.on('GET', '/management/system/database-backup-automation', () => ({ ...automatic, has_passphrase: true, destinations: [{ id: 'cloud-fixture', name: 'Cloud fixture', provider: 'webdav', root: 'backups', has_config: true }] }));
  server.on('GET', '/management/system/database-backup-archives', () => ({ items: [{ key, size_bytes: 4096, created_at_ms: 1_800_000_000_000 }] }));
  server.on('POST', '/management/system/database-backup-archives/inspect', () => { hasPreview = true; return preview; });
  renderWithOmc(<DatabaseBackups isDemo={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage backups' }));
  fireEvent.click(await screen.findByRole('button', { name: /Restore from a backup/ }));
  const location = await screen.findByLabelText('Backup location');
  fireEvent.mouseDown(location);
  await screen.findByRole('option', { name: 'Cloud fixture' });
  fireEvent.keyDown(location, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 });
  fireEvent.keyDown(location, { key: 'Enter', code: 'Enter', keyCode: 13 });
  fireEvent.click(await screen.findByRole('button', { name: 'Validate backup' }));
  fireEvent.change(screen.getByLabelText('Backup passphrase'), { target: { value: 'retained archive passphrase' } });
  const buttons = screen.getAllByRole('button', { name: 'Validate backup' });
  fireEvent.click(buttons[buttons.length - 1]);
  await screen.findByRole('button', { name: 'Restore on next restart' });
  expect(screen.queryByLabelText('Backup passphrase')).toBeNull();
  expect(screen.queryByText(previousRestore.id)).toBeNull();
  expect(server.requests.filter((r) => r.method === 'POST').map((r) => r.body)).toEqual([{ destination_id: 'cloud-fixture', key, passphrase: 'retained archive passphrase' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Back to backups' }));
  fireEvent.click(await screen.findByRole('button', { name: /Disaster recovery/ }));
  const profile = screen.getByRole('link', { name: 'Download recovery profile' });
  expect(profile.getAttribute('target')).toBe('_blank');
});


it('preserves the server validation refusal instead of blaming the cloud connection', async () => {
  const server = installOmcApi();
  server.on('GET', '/management/system/database-backup-automation', () => automatic);
  const key = 'omc-11223344-5566-4788-99aa-bbccddeeff00-1800000000000-11223344-5566-4788-99aa-bbccddeeff01.omcbackup';
  server.on('GET', '/management/system/database-backups', () => ({ items: [] }));
  server.on('GET', '/management/system/database-backup-automation', () => automatic);
  server.on('GET', '/management/system/database-backup-archives', () => ({ items: [{ key, size_bytes: 4096, created_at_ms: 1_800_000_000_000 }] }));
  server.on('POST', '/management/system/database-backup-archives/inspect', () => new Response(JSON.stringify({ error: 'unsupported schema', code: 'database_backup_version' }), { status: 422, headers: { 'Content-Type': 'application/json' } }));
  renderWithOmc(<DatabaseBackups isDemo={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage backups' }));
  fireEvent.click(await screen.findByRole('button', { name: /Restore from a backup/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Validate backup' }));
  fireEvent.change(screen.getByLabelText('Backup passphrase'), { target: { value: 'archive passphrase fixture' } });
  const buttons = screen.getAllByRole('button', { name: 'Validate backup' });
  fireEvent.click(buttons[buttons.length - 1]);
  await screen.findByText(englishSystem['sys.backup_error_version']);
  expect(screen.queryByText(englishSystem['sys.backup_auto_error'])).toBeNull();
});

it('guides first account authorization and saves only its server-side handle', async () => {
  const server = installOmcApi();
  server.on('GET', '/management/system/database-backups', () => ({ items: [] }));
  server.on('GET', '/management/system/database-backup-automation', () => automatic);
  const authorization = { id: 'cloud-auth-id', status: 'waiting', expires_at_ms: 1_900_000_000_000, authorization_url: 'https://provider.example/authorize?state=fixture-state' };
  server.on('POST', '/management/system/database-backup-authorization', () => authorization);
  server.on('POST', '/management/system/database-backup-authorization/cloud-auth-id/complete', () => ({ ...authorization, status: 'connected', authorization_url: undefined }));
  server.on('PUT', '/management/system/database-backup-automation', () => ({ ...automatic, has_passphrase: true, destinations: [{ id: 'cloud', name: 'Google Drive', provider: 'drive', root: 'OMC Backups', has_config: true }] }));
  renderWithOmc(<DatabaseBackups isDemo={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage backups' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Set up automatic backups' }));
  fireEvent.click(screen.getByRole('button', { name: /Google Drive/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(screen.queryByLabelText('Automatic backup passphrase')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Connect account' }));
  const link = await screen.findByRole('link', { name: 'Open authorization page' });
  expect(link.getAttribute('href')).toBe(authorization.authorization_url);
  await screen.findByRole('button', { name: 'Finish connecting' });
  fireEvent.change(screen.getByLabelText('Browser address after authorization'), { target: { value: 'http://127.0.0.1:53682/?state=fixture-state&code=fixture-code' } });
  fireEvent.click(screen.getByRole('button', { name: 'Finish connecting' }));
  await screen.findByText('Account connected. You can continue.');
  expect(screen.queryByLabelText('Browser address after authorization')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.change(screen.getByLabelText('Automatic backup passphrase'), { target: { value: 'cloud protection passphrase' } });
  fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: 'cloud protection passphrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save backup settings' }));
  await screen.findByText('Your backup plan is ready');
  const saved = server.requests.find((request) => request.method === 'PUT')?.body as import('../src/types/databaseBackup').BackupAutomationInput;
  expect(saved.destinations).toEqual([{ id: '', name: 'Google Drive', provider: 'drive', root: 'OMC Backups', options: {}, authorization_id: 'cloud-auth-id' }]);
  expect(JSON.stringify(saved)).not.toContain('fixture-code');
  expect(server.requests.find((request) => request.path.endsWith('database-backup-authorization'))?.body).toEqual({ provider: 'drive', client_id: '', client_secret: '', automatic_callback: false });
});
