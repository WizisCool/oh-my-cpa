# 排障

所有排查都从健康检查接口开始，它会报告 OMC 是否在运行、能否连上 CPA。

```bash
curl -fsS http://127.0.0.1:8080/api/healthz
```

正常部署会返回 `"status":"ok"` 与 `"cpa_connected":true`。若只返回 Docker healthy 但 `cpa_connected` 为 `false`，控制台会以 `"status":"degraded"` 启动并提示连接问题。

## 常见问题

| 症状 | 原因定位 | 处理办法 |
| --- | --- | --- |
| `docker compose up` 报错 `Bind for 127.0.0.1:8080 failed: port is already allocated` | 宿主机端口 `8080` 已被占用 | 在 `.env` 中设置 `OMCPA_BIND=127.0.0.1:18317`（若 CPA `8317` 冲突则设 `CPA_BIND`），不要改容器端口 `:8080` |
| 修改 `ports:` 后容器运行但浏览器无法访问 | 容器端口被改离 `:8080` 导致与进程监听端口不匹配 | 恢复 `${OMCPA_BIND:-127.0.0.1:8080}:8080`，仅调整 `.env` 中的 `OMCPA_BIND` |
| 日志提示 `listen on ... address already in use` | 原生二进制或 `host` 网络容器中 `:8080` 已被占用 | 在 `.env` 设置 `OMCPA_LISTEN_ADDR=127.0.0.1:18317` |
| 日志提示 `data directory /data is not writable by uid:gid ...: permission denied` | 宿主机挂载目录权限与 `OMCPA_USER` 不匹配 | 保持默认命名卷与 `10001:10001`，或对宿主机目录执行 `chown 10001:10001` / 在 `.env` 指定宿主机的 `OMCPA_USER=<uid>:<gid>` |
| CPA 启动失败且 `config.yaml` 变成目录 | 首次启动前未创建 `config.yaml` 文件 | 停服删除 `config.yaml/` 目录，重新下载 `cpa.config.example.yaml` 为 `config.yaml` 后启动 |
| `/api/healthz` 返回 `degraded`（`cpa_connected: false`） | `OMCPA_CPA_BASE_URL` / `OMCPA_CPA_MANAGEMENT_KEY` 有误或 CPA 拒绝远程管理 | 对照[连接现有 CPA](standalone.md#连接现有-cpa) 检查网络与地址，必要时在 CPA `config.yaml` 设置 `management.allow-remote: true` |
| 登录成功后立刻跳回登录页 | `OMCPA_PUBLIC_URL` 以 `https://` 开头（Cookie 标记 `Secure`），但当前通过 `http://` 访问 | 本地 HTTP 访问请留空 `OMCPA_PUBLIC_URL`，或改由 HTTPS 反代地址访问 |
| 控制台提示升级 CPA | CPA 版本低于 v8.0.0 | 将 CPA 升级至 v8.0.0 或更高版本 |
| 请求记录长期为空 | 设置了 `OMCPA_USAGE_INGEST_MODE=off`、CPA 未开启统计，或被其他面板抢先消费队列 | 开启 CPA 用量统计并确保仅有一个消费者读取用量队列 |
