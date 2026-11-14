# SQLite 数据库运维与恢复手册

本手册面向在生产环境运行 Oh My CPA 的系统管理员，涵盖单副本 WAL 约束、在线/冷备策略、控制台 `.omcbackup` 与云端自动备份、灾难恢复演练、`OMCPA_MASTER_KEY` 治理以及空间清理（[英文原版](../../ops/sqlite-operations.md)）。

---

## 1. 单副本与 WAL 核心约束

1. **严格单写者原则**：
   - OMC 使用嵌入式 SQLite WAL 模式（`journal_mode=WAL`、`busy_timeout=5000`）；
   - **严禁**通过 NFS、SMB/CIFS、GlusterFS 等网络文件系统挂载 `/data`，也不得让多个 OMC 实例并发挂载同一个数据目录；在编排器中应使用单副本与 `Recreate` 更新策略。
2. **WAL 三文件完整性**：
   - 数据目录包含紧耦合的三个文件：`oh-my-cpa.db`（主库）、`oh-my-cpa.db-wal`（预写日志）与 `oh-my-cpa.db-shm`（共享内存索引）；
   - 服务运行期间切勿直接复制 `oh-my-cpa.db` 单文件，否则会丢失尚未合并进主库的最新提交事务。
3. **单连接串行化设计**：
   - 应用内连接池锁定为 `MaxOpenConns(1)` / `MaxIdleConns(1)`，写操作由内存写门禁串行排队。
4. **演示模式数据隔离**：
   - `OMCPA_DEMO_MODE=true` 使用独立的 `oh-my-cpa-demo.db` 并在每次启动时重置，不会影响真实部署的 `oh-my-cpa.db`。

---

## 2. 备份与恢复方案

### 2.1 宿主机 `VACUUM INTO` 在线快照

在服务持续运行期间可通过 SQLite 原生 `VACUUM INTO` 生成事务一致的完整静态副本（精简生产 Alpine 镜像不含 `sqlite3` 命令行，可在宿主机针对数据卷目录执行）：

```bash
BACKUP_DIR="/path/to/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "${BACKUP_DIR}" && chmod 700 "${BACKUP_DIR}"

sqlite3 /path/to/data/oh-my-cpa.db "VACUUM INTO '${BACKUP_DIR}/oh-my-cpa-backup-${TIMESTAMP}.db';"
chmod 600 "${BACKUP_DIR}/oh-my-cpa-backup-${TIMESTAMP}.db"
```

如果数据目录存在 `<database-path>.key` 密钥信封文件（由跨实例备份恢复生成），需连同目标部署的 `OMCPA_MASTER_KEY` 一起妥善保管；使用控制台 `.omcbackup` 导出则会自动将加密与身份恢复信息一同封装。

### 2.2 停机冷备

在部署目录（包含安装指南生成的 `compose.yml` 与 `.env`）停止 `oh-my-cpa` 容器并确认其完全退出后再归档数据目录；若停止失败或服务仍在运行，请立即中止操作：

```bash
set -euo pipefail
cd /path/to/oh-my-cpa
docker compose stop oh-my-cpa
test -z "$(docker compose ps -q --status running oh-my-cpa)"

BACKUP_DIR="/path/to/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "${BACKUP_DIR}" && chmod 700 "${BACKUP_DIR}"
tar -czf "${BACKUP_DIR}/omc-data-${TIMESTAMP}.tar.gz" -C /path/to/data .
sha256sum "${BACKUP_DIR}/omc-data-${TIMESTAMP}.tar.gz" > "${BACKUP_DIR}/omc-data-${TIMESTAMP}.sha256"
chmod 600 "${BACKUP_DIR}/omc-data-${TIMESTAMP}.tar.gz" "${BACKUP_DIR}/omc-data-${TIMESTAMP}.sha256"
```

### 2.3 控制台加密备份与整库恢复（`.omcbackup`）

在 **系统信息 → 数据库 → 管理备份** 中，可使用独立口令导出或上传验证整库 `.omcbackup` 加密归档（包含全部用量、锁定费用、审计记录及图标等资产，不包含 CPA 配置或 `.env`）。

- **跨主机免源主密钥恢复**：导出文件使用用户设定的备份口令对数据库体和内部主加密/HMAC 密钥同时加密；恢复时会自动用目标部署的 `OMCPA_MASTER_KEY` 重新包裹密钥信封写入 `<database-path>.key`，因此新环境无需知晓源站的主密钥即可完整继承历史凭据签名与加密字段。
- **启动前原子替换与自动回滚保护**：在控制台确认恢复后不会热修改运行中的数据库，而是登记为待执行任务并等待下次正常重启。重启时 OMC 会先对当前数据库制作加密回滚备份，验证新库可正常打开并写入恢复审计日志后才正式提交；若准备阶段失败，启动会安全中止而不损坏原库，可使用 `oh-my-cpa database cancel` 取消待恢复任务恢复原服务。
- **离线恢复命令行**（执行本地导出、校验与恢复前请先停止主服务）：

