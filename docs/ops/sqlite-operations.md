# SQLite Operations & Runbook

This runbook is intended for system administrators and operators running Oh My CPA in production environments. It covers daily backups, disaster recovery drills, encryption key governance, migration safety gates, and storage maintenance for a single-replica SQLite database operating in WAL mode.

---

## 1. Core Architecture Constraints & Single-Replica Invariants

1. **Exclusive Single-Writer Principle**:
   - Oh My CPA's persistence layer uses embedded SQLite with Write-Ahead Logging (`journal_mode=WAL`) and `busy_timeout=5000`;
   - Sharing the `/data` directory across multiple Oh My CPA replicas via network filesystems (NFS, SMB/CIFS, GlusterFS) is strictly prohibited;
   - In container orchestrators (such as Kubernetes or Docker Swarm/Compose), ensure that at most one replica is scheduled at any time (e.g. using `strategy: { type: Recreate }` in Kubernetes deployments).

2. **WAL Triad Integrity**:
   - The data directory contains three tightly-coupled files: `oh-my-cpa.db` (primary database), `oh-my-cpa.db-wal` (write-ahead log), and `oh-my-cpa.db-shm` (shared-memory index);
   - Copying `oh-my-cpa.db` alone while the service is actively running can omit transactions that exist only in the `-wal` file, producing an incomplete or inconsistent snapshot.

3. **Single-Connection Design**:
   - The Go connection pool is fixed to `MaxOpenConns(1)` and `MaxIdleConns(1)`, with `busy_timeout=5000`, `foreign_keys=1`, `journal_mode=WAL`, and `synchronous=NORMAL`;
   - Concurrent writes are serialized inside the application process rather than relying on SQLite lock retries.

4. **Demo mode is outside every rule above, and the runbook is not about it**:
   - A deployment with `OMCPA_DEMO_MODE=true` uses its own file, `oh-my-cpa-demo.db`, in the same data directory, and deletes it plus its WAL siblings on every boot. Nothing in it is worth backing up, restoring or migrating, and the file has its own name so that a demo pointed at a directory holding real data cannot have that data deleted with it (`internal/demo.ResetDatabase`);
   - The rest of this runbook describes the self-hosted database. Keep `docs/ops/cloudflare-demo.md` for the demo's own operations.

---

## 2. Safe Online & Cold Backup Strategies

### 2.1 Online Backups via SQLite `VACUUM INTO`

While the service continues processing read and write requests, a consistent snapshot can be generated using SQLite's `VACUUM INTO` command. Note that the minimal production Alpine container does not include the `sqlite3` CLI; run this command on the host targeting the volume mount directory, or from an administrative sidecar container:

```bash
# Executed on the host targeting the volume mount directory:
BACKUP_DIR="/path/to/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "${BACKUP_DIR}" && chmod 700 "${BACKUP_DIR}"

sqlite3 /path/to/data/oh-my-cpa.db "VACUUM INTO '${BACKUP_DIR}/oh-my-cpa-backup-${TIMESTAMP}.db';"
chmod 600 "${BACKUP_DIR}/oh-my-cpa-backup-${TIMESTAMP}.db"
```

**Semantics**: `VACUUM INTO` reads committed pages from the main database and WAL, producing a single, self-contained, transactionally consistent SQLite snapshot once the operation finishes successfully. It does not include uncommitted transactions, nor does it checkpoint or truncate the active source `-wal` file. If `<database-path>.key` exists, keep a private copy beside the raw snapshot; it is needed with the deployment master key to decrypt the snapshot's protected fields. Console exports below package this recovery material automatically.

### 2.2 Cold Backup Procedure (Scheduled Maintenance)

When performing scheduled maintenance during an offline window:

1. Gracefully stop the Oh My CPA service container:
   ```bash
   docker compose --env-file deploy/.env -f deploy/compose.full.yml stop oh-my-cpa
   ```
