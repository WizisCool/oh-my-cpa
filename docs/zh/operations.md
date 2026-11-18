# 运维

已安装控制台的日常运维：各项任务的入口，以及部署必须遵守的约束。全部配置项见[环境变量](reference/environment.md)。

| 任务 | 指南 |
| --- | --- |
| 修改端口，或把数据放到宿主机目录 | [端口与存储](operate/ports-storage.md) |
| 版本提醒与一键更新 | [更新](operate/updates.md) |
| 备份、恢复与数据库维护 | [备份与恢复](ops/sqlite-operations.md) |
| 保管主密钥、轮换管理密钥 | [密钥](operate/keys.md) |
| 选择每日统计使用的日历 | [时区](operate/time-zone.md) |

## 部署约束

- **单副本运行**：SQLite WAL 要求单进程独占写权限，禁止多个实例共享同一 `/data` 目录，也不得置于 NFS/CIFS 等网络文件系统上。
- **主密钥不可丢失**：`OMCPA_MASTER_KEY` 用于加解密数据库敏感凭据与载荷。
- **内嵌框架策略**：文档响应声明 `frame-src 'self' blob:` 以同源承载插件页面，反代切勿放宽为允许任意外部域嵌入。
- **网络安全与反代**：CPA 应处于私网或回环网络内；公网暴露控制台必须配置 HTTPS，且仅将真实直连代理节点列入 `OMCPA_TRUSTED_PROXY_CIDRS`。
- **网关版本**：强制要求 CPA v8.0.0+。CPA v8 可读取原 v7 格式 `config.yaml`，OMC 首次保存配置时会触发其迁移至 v8 结构，但在此之前会自动将原始 YAML 加密备份以便随时下载或回退（见 [CPA v8 集成契约](cpa-v8-compat.md)）。其中载荷替换规则的 `system`/`developer` 角色、`target.paths` 路径目标及 `{ pattern, replacement }` 正则条目需 CPA v8.0.77+；v8.0.75–v8.0.76 仅支持 `role: user` 与字面量映射，早于 v8.0.75 的版本不支持载荷替换。
- **子路径与搜索引擎**：配置了 `OMCPA_BASE_PATH` 时反代须完整保留前缀并转发；所有响应默认附带 `X-Robots-Tag: noindex, nofollow, …` 且支持 `/robots.txt` 禁止收录。
- **容器运行时**：非 root（`10001:10001`）、只读根文件系统，内置健康检查；当 CPA 离线时 `/api/healthz` 返回 `degraded` 而不崩溃退出。
