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

While the service continues processing read and write requests, a consistent snapshot can be generated using SQLite's `VACUUM INTO` command. Note that the minimal production Alpine container (`FROM alpine:3.21`) does not include the `sqlite3` CLI; run this command on the host targeting the volume mount directory, or from an administrative sidecar container:

```bash
# Executed on the host targeting the volume mount directory:
BACKUP_DIR="/path/to/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "${BACKUP_DIR}" && chmod 700 "${BACKUP_DIR}"

sqlite3 /path/to/data/oh-my-cpa.db "VACUUM INTO '${BACKUP_DIR}/oh-my-cpa-backup-${TIMESTAMP}.db';"
chmod 600 "${BACKUP_DIR}/oh-my-cpa-backup-${TIMESTAMP}.db"
```

**Semantics**: `VACUUM INTO` reads committed pages from the main database and WAL, producing a single, self-contained, transactionally consistent snapshot file once the operation finishes successfully. It does not include uncommitted transactions, nor does it checkpoint or truncate the active source `-wal` file.

### 2.2 Cold Backup Procedure (Scheduled Maintenance)

When performing scheduled maintenance during an offline window:

1. Gracefully stop the Oh My CPA service container:
   ```bash
   docker compose -f deploy/compose.full.yml stop oh-my-cpa
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

---

## 3. Disaster Recovery Drill (Restore Runbook)

When recovering from host failures or database corruption, choose the procedure matching your backup artifact:

### 3.1 Restoring from a `VACUUM INTO` Snapshot (`.db`)

1. **Stop the service container**:
   ```bash
   docker compose -f deploy/compose.full.yml stop oh-my-cpa
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
   - Set ownership to the container user (`10001:10001` per Dockerfile) and restrict permissions:
     ```bash
     chown -R 10001:10001 /path/to/data
     chmod 700 /path/to/data
     chmod 600 /path/to/data/oh-my-cpa.db
     ```

### 3.2 Restoring from a Cold Tarball (`.tar.gz`)