2. Wait for the process to exit completely. On `SIGTERM`, the Go process stops accepting HTTP traffic and closes the database connection; SQLite checkpoints pending WAL pages and cleans up `-wal` and `-shm` files upon closing the final handle.
3. Archive the entire data directory to a destination outside the source data directory:
   ```bash
   BACKUP_DIR="/path/to/backups"
   TIMESTAMP=$(date +%Y%m%d_%H%M%S)
   mkdir -p "${BACKUP_DIR}" && chmod 700 "${BACKUP_DIR}"

   tar -czf "${BACKUP_DIR}/omc-data-${TIMESTAMP}.tar.gz" -C /path/to/data .
   sha256sum "${BACKUP_DIR}/omc-data-${TIMESTAMP}.tar.gz" > "${BACKUP_DIR}/omc-data-${TIMESTAMP}.sha256"
   chmod 600 "${BACKUP_DIR}/omc-data-${TIMESTAMP}.tar.gz" "${BACKUP_DIR}/omc-data-${TIMESTAMP}.sha256"
   ```


### 2.3 Console backups and whole-database restore

Open **System Information → Database → Manage backups** to create an encrypted
`.omcbackup` file or upload one for validation. The file contains a consistent
snapshot of the complete OMC SQLite database, including retained usage, locked
cost history, audit records and database-backed assets. It does not include CPA's
configuration or authentication directory, or deployment environment.

Backup validation requires the shipped migrations through the snapshot's schema
version and rejects schemas newer than the running binary. It preserves retained
historical migration records, including development-branch records handled by
forward repairs; their presence does not make an otherwise supported backup
incompatible.

Keep the backup passphrase safe and separate from the backup. The passphrase
protects both the database and its encryption/HMAC key inside the authenticated
file; no source master key or CPA management key is needed for recovery. Treat
possession of the backup and its passphrase as access to all database secrets.

On restore, OMC wraps the recovered database key with the target deployment's
configured `OMCPA_MASTER_KEY` and stores it privately at `<database-path>.key`.
Subsequent starts automatically use that key for database secrets and historical
identities. Keep this file with the database when copying raw SQLite files; the
target deployment master key is still required to open those local files. A
normal encrypted export includes everything needed for another passphrase-only
recovery. Deployment configuration, console sign-in and updater authentication
remain those of the target environment.

An uploaded file is decrypted, checked and, where supported, migrated in a private
staging directory. Confirming it **schedules replacement on the next normal OMC
startup**; it does not modify the running database. Restart OMC through your normal
service manager after confirmation. The console can cancel the pending restore
before restart. Target deployment environment variables still take precedence
when the restored application starts.

Before replacement, startup creates and verifies an encrypted rollback backup of
the stopped database and preserves its closed main/WAL/SHM files and local key
envelope. A small restore journal allows an interrupted, uncommitted replacement to restore that previous
file set on the next startup. The restored database must accept the completion
audit before it is committed. If preparation fails, startup stops without replacing
the current database; cancel the pending task with the command below to resume it.

**Recovery rolls back the OMC data timeline.** Data recorded after the selected
snapshot is absent from the restored database. CPA is not rewound with it, and
already-consumed usage records cannot be assumed to be available for replay.
The pre-restore rollback backup retains the previous history; the restored
database records the restore event rather than merging audit timelines.

Exports are temporary downloads. Expired exports and unconfirmed uploads are
cleaned at startup or when another operation is created. Completed restore jobs
and their rollback files remain until explicitly removed. Files live beside the
database under `<database-path>.recovery/`, with private directory/file permissions.
The console's recent-operations list owns removal and pending-restore cancellation.

#### Offline command

The same binary supports recovery without a working console or CPA connection.
Inspection needs only the file and passphrase; export and restore use the target
deployment's normal environment for local storage protection.
Stop OMC first; the server and this command share an exclusive database lock.
Supply a private passphrase file rather than putting the secret in shell arguments:

```bash
# Use the deployment's normal environment, including OMCPA_DATA_DIR and OMCPA_MASTER_KEY.
oh-my-cpa database export --output /backup/omc.omcbackup --passphrase-file /secure/backup-passphrase
oh-my-cpa database inspect --file /backup/omc.omcbackup --passphrase-file /secure/backup-passphrase
oh-my-cpa database restore --file /backup/omc.omcbackup --passphrase-file /secure/backup-passphrase --confirm

# Cancel a restore that could not be prepared, then start OMC normally.
oh-my-cpa database cancel

# Restore the encrypted pre-restore copy, using a restore job ID from the console.
# This local copy is protected with the target deployment master key.
oh-my-cpa database restore --rollback-id <restore-job-id> --confirm
```

For Docker Compose installations, stop the OMC service and run the same command
through its existing service definition, preserving its environment and data mount:
`docker compose --env-file deploy/.env -f deploy/compose.full.yml run --rm --no-deps oh-my-cpa database cancel`, for example.