```bash
oh-my-cpa database export --output /backup/omc.omcbackup --passphrase-file /secure/backup-passphrase
oh-my-cpa database inspect --file /backup/omc.omcbackup --passphrase-file /secure/backup-passphrase
oh-my-cpa database restore --file /backup/omc.omcbackup --passphrase-file /secure/backup-passphrase --confirm
```

若恢复准备失败需要取消待执行任务以恢复原服务启动，或需要回退至恢复前保留的本地加密回滚快照，请按需单独执行：

```bash
# 仅在恢复准备失败需取消待恢复任务时执行
oh-my-cpa database cancel

# 仅在需要回滚至恢复前自动保留的加密快照时执行
oh-my-cpa database restore --rollback-id <restore-job-id> --confirm
```

### 2.4 定时自动备份与云端容灾

在管理备份面板设置备份口令与每日触发时间后，可勾选**本地保留份数**与多个远程存储目标（S3/R2、WebDAV、SFTP、FTPS/FTP、SMB、Google Drive、OneDrive）：

- **内嵌 `rclone` 引擎**：所有传输适配器均内嵌在 OMC 二进制中，无需额外 Sidecar 容器或挂载权限；每次云端上传后会自动回读校验 SHA-256，校验通过后才会按保留策略清理更早版本。若仅保留云端（`keep_local: 0`）且某次上传失败，本地最新副本会继续保留直至全部目标同步成功。
- **灾难恢复配置文件（`.omcrecovery`）**：建议导出脱机保存 `.omcrecovery` 加密云端配置档案与备份口令。当原服务器与本地磁盘完全丢失时，可在一台全新机器上使用 OMC 二进制直接检索并拉取云端备份进行重建，无需原服务器主密钥：

```bash
oh-my-cpa database remote-list --profile /secure/omc.omcrecovery --passphrase-file /secure/backup-passphrase
oh-my-cpa database remote-list --profile /secure/omc.omcrecovery --passphrase-file /secure/backup-passphrase --destination <destination-id>
oh-my-cpa database fetch --profile /secure/omc.omcrecovery --passphrase-file /secure/backup-passphrase --destination <destination-id> --object <backup-object-name> --output /backup/recovered.omcbackup
oh-my-cpa database inspect --file /backup/recovered.omcbackup --passphrase-file /secure/backup-passphrase
oh-my-cpa database restore --file /backup/recovered.omcbackup --passphrase-file /secure/backup-passphrase --confirm
```

恢复完成后，系统会保留原云端目标列表并默认暂停定时计划同时分配新的保留命名空间，避免容灾演练覆盖或误删生产实例的历史备份。

---

## 3. 从原始文件手动恢复

1. 停止 `oh-my-cpa` 容器；
2. 若为 `.db` 快照，先检查完整性：`sqlite3 backup.db "PRAGMA integrity_check;"` 确认返回 `ok`；若为冷备压缩包，先校验 `sha256sum -c`；
3. 将受损数据目录移走备份，新建干净目录后拷入 `oh-my-cpa.db`（及配套 `.key` 文件）或解压冷备包，确保目录属主为 `10001:10001`、权限 `0700`（数据文件 `0600`），且不要保留损坏库残留的 `-wal` / `-shm` 文件；
4. 启动容器后检查 `/api/healthz` 返回 `"database_status": "ok"`。

---

## 4. `OMCPA_MASTER_KEY` 治理与版本升级安全门禁

- **主密钥托管**：`OMCPA_MASTER_KEY` 严禁提交到代码库，应以双份离线形式安全保管。丢失主密钥与 `.key` 信封后，仅能通过事先保存的 `.omcbackup` + 备份口令恢复。
- **自动迁移前加密快照**：每次升级检测到未执行的只增不改 SQL 迁移时，启动阶段会在独立私有工作区通过 `VACUUM INTO` 创建流式 `age` 加密快照并执行解密校验，验证通过后才推进迁移（存放于 `OMCPA_DATA_DIR/backups/*.db.enc`）。
- **只增不改约束**：生产环境禁止手动修改 `schema_migrations` 或回滚已执行迁移；如需要版本回退，务必恢复对应版本前的数据备份。

---

## 5. 数据生命周期与空间回收

- **永久聚合表（`usage_facts_15m` / `usage_facts_daily` / `usage_facts_local_daily`）**：支撑仪表盘与洞察，体积随模型与凭据组合数增长而非原始请求条数，永久保留且可随时按新时区重建。
- **滚动请求明细与收件箱载荷**：分别受 `OMCPA_USAGE_RETENTION_DAYS`（默认 `90` 天，控制台 **OMC 设置 → 数据保留** 可实时调整）和 `OMCPA_USAGE_INBOX_RETENTION_DAYS`（默认 `7` 天）控制，仅在聚合检查点完成后才会安全清理，并配合 `incremental_vacuum` 逐步归还空闲页。
- **不可变版本表**：价格版本（`model_price_versions` / `pricing_channel_versions`）与审计日志只增不改；每次 CPA 配置修改前均会在 `cpa_config_backups` 保留加密副本（默认留存 20 份）。
- **人工压缩**：在控制台 **系统信息** 或停服后运行 `PRAGMA wal_checkpoint(TRUNCATE);` 与 `VACUUM;` 可回收空间并清理 WAL 文件。
