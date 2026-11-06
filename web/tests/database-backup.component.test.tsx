import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { expect, it } from 'vitest';
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
  enabled: false, daily_at_minute: 180, keep_local: 7, keep_remote: 30, has_passphrase: false,
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

it('gates automatic backups behind an initial passphrase and saves cloud destinations without leaking secrets', async () => {
  const server = installOmcApi();
  let saved = automatic;
  server.on('PUT', '/management/system/database-backup-automation', (request) => {
    const input = request.body as BackupAutomationInput;
    saved = {
      ...saved,
      ...input,
      has_passphrase: true,
      destinations: input.destinations.map((destination) => ({
        id: destination.id || 'destination-id',
        name: destination.name,
        root: destination.root,
        provider: destination.provider,
        has_config: true,
      })),
    };
    return saved;
  });
  server.on('GET', '/management/system/database-backup-automation', () => saved);
  server.on('GET', '/management/system/database-backups', () => ({ items: [] }));
  renderWithOmc(<DatabaseBackups isDemo={false} />);
  fireEvent.click(screen.getByRole('button', { name: 'Manage backups' }));
  const save = (await screen.findByRole('button', { name: 'Save and turn on' })) as HTMLButtonElement;
  fireEvent.change(screen.getByLabelText('Backup passphrase'), { target: { value: 'scheduled independent passphrase' } });
  fireEvent.change(screen.getByLabelText('Confirm passphrase'), { target: { value: 'scheduled independent passphrase' } });
  fireEvent.click(save);
  await screen.findByLabelText('Daily backup time');
  expect(puts(server)[0]).toEqual({ enabled: true, daily_at_minute: 180, keep_local: 7, keep_remote: 30, destinations: [], passphrase: 'scheduled independent passphrase' });

  fireEvent.click(screen.getByRole('button', { name: 'Add cloud storage' }));
  fireEvent.click(screen.getByRole('button', { name: 'WebDAV' }));
  fireEvent.change(screen.getByLabelText('WebDAV URL'), { target: { value: 'https://fixture.invalid/dav' } });
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'fixture-user' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'fixture-cloud-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Edit connection' });
  expect(puts(server)[1].passphrase).toBeUndefined();
  expect(puts(server)[1].destinations[0].options).toEqual({ url: 'https://fixture.invalid/dav', user: 'fixture-user', pass: 'fixture-cloud-secret' });
});

it('validates a retained cloud archive and binds restore confirmation to the preview digest', async () => {
  const server = installOmcApi();
  let hasPreview = false;
  server.on('GET', '/management/system/database-backup-archives', () => ({ items: [{ key: archiveKey, size_bytes: 4096, created_at_ms: 1_800_000_000_000 }] }));
  server.on('POST', '/management/system/database-backup-archives/inspect', () => { hasPreview = true; return preview; });
  server.on('POST', `/management/system/database-restores/${preview.id}/apply`, () => ({ requires_restart: true }));
  open(server, { ...configured, destinations: [cloud] }, () => (hasPreview ? [preview] : []));
  fireEvent.click(await screen.findByRole('button', { name: /Restore from a backup/ }));
  fireEvent.click(await screen.findByText('Cloud fixture'));
  fireEvent.click(await screen.findByRole('button', { name: 'Restore this' }));
  fireEvent.change(screen.getByLabelText('Backup passphrase'), { target: { value: 'retained archive passphrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Validate backup' }));
  await screen.findByText('Backup validated');
  fireEvent.click(screen.getByRole('button', { name: 'Restore on next restart' }));
  fireEvent.click(within(await screen.findByRole('tooltip')).getByRole('button', { name: 'Restore on next restart' }));
  await waitFor(() => expect(server.requests.find((r) => r.path.endsWith('/apply'))?.body).toEqual({ digest: preview.digest }));
});