A restore into an existing database refuses to proceed if its rollback snapshot
cannot be created. For a damaged database that cannot be read, preserve the stopped
main/WAL/SHM set in a separate directory first, as in the recovery procedures below,
then restore into a clean database path. The command can initialize that path from
the encrypted backup.

### 2.4 Automatic backups and cloud recovery

System → storage card → **Manage backups** opens the backup panel: a dialog for
the daily time, passphrase and locations, then nothing else. The passphrase is set
once through a guided form and is required before scheduling or any backup can run.
Storage locations are checkboxes - the local disk, one or more cloud accounts, or cloud
only - and each cloud account's connection is edited in its own dialog rather than a
deeper page in the panel. The daily run starts at a wall-clock time of day (`daily_at_minute`,
minute precision) in the server's location, not after an elapsed interval. A persisted due time coalesces downtime into one overdue run on
startup. The existing single backup worker prevents overlap with exports or
restores; a due run waits for the worker to become available. A pending restore
continues to block backup work until restart or cancellation.

Automatic copies live beside the database in `<database-path>.backups`, independently
of temporary export jobs. Only this schedule's named artifacts count toward its
retention. Local retention applies after a successful local copy, even during a
cloud outage. Local retention can be switched off (`keep_local: 0`) when at least one
cloud destination is configured: the local file is then only the upload source and is
removed once every destination holds it. If any destination fails, the newest local
copy stays as the recovery copy until a later run reaches every destination. Each successful cloud upload is downloaded and SHA-256 checked before
that destination's older copies are removed. This deliberately costs a full
read-back transfer; account for provider traffic charges. Failed uploads do not
prune existing remote copies. The console shows the last complete success and a
failed-run notice rather than treating a partial delivery as full success.

Cloud transport embeds the pinned rclone Go module and only the backends imported
by [`rclone_destination.go`](../../internal/backup/rclone_destination.go). The
[`Destination`](../../internal/backup/destination.go) boundary receives completed
encrypted artifacts, never a database handle. This keeps Docker and native
installations self-contained, with no additional Compose service, executable,
mount capability or port. Rclone does not promise a stable Go API: dependency
updates must exercise the adapter and no-CGO target builds. Its module constraints
also raise the SQLite driver version; migration and repository tests cover that
integration rather than assuming the change affects only networking.

Add a destination using the fields for that storage service. Root paths are
provider-specific: S3/R2 uses `bucket/prefix`, SMB uses `share/path`, and WebDAV
uses a directory below its configured URL. Connection credentials, the backup
passphrase and refreshed OAuth tokens are encrypted in a dedicated database record.
Ordinary responses return summaries only, and read-only SQL cannot query that
record. Blank connection fields preserve their saved values. Changing the backup
passphrase affects only future files; retain earlier passphrases for older copies.
The accepted transport options are restricted in the adapter source.

Google Drive and OneDrive use the **Connect account** wizard. The default uses the
application identity registered by the embedded rclone backend; the cloud consent
page therefore names rclone. Google Drive requests access to files created or opened
with that application; OneDrive requests file read/write and offline access. The
server exchanges the authorization code, discovers the user's default OneDrive and
keeps tokens out of browser responses. Refreshed tokens are saved in the encrypted
record, and persistence failure is reported.

For a remote OMC server, the shared application's registered callback is a loopback
address on the browser's computer. After consent, copy the resulting address from
the browser address bar into the wizard, even when that page cannot connect. OMC
validates its callback address, one-time state and PKCE verifier before exchanging
the code; it never fetches the pasted URL. This flow needs the existing OMC port
only. Authorization sessions expire after fifteen minutes and remain in server
memory until the connection is saved or cancelled.

Operators with their own OAuth application can expand the optional application
settings and register the callback URL shown there. With automatic return enabled,
the provider calls that OMC URL and the original wizard observes completion. The
[callback](../../internal/api/management_database_oauth.go) deliberately requires no
console session cookie: a cross-site provider redirect must instead match an
unexpired authorization state and complete its PKCE-protected exchange. Tokens stay
on the server. Success returns a 303 redirect to the system page without the provider
response parameters. The callback works under the configured base path; a server
restart requires starting authorization again.

SFTP requires an independently verified server public key. FTP without TLS exposes
transport credentials; use FTPS or SFTP when available. Connection testing is
non-mutating and does not prove write permissions.

