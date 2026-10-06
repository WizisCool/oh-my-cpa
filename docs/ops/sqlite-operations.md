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

### 3.3 Understanding Encrypted Migration Backups (`backups/*.db`)

Files under `OMCPA_DATA_DIR/backups/` generated by Oh My CPA before migrations are AES-GCM encrypted backups accompanied by `.sha256` checksums. They are managed internally by the application; they cannot be inspected directly by `sqlite3` without decryption using the configured `OMCPA_MASTER_KEY`.

### 3.4 Verify Service Readiness After Restoration

Start the container and inspect the health endpoint:

```bash
docker compose --env-file deploy/.env -f deploy/compose.full.yml start oh-my-cpa
```

- When accessing via an operator-owned HTTPS ingress, where `BASE_PATH` is the normalised `OMCPA_BASE_PATH` (`/omc` when unset; empty in root mode, which drops the prefix):
  ```bash
  BASE_PATH=/omc
  PUBLIC_ORIGIN=https://console.example.com
  curl -sf "${PUBLIC_ORIGIN}${BASE_PATH}/api/healthz" | jq .
  ```
- When accessing directly on the host (both Compose files publish loopback ports):
  ```bash
  BASE_PATH=/omc
  curl -sf "http://127.0.0.1:8080${BASE_PATH}/api/healthz" | jq .
  ```
- Or via container exec:
  ```bash
  docker compose --env-file deploy/.env -f deploy/compose.full.yml exec oh-my-cpa wget -q -O - "http://127.0.0.1:8080${BASE_PATH}/api/healthz" | jq .
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

1. **Usage data lifecycle**:
   - Every table declares one lifecycle in `TABLE_LIFECYCLES` (`internal/repository/lifecycle.go`): `permanent`, `rolling`, `owner_bounded` or `replaced`. A migration that adds a table without declaring it fails `TestEveryTableDeclaresItsLifecycle`;
   - **Permanent**: `usage_facts_15m` and `usage_facts_daily`, which every dashboard panel reads. They grow with distinct model/credential/key combinations per bucket, not with requests, and are never pruned;
   - **Rolling, `OMCPA_USAGE_RETENTION_DAYS`** (default 90, `0` keeps everything): request records (`usage_events`), `error_events`, `ingest_gaps` and discarded payloads. The cutoff is floored to a whole UTC day;
   - **Rolling, `OMCPA_USAGE_INBOX_RETENTION_DAYS`** (default 7, `0` follows the request-record horizon): payloads in `usage_inboxes` that were decoded into a request record. They are the largest part of the database;
   - The pass runs hourly inside `ingest.Maintenance` in batches of 2000 rows, at most 25 full batches at a time; an unfinished pass continues on the next fold tick (`OMCPA_USAGE_AGGREGATE_INTERVAL`, default 15 seconds) so the write gate is never held for a long delete;
   - A request record is deleted only when its id is at or below the `facts` checkpoint, so nothing leaves before the permanent facts hold it. What each policy has removed, and up to which instant, is recorded in `data_lifecycle_state`;
   - Deleting rows frees pages for reuse but does not shrink the file (`auto_vacuum` is off). After shortening a horizon, reclaim the space with the compaction under *Space Reclamation & Compaction* below;
   - **Upgrade note**: the request-record default was 400 days and is now 90, and decoded payloads are now kept 7 days. A deployment that sets neither variable has its older request records and payloads deleted by the passes that follow the upgrade, once the usage facts have absorbed them; dashboard statistics are unaffected. To keep the previous behaviour set `OMCPA_USAGE_RETENTION_DAYS=400` and `OMCPA_USAGE_INBOX_RETENTION_DAYS=0` before upgrading;
   - On upgrade, migration 035 starts the facts empty and the maintenance loop folds the stored request records into them from the first id. Totals stay exact meanwhile because unfolded records are read directly; statistics for requests already deleted by an earlier retention pass cannot be recovered.
2. **Price History (`model_price_versions`, `pricing_channel_versions`)**:
   - Price and channel versions are append-only and are never pruned: every stored request cost references the versions it was locked against, and removing one would leave a cost that can no longer be explained. They grow with price changes, not with traffic, so their size is negligible;
   - Migration 028 (OpenRouter pricing) rebuilds `model_prices` and `pricing_sync_state` by copying their rows verbatim with the version triggers dropped, so the upgrade mints no version and changes no recorded cost. The auto-sync interval is carried over; the models.dev sync history is not. The pre-migration backup above covers it like any other migration;
   - Migration 029 adds the provider-membership JSON snapshot to `pricing_catalog_state`; pricing access requires it. The next complete CPA reconciliation populates existing installations. The update is additive and leaves all price versions and request locks unchanged; the normal pre-migration backup applies.
   - Migration 031 adds `pricing_match_reviews`, the OpenRouter model an operator last answered for each custom or linked price. It is additive, holds no price and locks no cost; restoring an older copy (or losing the table's rows) only means the book announces existing matches once more.
   - `pricing_upstream_catalog` holds the last complete OpenRouter download and is replaced whole on every successful sync; restoring an older copy only means the model picker shows an older list until the next sync.
3. **Agent Documents (`agent_documents`, migration 026)**:
   - The encrypted latest Agent session and its capability operations live here; the session ciphertext is written with the same `OMCPA_MASTER_KEY` envelope as other protected payloads, so the key must exist to resume a conversation or read a pending operation;
   - The session is capped and trimmed by whole turns, and a terminal operation is retained for 7 days. Purging is lazy - it happens during Agent requests under a one-minute throttle - so the Agent adds no background loop and there is no separate maintenance job to schedule;
   - Restoring this table from a backup restores conversation and operation history, but approval requires a new decision: an operation that was `executing` when the process stopped is reported as `uncertain` rather than replayed.
4. **CPA Configuration Backups (`cpa_config_backups`, migration 030; `cpa_config_backup_settings`, migration 033)**:
   - Before every configuration write, Oh My CPA stores CPA's `config.yaml` as it was, encrypted with the same `OMCPA_MASTER_KEY` envelope; without the key a copy cannot be read or restored. A write whose copy cannot be stored is refused, so a missing key or an unwritable database blocks configuration writes instead of making them unrecoverable;
   - Migration 033 adds each copy's `layout` (`v8` or `legacy`) and `reason` (the kind of write it preceded); copies from before it are marked `legacy` / `legacy_conversion`. The upgrade is additive and covered by the normal pre-migration backup;
   - v8 copies are kept to the retention chosen on the configuration page (default 20, between 5 and 100, the single row of `cpa_config_backup_settings`); pre-v8 copies are kept apart, the ten most recent (`CONFIG_LEGACY_BACKUP_RETENTION`). A copy identical to the gateway's newest one reuses it instead of adding one, so refused attempts cannot push older copies out. Older copies are deleted in the same transaction as the insert, and lowering the retention deletes them at once, so the table needs no maintenance job. A copy is at most 2 MiB, the largest file CPA's management API accepts;
   - The configuration page lists the copies, takes one on demand, restores a v8 copy onto the gateway (the replaced file is kept first), downloads one and deletes one; restore, download and deletion are audited fail-closed (`config.restore_backup`, `config.reveal_backup`, `config.delete_backup`). `cpa_config_backups` is hidden from the Agent's `database_query`;
   - Restoring these tables from a database backup restores the copies and the retention. A pre-v8 copy cannot be written back through the v8 API; putting one back on the gateway is an operator action on CPA's own file, outside Oh My CPA.
5. **Space Reclamation & Compaction**:
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
