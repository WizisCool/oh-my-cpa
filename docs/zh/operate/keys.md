# 密钥

一个部署依赖两项机密。请勿让它们出现在聊天记录、截图或 Shell 历史中。

## 主密钥

`OMCPA_MASTER_KEY` 加密 OMC 数据库中的凭据、采集载荷与备份。只生成一次（`openssl rand -hex 32`），与 `.env` 一同备份；数据写入后切勿更换，否则已存数据无法读取。备份如何保持可恢复，见[备份手册](../ops/sqlite-operations.md#4-omcpa_master_key-治理与版本升级安全门禁)。

## 轮换 CPA 管理密钥

CPA 管理密钥由部署环境变量统一拥有：它既保护控制台登录会话，也用于 OMC 管理客户端、用量采集和远程 MCP Bearer 鉴权。因此可视化配置页仅以只读方式展示该密钥，普通配置保存与备份恢复不会修改它。

需要轮换密钥时，请在同一维护窗口同步更新双方部署：

1. 备份 `.env` 与 OMC 数据目录；
2. 将 CPA 的管理密钥配置与 OMC 的 `OMCPA_CPA_MANAGEMENT_KEY` 同时更新为同一新值（使用 `compose.full.yml` 时只需更新 `CPA_MANAGEMENT_KEY`）；
3. 重新创建容器使新环境变量生效（`docker compose up -d --force-recreate cpa oh-my-cpa`，单纯 `restart` 不会加载新版 `.env`）；
4. 使用新密钥重新登录（旧密钥签发的会话会立即失效）。