#### Recover after losing the server and database

Download the **recovery profile** and keep it away from the data directory, together
with an independently stored backup passphrase. The `.omcrecovery` profile contains
cloud connection settings encrypted with that passphrase, but no deployment key or
plaintext passphrase. Re-export after changing credentials or reauthorizing an
account. OAuth providers can revoke or rotate refresh tokens, so retain independent
access to the cloud account as well; an old profile is not a guarantee of perpetual
cloud access.

On a clean machine, the OMC binary can list and retrieve cloud artifacts without
opening or creating the target database and without its original master key:

```bash
# First list destination IDs in the encrypted profile.
oh-my-cpa database remote-list --profile /secure/omc.omcrecovery --passphrase-file /secure/backup-passphrase
# Then list backups at one destination and fetch a selected object.
oh-my-cpa database remote-list --profile /secure/omc.omcrecovery --passphrase-file /secure/backup-passphrase --destination <destination-id>
oh-my-cpa database fetch --profile /secure/omc.omcrecovery --passphrase-file /secure/backup-passphrase --destination <destination-id> --object <backup-object-name> --output /backup/recovered.omcbackup
# Inspect, then restore using the new deployment's normal environment.
oh-my-cpa database inspect --file /backup/recovered.omcbackup --passphrase-file /secure/backup-passphrase
oh-my-cpa database restore --file /backup/recovered.omcbackup --passphrase-file /secure/backup-passphrase --confirm
```

Keep the profile file writable during remote recovery: refreshed cloud tokens are
saved back to its encrypted envelope. Fetch refuses to overwrite an existing output.
Local export, inspect and restore still require stopping OMC; remote-list and fetch
do not need its database lock. On Windows, protect the passphrase file using the
account's filesystem ACL; Unix deployments also enforce private mode bits.

In a working console, select local or cloud retained backups and validate one with
its own passphrase. This creates the same restore preview as an uploaded file; the
existing explicit confirmation, startup-only application, required audit and
pre-restore rollback copy still apply. Cloud delivery never automatically restores
the live database. Every completed restore keeps saved destinations and the
passphrase, but disables automatic scheduling and assigns a new retention
namespace. Review the cloud targets and re-enable the schedule explicitly. This
also applies to restores from rollback files; a recovery drill cannot prune the
source installation's backup family.

---

## 3. Disaster Recovery Drill (Restore Runbook)

When recovering from host failures or database corruption, choose the procedure matching your backup artifact:

### 3.1 Restoring from a `VACUUM INTO` Snapshot (`.db`)

1. **Stop the service container**:
   ```bash
   docker compose --env-file deploy/.env -f deploy/compose.full.yml stop oh-my-cpa
   ```

2. **Verify snapshot integrity on the host**:
   ```bash
   sqlite3 /path/to/backups/oh-my-cpa-backup-YYYYMMDD_HHMMSS.db "PRAGMA integrity_check;"
   # Expected output must be: "ok"
   ```

3. **Replace the data directory safely**:
   - Move the damaged data directory aside to ensure no stale `-wal` or `-shm` files attach to the restored database:
     ```bash
     mv /path/to/data "/path/to/data_damaged_$(date +%Y%m%d_%H%M%S)"
     mkdir -p /path/to/data
     ```
   - Copy the verified snapshot as `oh-my-cpa.db`:
     ```bash
     cp /path/to/backups/oh-my-cpa-backup-YYYYMMDD_HHMMSS.db /path/to/data/oh-my-cpa.db
     ```
   - If the raw snapshot came from a restored installation with a `.key` envelope,
     copy that matching envelope to `/path/to/data/oh-my-cpa.db.key` as well and
     retain the deployment master key that protects it.
   - Set ownership to the container user (`10001:10001` per Dockerfile) and restrict permissions:
     ```bash
     chown -R 10001:10001 /path/to/data
     chmod 700 /path/to/data
     chmod 600 /path/to/data/oh-my-cpa.db
     ```

### 3.2 Restoring from a Cold Tarball (`.tar.gz`)

1. **Stop the service container**:
   ```bash
   docker compose --env-file deploy/.env -f deploy/compose.full.yml stop oh-my-cpa
   ```

2. **Verify archive checksum**:
   ```bash
   cd /path/to/backups
   sha256sum -c omc-data-YYYYMMDD_HHMMSS.sha256
   ```

