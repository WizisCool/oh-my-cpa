# 独立部署

使用 `compose.omc.yml` 在已有 CPA（位于宿主机、另一个 Docker Compose 项目或另一台服务器）旁运行 OMC 与更新器。该方式不会修改或重启现有的 CPA、配置、密钥及其他管理面板。

1. 创建新目录并下载 `compose.omc.yml`（已有部署请见[升级](upgrade.md)）：

   ```bash
   (
     [ ! -e compose.yml ] && [ ! -e .env ] &&
     [ ! -e oh-my-cpa/compose.yml ] && [ ! -e oh-my-cpa/.env ] &&
     mkdir -p oh-my-cpa && cd oh-my-cpa &&
     curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.omc.yml -o compose.yml
   ) && cd oh-my-cpa
   ```

2. 创建 `.env`（若 `.env` 已存在则跳过，避免覆盖既有 `OMCPA_MASTER_KEY`），写入新生成的 `OMCPA_MASTER_KEY`、CPA 可达地址及现有 CPA 的明文管理密钥（登录界面输入的原始密钥，而非 `config.yaml` 里的 bcrypt 哈希）。建议用单引号包裹 `OMCPA_CPA_MANAGEMENT_KEY`，避免 Docker Compose 将密钥里的 `$` 当作环境变量展开（若密钥本身含单引号 `'`，写为 `\'`）：

   ```bash
   [ ! -e .env ] &&
   printf "OMCPA_CPA_BASE_URL=http://host.docker.internal:8317\nOMCPA_MASTER_KEY=%s\nOMCPA_CPA_MANAGEMENT_KEY='<CPA 明文管理密钥>'\n" "$(openssl rand -hex 32)" > .env &&
   chmod 600 .env
   ```

   编辑 `.env` 填入实际密钥，并根据[连接现有 CPA](#连接现有-cpa) 调整 `OMCPA_CPA_BASE_URL`（若 CPA 在另一个 Docker 项目中，还需配置网络变量）。如果 CPA 时区不是 UTC，请在 `.env` 中加入 `TZ=<CPA 所在时区>` 保持日历切分一致。

3. 启动 OMC 与更新器：

   ```bash
   docker compose up -d
   ```

4. 打开 **`http://127.0.0.1:8080/`**，使用 CPA 管理密钥登录。


## 连接现有 CPA

OMC 运行在容器内，`OMCPA_CPA_BASE_URL` 必须是容器内部能够访问的地址。

| CPA 运行位置 | `.env` 配置 |
| --- | --- |
| 同一宿主机，监听全部网卡（`:8317` 或 `0.0.0.0:8317`） | `OMCPA_CPA_BASE_URL=http://host.docker.internal:8317` |
| 同宿主机上的另一个 Docker Compose 项目 | `OMCPA_CPA_BASE_URL=http://<CPA 服务名或容器名>:8317`<br>`OMCPA_NETWORK_NAME=<CPA 的 Docker 网络名>`<br>`OMCPA_NETWORK_EXTERNAL=true` |
| 另一台服务器 | `OMCPA_CPA_BASE_URL=https://<CPA 主机>:8317`（或内网地址） |
| 同一宿主机，且仅监听 `127.0.0.1` | 桥接容器无法访问宿主机回环地址。请改用宿主机上的[原生可执行文件](native.md)或[从源码构建](source.md) |

通过 `.env` 中的 `OMCPA_NETWORK_NAME` 和 `OMCPA_NETWORK_EXTERNAL=true` 加入 CPA 所在网络，无需改动任一方的 `compose.yml`。可使用以下命令查看 CPA 容器所在的网络名：

```bash
docker inspect <cpa-container> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

CPA 会把容器内的 OMC 视作远程管理客户端。如果 OMC 正常启动但 `/api/healthz` 返回 `"status":"degraded"` 且 `"cpa_connected":false`，请检查 CPA 的 `config.yaml` 中是否开启了 `management.allow-remote: true`（旧版 v7 配置为 `remote-management.allow-remote`）。开启远程管理后，任何能访问 CPA 端口的主机均可尝试验证管理密钥，请勿将 CPA 端口直接暴露到公网。

## 与其他管理面板共存

其他管理面板（如 `cpamp`）可以与 OMC 并行运行。两者共享同一套 CPA 管理 API，在任一面板修改提供商或配置都会同步生效，OMC 不会导入其他面板的历史记录或本地设置。如果已有其他组件在消费 CPA 的 Redis 用量队列，请合理设置 `OMCPA_USAGE_INGEST_MODE`，避免多个消费者争抢 `RPOP`/`BLPOP` 队列记录。