1. **Stop the service container**:
   ```bash
   docker compose -f deploy/compose.full.yml stop oh-my-cpa
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

### 3.3 Understanding Encrypted Migration Backups (`backups/*.db`)

Files under `OMCPA_DATA_DIR/backups/` generated by Oh My CPA before migrations are AES-GCM encrypted backups accompanied by `.sha256` checksums. They are managed internally by the application; they cannot be inspected directly by `sqlite3` without decryption using the configured `OMCPA_MASTER_KEY`.

### 3.4 Verify Service Readiness After Restoration

Start the container and inspect the health endpoint:

```bash
docker compose -f deploy/compose.full.yml start oh-my-cpa
```

- When accessing via the public reverse proxy (such as Caddy), where `BASE_PATH` is the normalised `OMCPA_BASE_PATH` (`/omc` when unset; empty in root mode, which drops the prefix):
  ```bash
  BASE_PATH=/omc
  curl -sf "https://${DOMAIN}${BASE_PATH}/api/healthz" | jq .
  ```
- When accessing directly on the host (with published ports, e.g. `deploy/compose.omc.yml`):
  ```bash
  curl -sf "http://127.0.0.1:8080${BASE_PATH}/api/healthz" | jq .
  ```
- Or via container exec:
  ```bash
  docker compose -f deploy/compose.full.yml exec cpa wget -q -O - "http://oh-my-cpa:8080${BASE_PATH}/api/healthz" | jq .
  ```

Confirm the JSON response reports `"database_status": "ok"` and `"status": "ok"` (or `"degraded"` if CPA is temporarily offline).

---

## 4. `OMCPA_MASTER_KEY` Governance & Disaster Prevention

- **Role of the Master Key**:
  `OMCPA_MASTER_KEY` is a 32-byte high-entropy key (e.g. 64 hexadecimal characters), used to encrypt the CPA Management Key and raw usage inbox payloads at rest via AES-GCM.
- **Consequences of Loss**:
  If the master key is lost or corrupted, all encrypted fields in the database become **permanently unrecoverable**. The server will fail to decrypt existing credentials and payloads.
- **Operational Requirements**:
  1. Never commit plaintext keys to code repositories or Dockerfiles;
  2. Inject keys via secure environment variables, secret managers, or orchestration vaults;
  3. Keep an offline, dual-custody backup in a password vault (such as 1Password, HashiCorp Vault, or a secure physical envelope).

---

## 5. Pre-Migration Safety Gates & Forward Rollbacks

When upgrading Oh My CPA, the application automatically inspects and applies unexecuted immutable SQL migration scripts at startup:

1. **Automated Safety Gates**:
   - **Disk Space Verification**: Checks available disk space before starting; requires at least `database_size + 4 KiB` free space by default (or configured via `BackupConfig.MinFreeBytes`);
   - **Pre-Migration Encrypted Backup**: For existing databases with recorded migrations in `schema_migrations`, the application executes `PRAGMA wal_checkpoint(TRUNCATE)` and writes an AES-GCM encrypted backup with a `.sha256` checksum to `OMCPA_DATA_DIR/backups` (permissions `0700/0600`). The check is fail-closed: if the schema state cannot be read at all (the `sqlite_master` lookup fails, or `schema_migrations` exists but cannot be counted), the backup is taken instead of assuming a fresh database;
   - **Restore Smoke Test**: Decrypts the backup into a temporary database and verifies that schema tables are readable before proceeding; if verification fails, or the `.sha256` sidecar cannot be read, migration aborts with `ErrBackupRestoreFailed`;
   - **Retention**: Keeps the 5 most recent migration backups by default (configurable via `repository.WithMigrationBackup`).
2. **Expand / Contract Schema Evolution**:
   - Schema modifications strictly adhere to expand-first principles, avoiding breaking older query shapes.
3. **Forward-Only Rollbacks**:
   - In production, rolling back by manually editing `schema_migrations` or rewinding schema files is strictly prohibited;
   - If a defect is discovered in a migration, deploy a forward-fixing migration (e.g. `008_fix_xxx.sql`) to correct the schema.

---

## 6. Data Retention & Periodic Maintenance

1. **Historical Event Retention**:
   - Configured via `OMCPA_USAGE_RETENTION_DAYS` (default 400 days, `0` for indefinite retention) to control raw usage payloads and event details. The default follows the dashboard's token heatmap, which covers a rolling year: a shorter horizon would leave the window's own beginning unreadable, and 400 rather than 365 leaves slack so neither a leap year nor an offset boundary can push the oldest day out;
   - Pruning runs once per hour inside `ingest.Maintenance`, while rollups advance every `OMCPA_USAGE_AGGREGATE_INTERVAL` (default 15 seconds);
   - Pruning boundaries are gated by aggregation checkpoints, guaranteeing that detailed records are never removed before rollups have processed them.
2. **Space Reclamation & Compaction**:
   - Large-scale historical data deletion leaves free pages inside SQLite. The file does
     not shrink on its own, and a large `-wal` file is normal rather than a fault: WAL is
     reused between checkpoints rather than truncated continuously;
   - Two actions are available, and the System Information page runs both. The console's
     route is the safer of the two for a running deployment, because it takes the write
     gate described in `docs/architecture.md` §11 - writers wait rather than fail, and a
     failed write would stop the usage collector and with it the process:
     - **WAL checkpoint** (`PRAGMA wal_checkpoint(TRUNCATE)`) moves the log's frames back
       into the database and truncates the log. It is cheap and safe to run often. SQLite
       reports a blocked checkpoint in the statement's own result row instead of raising
       an error, so the page reports that outcome as *incomplete* rather than as success;
     - **Rebuild** (`VACUUM`) releases free pages. SQLite documents that it needs as much
       as **twice the database file** in free space while it runs, and the console measures
       that requirement and shows it in the confirmation before the action starts. The
       console uses a plain `VACUUM`, not `VACUUM INTO` plus a file swap: the connection
       pool holds an open handle to the file, so replacing it underneath would need every
       connection closed and the pool rebuilt while other goroutines still hold references
       to it. A plain `VACUUM` copies into a temporary file and overwrites the original
       inside an ordinary transaction, so a rebuild that is interrupted — by cancellation,
       by its own ten-minute ceiling, or by a restart — leaves the original database intact.
   - The same actions remain available directly through `sqlite3` when the console is not
     reachable. Stop the application first, or accept the same waiting behaviour the gate
     provides:
     ```bash
     sqlite3 /path/to/data/oh-my-cpa.db "PRAGMA wal_checkpoint(TRUNCATE);"
     sqlite3 /path/to/data/oh-my-cpa.db "VACUUM;"
     ```
   - A maintenance job does not survive a restart: the process running it is gone with it.
     The console's job status is held in memory for this reason, and the page says so.