3. **Unpack to a clean directory**:
   - Move the damaged directory aside:
     ```bash
     mv /path/to/data "/path/to/data_damaged_$(date +%Y%m%d_%H%M%S)"
     mkdir -p /path/to/data
     ```
   - Extract the verified tarball:
     ```bash
     tar -xzf /path/to/backups/omc-data-YYYYMMDD_HHMMSS.tar.gz -C /path/to/data
     chown -R 10001:10001 /path/to/data
     chmod 700 /path/to/data
     ```

### 3.3 Understanding Encrypted Migration Backups (`backups/*.db.enc`)

Migration backups under `OMCPA_DATA_DIR/backups/` are encrypted with the application's
active database cipher (see section 4), with a `.sha256` sidecar. They cannot be
opened directly by `sqlite3`. New backups use a versioned streaming `age` payload
whose file key is wrapped with the database cipher; the reader still accepts the
older AES-GCM JSON format. Older OMC versions cannot read the streaming format.
These internal migration recovery points are separate from passphrase-protected
`.omcbackup` exports.

### 3.4 Verify Service Readiness After Restoration

Start the container, read its normalized mount path, and inspect the health endpoint:

```bash
docker compose --env-file deploy/.env -f deploy/compose.full.yml start oh-my-cpa
BASE_PATH=$(docker compose --env-file deploy/.env -f deploy/compose.full.yml \
  exec -T oh-my-cpa sh /usr/local/bin/omc-base-path)
```

- When accessing via an operator-owned HTTPS ingress, where `BASE_PATH` is the container's normalized `OMCPA_BASE_PATH` (empty at the site root):
  ```bash
  PUBLIC_ORIGIN=https://console.example.com
  curl -sf "${PUBLIC_ORIGIN}${BASE_PATH}/api/healthz" | jq .
  ```
- When accessing directly on the host (both Compose files publish loopback ports):
  ```bash
  curl -sf "http://127.0.0.1:8080${BASE_PATH}/api/healthz" | jq .
  ```
- Or via container exec:
  ```bash
  docker compose --env-file deploy/.env -f deploy/compose.full.yml exec -T oh-my-cpa \
    sh -c 'path=$(sh /usr/local/bin/omc-base-path); wget -q -O - "http://127.0.0.1:8080${path}/api/healthz"' | jq .
  ```

Confirm the JSON response reports `"database_status": "ok"` and `"status": "ok"` (or `"degraded"` if CPA is temporarily offline).

---

## 4. `OMCPA_MASTER_KEY` Governance & Disaster Prevention

- **Role of the Master Key**:
  `OMCPA_MASTER_KEY` is a high-entropy deployment key (e.g. 64 hexadecimal characters).
  Initially it directly protects database secrets and identity HMACs. After a
  portable database restore, it protects the local `.key` envelope instead, while
  the recovered database cipher preserves the source secrets and identities.
- **Consequences of Loss**:
  Losing the deployment key, or a restored database's matching `.key` envelope,
  prevents local decryption. Recovery remains possible from a complete
  `.omcbackup` file and its passphrase. Without either usable local key material
  or that encrypted recovery package, protected fields are unrecoverable.
- **Operational Requirements**:
  1. Never commit plaintext keys to code repositories or Dockerfiles;
  2. Inject keys via secure environment variables, secret managers, or orchestration vaults;
  3. Keep an offline, dual-custody backup in a password vault (such as 1Password, HashiCorp Vault, or a secure physical envelope).

---

## 5. Pre-Migration Safety Gates & Forward Rollbacks

When upgrading Oh My CPA, the application automatically inspects and applies unexecuted immutable SQL migration scripts at startup:

