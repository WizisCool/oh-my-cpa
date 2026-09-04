# SQLite 运维与灾备恢复手册 (SQLite Operations & Runbook)

本文档面向 Oh My CPA 生产部署环境的系统管理员与运维人员，详细阐述单副本 SQLite 在 WAL 模式下的日常备份、演练恢复、加密密钥治理、迁移安全门禁以及容量维护策略。

---

## 1. 核心架构约束与单副本限制

1. **单实例排他写入原则**：
   - Oh My CPA 的持久化层采用嵌入式 SQLite（启用 WAL 模式与 `busy_timeout=5000`）；
   - 严禁通过 NFS、SMB/CIFS 等网络分布式文件系统共享 `/data` 目录以启动多个 Oh My CPA 副本；
   - 在高可用编排（如 K8s 或 Docker Swarm）中，必须配置 `Replicas: 1` 与 `Recreate` 更新策略，确保同一时刻仅存在一个容器挂载并打开数据库。

2. **WAL 模式三件套完整性**：
   - 数据目录下包含：`oh-my-cpa.db`（主库）、`oh-my-cpa.db-wal`（写前日志）及 `oh-my-cpa.db-shm`（共享内存索引）；
   - 严禁在服务运行状态下仅复制单个 `.db` 文件作为备份，否则必然导致数据不一致或损坏。

---

## 2. 在线安全备份策略

### 2.1 推荐方案：在线 VACUUM INTO

在服务持续处理读写请求期间，可通过 SQLite 官方安全的 `VACUUM INTO` 命令生成原子一致性快照：

```bash
# 进入运行容器或本地数据目录执行
sqlite3 /data/oh-my-cpa.db "VACUUM INTO '/data/backups/oh-my-cpa-backup-$(date +%Y%m%d_%H%M%S).db';"
```

该机制会完整汇聚主库与未提交 WAL 页面，输出一份独立、已完成 Checkpoint 且处于原子一致状态的全新单个 SQLite 数据库文件。

### 2.2 停机冷备份流程

若需在停机窗口维护，按以下步骤安全归档：

1. 优雅停止 Oh My CPA 服务进程：
   ```bash
   docker compose -f deploy/compose.full.yml stop oh-my-cpa
   ```
2. 等待进程彻底刷盘并退出（Go 服务在接收 `SIGTERM` 后会自动执行 WAL Checkpoint）；
3. 将整个 `/data` 目录整体打包归档并计算 SHA-256 校验和：
   ```bash
   tar -czf "omc-data-$(date +%Y%m%d_%H%M%S).tar.gz" -C /data .
   sha256sum "omc-data-$(date +%Y%m%d_%H%M%S).tar.gz" > checksum.sha256
   ```

---

## 3. 灾难恢复演练流程 (Restore Runbook)

当遭遇主机故障或数据异常时，执行以下经过验证的恢复步骤：

1. **停止运行容器**：
   ```bash
   docker compose -f deploy/compose.full.yml stop oh-my-cpa
   ```

2. **验证备份完整性**：
   ```bash
   sha256sum -c checksum.sha256
   # 对备份文件执行完整性自检
   sqlite3 backup.db "PRAGMA integrity_check;"
   # 输出必须为 "ok"
   ```

3. **恢复数据库与权限配置**：
   - 清理损坏的旧数据目录；
   - 将验证通过的 `backup.db` 复制为 `/data/oh-my-cpa.db`；
   - 修正目录归属为非 root 用户（UID/GID 10001:10001）：
     ```bash
     chown -R 10001:10001 /data
     chmod 700 /data
     chmod 600 /data/oh-my-cpa.db
     ```

4. **启动服务并执行就绪探活**：
   ```bash
   docker compose -f deploy/compose.full.yml start oh-my-cpa
   curl -sf http://127.0.0.1:8080/omc/api/healthz | jq .
   ```
   验证响应返回 `"database_status": "ok"` 且服务就绪。

---

## 4. `OMCPA_MASTER_KEY` 治理与灾难预防

- **主密钥作用**：
  `OMCPA_MASTER_KEY` 是 32 字节的高熵随机密钥，用于 AES-GCM 加密存储 CPA Management Key 以及敏感的用量 inbox 消息。
- **丢失后果**：
  若主密钥丢失或损坏，数据库中所有已保存的加密字段将**永久不可解密**，系统启动将抛出致命错误并拒绝上线。
- **治理要求**：
  1. 绝不将明文写在代码仓库或 Dockerfile 中；
  2. 采用环境变量或加密机注入；
  3. 离线双人复核备份至企业级密码库（如 1Password、Vault 或安全离线信封）。

---

## 5. 迁移前安全门禁与 Forward Rollback

Oh My CPA 在升级启动时会自动检测并执行尚未运行的不可变 SQL 迁移脚本：

1. **自动前置检查**：
   - 检查可用磁盘空间：必须大于数据库当前大小的 3 倍，以防在重构索引或表结构时磁盘满写导致断裂；
   - 自动生成带时间戳的前置备份；
2. **Expand / Contract 兼容迁移**：
   - 数据库结构变更严格遵循“扩展字段优先”原则，不直接破坏旧版本查询结构；
3. **纠错式向前迁移（Forward Rollback）**：
   - 生产环境严禁通过手工修改 `schema_migrations` 或倒退版本文件进行暴力回滚；
   - 若发现迁移缺陷，应发布修复补丁（如 `008_fix_xxx.sql`）继续向前推进修复。

---

## 6. 数据 Retention 与定期 VACUUM 维护

1. **历史事件保留期**：
   - 通过配置 `OMCPA_USAGE_RETENTION_DAYS`（默认 30 天）控制用量事件与原始记录的保留时长；
   - 每天自动清理超期明细，保障数据库文件体积平稳可控。
2. **空间回收与碎片整理**：
   - 大规模清理历史数据后，SQLite 内部可能残留空闲页面；
   - 建议每月或低峰期安排一次全量整理：
     ```bash
     sqlite3 /data/oh-my-cpa.db "VACUUM;"
     ```
