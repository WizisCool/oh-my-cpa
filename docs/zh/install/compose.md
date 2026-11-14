# 并入现有编排文件

如果 CPA 已在 Docker Compose 中运行且不想修改原 Compose 文件，推荐直接采用[独立部署](standalone.md)并设置 `OMCPA_NETWORK_NAME` 与 `OMCPA_NETWORK_EXTERNAL=true`。

若希望在同一个 Compose 文件中统一编排，可在 CPA 编排文件的 `services:` 下添加 `oh-my-cpa` 与 `oh-my-cpa-updater`，并在顶层 `volumes:` 下添加 `oh-my-cpa-data:`：

```yaml
  oh-my-cpa:
    image: ${OMCPA_IMAGE:-wiziscool/oh-my-cpa:latest}
    restart: unless-stopped
    user: ${OMCPA_USER:-10001:10001}
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    ports:
      - ${OMCPA_BIND:-127.0.0.1:8080}:8080
    environment:
      TZ: ${TZ:-UTC}
      OMCPA_BASE_PATH: ${OMCPA_BASE_PATH:-/}
      OMCPA_DATA_DIR: /data
      OMCPA_DEFAULT_LANGUAGE: ${OMCPA_DEFAULT_LANGUAGE:-}
      OMCPA_CPA_BASE_URL: ${OMCPA_CPA_BASE_URL:-http://cli-proxy-api:8317}
      OMCPA_CPA_MANAGEMENT_KEY: ${OMCPA_CPA_MANAGEMENT_KEY:?}
      OMCPA_MASTER_KEY: ${OMCPA_MASTER_KEY:?}
      OMCPA_USAGE_INGEST_MODE: ${OMCPA_USAGE_INGEST_MODE:-auto}
      OMCPA_PUBLIC_URL: ${OMCPA_PUBLIC_URL:-}
      OMCPA_TRUSTED_PROXY_CIDRS: ${OMCPA_TRUSTED_PROXY_CIDRS:-}
    volumes:
      - ${OMCPA_DATA_PATH:-oh-my-cpa-data}:/data

  oh-my-cpa-updater:
    image: ${OMCPA_IMAGE:-wiziscool/oh-my-cpa:latest}
    container_name: ${OMCPA_UPDATER_CONTAINER_NAME:-oh-my-cpa-updater}
    restart: unless-stopped
    command: ["updater", "serve"]
    user: "0:0"
    read_only: true
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    volumes:
      - ${DOCKER_SOCKET_PATH:-/var/run/docker.sock}:/var/run/docker.sock

volumes:
  oh-my-cpa-data:
```

`cli-proxy-api` 是 CPA 官方 Compose 中的默认服务名；若你的服务名不同，请在 `.env` 中指定 `OMCPA_CPA_BASE_URL=http://<cpa-service-name>:8317`。

将 `OMCPA_MASTER_KEY` 与 CPA 明文管理密钥追加到同目录 `.env`（使用 `>>` 保留现有配置）：

```bash
printf 'OMCPA_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" >> .env
cat >> .env <<'EOF'
OMCPA_CPA_MANAGEMENT_KEY='<CPA 明文管理密钥>'
EOF
chmod 600 .env
```

编辑 `.env` 替换 `<CPA 明文管理密钥>`（若已有其他管理面板在消费 CPA 的 Redis 用量队列，可加设 `OMCPA_USAGE_INGEST_MODE=off`；详见[与其他管理面板共存](standalone.md#与其他管理面板共存)）。

仅启动新增服务，避免重建或重启正在运行的 CPA 容器：

```bash
docker compose up -d oh-my-cpa oh-my-cpa-updater
```

打开 **`http://127.0.0.1:8080/`** 并使用 CPA 管理密钥登录。