1. **Automated Safety Gates**:
   - **Restart Cleanup and Disk Space**: Before checking space or taking another snapshot, startup removes abandoned migration workspaces and prunes excess migration backups. The default space estimate covers a snapshot or restored copy alongside the encrypted artifact, including committed WAL pages and encryption overhead; the policy lives in [`internal/repository/migration_backup.go`](../../internal/repository/migration_backup.go);
   - **Pre-Migration Encrypted Backup**: Existing databases with recorded migrations receive a `VACUUM INTO` snapshot, including committed WAL frames even when a reader blocks checkpointing. Encryption and restore verification stream through bounded buffers rather than loading the whole database into Go memory. Work stays in a private directory on the writable backup volume (permissions `0700/0600`), so a read-only root needs no writable `/tmp`;
   - **Restore Smoke Test and Publication**: The encrypted artifact and checksum are verified, and the decrypted SQLite schema must be readable, before a backup is published or any migration runs. The snapshot is removed before restore verification to avoid holding two plaintext copies on disk. Failure aborts migration; an interrupted attempt's workspace is removed on the next attempt. Previously completed recovery points are retained while the new copy is checked;
   - **Retention**: The policy supplied to `repository.WithMigrationBackup` runs before each attempt and after publication. A restart during verification cannot accumulate new published backups; a restart just after publication is brought back within retention before another copy is made;
   - **Startup Diagnostics**: Service logs identify cleanup, snapshot, encryption, verification and completion stages, followed by start/completion records for each migration.
2. **Expand / Contract Schema Evolution**:
   - Schema modifications strictly adhere to expand-first principles, avoiding breaking older query shapes.
3. **Forward-Only Rollbacks**:
   - In production, rolling back by manually editing `schema_migrations` or rewinding schema files is strictly prohibited;
   - If a defect is discovered in a migration, deploy a forward-fixing migration (e.g. `008_fix_xxx.sql`) to correct the schema.

---

## 6. Data Retention & Periodic Maintenance

1. **Usage data lifecycle (`internal/repository/lifecycle.go`)**:
   - Every table declares its lifecycle in `TABLE_LIFECYCLES` (`permanent`, `rolling`, `owner_bounded` or `replaced`), enforced by `TestEveryTableDeclaresItsLifecycle`.
   - **Permanent (`usage_facts_15m`, `usage_facts_daily`, `usage_facts_local_daily`)**: Aggregated dashboard and Insights buckets. They grow with distinct model/credential/key combinations per bucket rather than raw request volume, and are never pruned. `usage_facts_local_daily` is rebuilt from `usage_facts_15m` whenever the OMC Time Zone changes.
   - **Rolling request records (`OMCPA_USAGE_RETENTION_DAYS`, default `90`, `0` keeps all)**: Applies to `usage_events`, `error_events`, `ingest_gaps` and discarded payloads. Editable live in **OMC Settings → Data retention** (`usage_retention_settings`). Records are pruned only after their ID is folded into the permanent `facts` checkpoint.
   - **Rolling captured payloads (`OMCPA_USAGE_INBOX_RETENTION_DAYS`, default `7`, `0` follows request horizon)**: Applies to decoded payloads in `usage_inboxes` (the largest part of the database).
   - **Incremental vacuum**: New databases open with `auto_vacuum = INCREMENTAL`, and each hourly retention pass ends with bounded `PRAGMA incremental_vacuum` batches to return freed pages to disk.
2. **Append-only price history (`model_price_versions`, `pricing_channel_versions`)**:
   - Price and channel versions are never pruned because historical request cost snapshots reference the exact version IDs they were locked against.
3. **Encrypted Agent & Configuration documents (`agent_documents`, `cpa_config_backups`)**:
   - Encrypted with the active database cipher. Agent sessions and attached images remain until conversation reset; terminal pending operations expire after 7 days.
   - Before every CPA configuration write (including trusted plugin-page writes), OMC saves an encrypted copy of CPA's `config.yaml` in `cpa_config_backups` (retaining 20 v8 copies by default, configurable 5–100, plus up to 10 legacy pre-v8 copies). Writes fail closed if the backup cannot be recorded.
4. **Space Reclamation & Compaction**:
   - The **System Information** page offers two serialized maintenance actions that acquire the repository write gate ([Architecture](../dev/architecture.md#state-and-request-lifetimes)):
     - **WAL checkpoint** (`PRAGMA wal_checkpoint(TRUNCATE)`): folds committed WAL frames back into the main database file and truncates `-wal`.
     - **Rebuild** (`VACUUM`): compacts free pages (and upgrades older `auto_vacuum = NONE` databases to `INCREMENTAL`). Requires up to twice the database file size in free disk space.
   - When the console is offline, stop OMC first and run the same commands on the host:
     ```bash
     sqlite3 /path/to/data/oh-my-cpa.db "PRAGMA wal_checkpoint(TRUNCATE);"
     sqlite3 /path/to/data/oh-my-cpa.db "VACUUM;"
     ```

