# 安装指南

Oh My CPA（OMC）需配合 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（CPA）**v8.0.0 及以上版本**运行。控制台的登录密码即 CPA 的管理密钥。官方 Docker 镜像为 Docker Hub 上的 **`wiziscool/oh-my-cpa`**，同时支持 `linux/amd64` 与 `linux/arm64`。

| 使用场景 | 推荐方式 |
| --- | --- |
| 尚未部署 CPA | [全新安装](#全新安装) |
| CPA 已运行在宿主机、另一个 Docker 项目或其他机器上 | [独立部署](#独立部署) |
| CPA 已使用 Docker Compose 部署，希望合并在同一个编排文件中 | [并入现有编排文件](#并入现有编排文件) |
| 不使用 Docker，在 macOS、Windows、Linux 或 FreeBSD（amd64/arm64）上运行 | [原生可执行文件](#原生可执行文件) |
| 显式需要源码编译，或无对应平台预编译包 | [从源码构建](#从源码构建) |

也可以直接将 [`docs/install-for-agents.md`](install-for-agents.md)（[英文原文](../install-for-agents.md)）交给编码 Agent 自动完成上述步骤。

<a id="release-compose-files"></a>

Docker 方案要求系统已安装 Docker Engine 及 Compose 插件。下列命令以包含 `curl` 和 `openssl` 的 Linux / macOS Shell 为准。每次发布都会在仓库 `deploy/` 目录与 GitHub Releases 附件中提供两份官方 Compose 模板：

- **`compose.full.yml`** — [全新安装](#全新安装)：CPA + OMC + 自动更新器（`oh-my-cpa-updater`）。
- **`compose.omc.yml`** — [独立部署](#独立部署)：在现有 CPA 旁运行 OMC + 自动更新器。

两份模板默认均以非 root 用户 `10001:10001`、只读根文件系统、丢弃全部 Linux Capabilities 与 `no-new-privileges:true` 启动 OMC；默认使用 Docker 命名卷 `oh-my-cpa-data` 存储 SQLite 数据库（首次启动无需手动 `mkdir` 或 `chown`），内置用于控制台一键更新的 `oh-my-cpa-updater`，并自动读取同目录下的 `.env` 覆盖项。

## 全新安装

使用 `compose.full.yml` 一次性部署 CPA、OMC 与更新器。

1. 创建目录并下载 `compose.full.yml` 与 CPA 初始配置：

   ```bash
   mkdir -p oh-my-cpa && cd oh-my-cpa
   curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.full.yml -o compose.yml
   curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/cpa.config.example.yaml -o config.yaml
   ```

   首次启动前必须先创建 `config.yaml`：若宿主机缺少要挂载的文件，Docker 会将其创建为空目录。示例配置已启用 OMC 所需的远程管理与用量统计功能，且不含任何客户端密钥。

2. 在 `.env` 中生成两个密钥。`CPA_MANAGEMENT_KEY` 既是 CPA 的管理密钥也是控制台登录密码；`OMCPA_MASTER_KEY` 用于加密 OMC 数据库中的敏感数据：

   ```bash
   cat > .env <<EOF
   CPA_MANAGEMENT_KEY=$(openssl rand -hex 24)
   OMCPA_MASTER_KEY=$(openssl rand -hex 32)
   EOF
   chmod 600 .env
   ```

3. 启动服务：

   ```bash
   docker compose up -d
   ```

4. 在浏览器打开 **`http://127.0.0.1:8080/`**，输入 `.env` 中的 `CPA_MANAGEMENT_KEY` 登录。

新部署的 CPA 最初不含任何提供商与客户端密钥，请在控制台中添加后再发送推理请求。客户端请求默认发往 CPA 地址 `http://127.0.0.1:8317`。

启动后目录结构说明：

- `config.yaml`、`auths/`、`logs/` 与 `plugins/` 归 CPA 使用，三个目录会在首次启动时自动创建。
- OMC 数据库默认保存在 `oh-my-cpa-data` Docker 命名卷中（初始化自镜像内属主为 `10001:10001` 的 `/data`）。若希望改为宿主机目录，请参阅[存储与目录权限](#存储与目录权限)。
- `.env` 保存密钥以及可选配置覆盖项（例如当宿主机 `8080` 端口被占用时设置 `OMCPA_BIND`；见[端口、存储与常用配置](#端口存储与常用配置)）。
- `oh-my-cpa-updater` 负责执行控制台触发的容器更新（见[升级](#升级)），它是唯一挂载 `/var/run/docker.sock` 的容器。若希望改为手动更新，可从 `compose.yml` 中删除 `oh-my-cpa-updater` 服务（如已启动还需执行 `docker rm -f oh-my-cpa-updater`）。

## 独立部署

使用 `compose.omc.yml` 在已有 CPA（位于宿主机、另一个 Docker Compose 项目或另一台服务器）旁运行 OMC 与更新器。该方式不会修改或重启现有的 CPA、配置、密钥及其他管理面板。

1. 创建目录并下载 `compose.omc.yml`：

   ```bash
   mkdir -p oh-my-cpa && cd oh-my-cpa
   curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.omc.yml -o compose.yml
   ```

2. 创建 `.env`，写入新生成的 `OMCPA_MASTER_KEY`、CPA 可达地址及现有 CPA 的明文管理密钥（登录界面输入的原始密钥，而非 `config.yaml` 里的 bcrypt 哈希）。建议用单引号包裹 `OMCPA_CPA_MANAGEMENT_KEY`，避免 Docker Compose 将密钥里的 `$` 当作环境变量展开（若密钥本身含单引号 `'`，写为 `\'`）：

   ```bash
   printf 'OMCPA_CPA_BASE_URL=http://host.docker.internal:8317\nOMCPA_MASTER_KEY=%s\n' "$(openssl rand -hex 32)" > .env
   cat >> .env <<'EOF'
   OMCPA_CPA_MANAGEMENT_KEY='<CPA 明文管理密钥>'
   EOF
   chmod 600 .env
   ```

   编辑 `.env` 填入实际密钥，并根据[连接现有 CPA](#连接现有-cpa) 调整 `OMCPA_CPA_BASE_URL`（若 CPA 在另一个 Docker 项目中，还需配置网络变量）。如果 CPA 时区不是 UTC，请在 `.env` 中加入 `TZ=<CPA 所在时区>` 保持日历切分一致。

3. 启动 OMC 与更新器：

   ```bash
   docker compose up -d
   ```

4. 打开 **`http://127.0.0.1:8080/`**，使用 CPA 管理密钥登录。

### 连接现有 CPA

OMC 运行在容器内，`OMCPA_CPA_BASE_URL` 必须是容器内部能够访问的地址。

| CPA 运行位置 | `.env` 配置 |
| --- | --- |
| 同一宿主机，监听全部网卡（`:8317` 或 `0.0.0.0:8317`） | `OMCPA_CPA_BASE_URL=http://host.docker.internal:8317` |
| 同宿主机上的另一个 Docker Compose 项目 | `OMCPA_CPA_BASE_URL=http://<CPA 服务名或容器名>:8317`<br>`OMCPA_NETWORK_NAME=<CPA 的 Docker 网络名>`<br>`OMCPA_NETWORK_EXTERNAL=true` |
| 另一台服务器 | `OMCPA_CPA_BASE_URL=https://<CPA 主机>:8317`（或内网地址） |
| 同一宿主机，且仅监听 `127.0.0.1` | 桥接容器无法访问宿主机回环地址。请改用宿主机上的[原生可执行文件](#原生可执行文件)或[从源码构建](#从源码构建) |

通过 `.env` 中的 `OMCPA_NETWORK_NAME` 和 `OMCPA_NETWORK_EXTERNAL=true` 加入 CPA 所在网络，无需改动任一方的 `compose.yml`。可使用以下命令查看 CPA 容器所在的网络名：

```bash
docker inspect <cpa-container> --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

CPA 会把容器内的 OMC 视作远程管理客户端。如果 OMC 正常启动但 `/api/healthz` 返回 `"status":"degraded"` 且 `"cpa_connected":false`，请检查 CPA 的 `config.yaml` 中是否开启了 `management.allow-remote: true`（旧版 v7 配置为 `remote-management.allow-remote`）。开启远程管理后，任何能访问 CPA 端口的主机均可尝试验证管理密钥，请勿将 CPA 端口直接暴露到公网。

## 并入现有编排文件

如果 CPA 已在 Docker Compose 中运行且不想修改原 Compose 文件，推荐直接采用[独立部署](#独立部署)并设置 `OMCPA_NETWORK_NAME` 与 `OMCPA_NETWORK_EXTERNAL=true`。

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

编辑 `.env` 替换 `<CPA 明文管理密钥>`（若已有其他管理面板在消费 CPA 的 Redis 用量队列，可加设 `OMCPA_USAGE_INGEST_MODE=off`；详见[与其他管理面板共存](#与其他管理面板共存)）。

仅启动新增服务，避免重建或重启正在运行的 CPA 容器：

```bash
docker compose up -d oh-my-cpa oh-my-cpa-updater
```

打开 **`http://127.0.0.1:8080/`** 并使用 CPA 管理密钥登录。

## 与其他管理面板共存

其他管理面板（如 `cpamp`）可以与 OMC 并行运行。两者共享同一套 CPA 管理 API，在任一面板修改提供商或配置都会同步生效，OMC 不会导入其他面板的历史记录或本地设置。如果已有其他组件在消费 CPA 的 Redis 用量队列，请合理设置 `OMCPA_USAGE_INGEST_MODE`，避免多个消费者争抢 `RPOP`/`BLPOP` 队列记录。

<a id="settings"></a>

## 端口、存储与常用配置

Compose 从 `compose.yml` 所在目录读取 `.env`，其中的相对路径亦相对该目录解析。

### 必填配置

| 变量 | 适用范围 | 用途 |
| --- | --- | --- |
| `OMCPA_MASTER_KEY` | 所有安装方式 | 64 位十六进制密钥（`openssl rand -hex 32`），用于加密 OMC SQLite 数据库。请妥善备份，写入数据后切勿更改 |
| `CPA_MANAGEMENT_KEY` | `compose.full.yml` | 同时设置新 CPA 的 `MANAGEMENT_PASSWORD` 与 OMC 的 `OMCPA_CPA_MANAGEMENT_KEY` |
| `OMCPA_CPA_BASE_URL` | `compose.omc.yml` / 原生部署 | 现有 CPA 网关的可访问地址 |
| `OMCPA_CPA_MANAGEMENT_KEY` | `compose.omc.yml` / 原生部署 | 现有 CPA 的明文管理密钥（也是控制台登录密码） |

### 常用可选项

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMCPA_BIND` | `127.0.0.1:8080` | 映射到容器 `8080` 端口的宿主机 `[ip:]port`（例如当 `8080` 被占用时设为 `127.0.0.1:18317`） |
| `CPA_BIND` | `127.0.0.1:8317` | 映射到 CPA `8317` 端口的宿主机 `[ip:]port`（仅 `compose.full.yml`） |
| `OMCPA_DATA_PATH` | `oh-my-cpa-data` | 默认使用命名卷，也可填写宿主机目录路径如 `./oh-my-cpa-data` |
| `OMCPA_USER` | `10001:10001` | 运行 `oh-my-cpa` 容器的非 root `uid:gid`（挂载宿主机目录时需保证可写；默认命名卷归 `10001:10001` 所有） |
| `TZ` | `UTC`（Docker）/ 系统时区（原生） | 服务器日历时区，建议与 CPA 保持一致（例如 `Asia/Shanghai`） |
| `OMCPA_PUBLIC_URL` | 空 | 浏览器访问的外部根地址（例如 `https://omc.example.com`）。以 `https://` 开头时会为会话 Cookie 添加 `Secure` 标志 |
| `OMCPA_TRUSTED_PROXY_CIDRS` | 空 | 逗号分隔的受信任反向代理 IP/CIDR，用于解析 `X-Forwarded-For` 做客户端登录限流 |
| `OMCPA_BASE_PATH` | `/` | 将 OMC 挂载在子路径（如 `/omc`）时的 URL 前缀 |
| `OMCPA_DEFAULT_LANGUAGE` | 空 | 为访客固定控制台默认语言：`zh`、`zh-Hant`、`en`、`ms` 或 `auto`；留空或 `auto` 时按浏览器语言决定 |
| `OMCPA_NETWORK_NAME` | `oh-my-cpa` / `oh-my-cpa-standalone` | Docker 网络名称 |
| `OMCPA_NETWORK_EXTERNAL` | `false` | 在 `compose.omc.yml` 中设为 `true` 以加入已有 Docker 网络 |
| `CPA_CONFIG_PATH`、`CPA_AUTH_PATH`、`CPA_LOG_PATH`、`CPA_PLUGIN_PATH` | `./config.yaml`、`./auths`、`./logs`、`./plugins` | `compose.full.yml` 中 CPA 持久化文件路径 |
| `OMCPA_IMAGE` / `CPA_IMAGE` | `wiziscool/oh-my-cpa:latest` / `eceasy/cli-proxy-api:latest` | 固定镜像版本标签或摘要 |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | 挂载至 `oh-my-cpa-updater` 的宿主机 Docker Socket 路径 |

### 内置默认值（通常无需在 `.env` 中显式声明）

镜像和二进制内置了合理的默认值，仅在需要覆盖时设置：

- `OMCPA_LISTEN_ADDR=:8080`（原生模板 `deploy/native.env.example` 默认设为 `127.0.0.1:8080`）
- `OMCPA_DATA_DIR=/data`（容器内）或 `./data`（原生二进制）
- `OMCPA_BASE_PATH=/`
- `OMCPA_USAGE_INGEST_MODE=auto`，`OMCPA_CPA_USAGE_ADDR` 自动取自 `OMCPA_CPA_BASE_URL` 的 host:port
- `OMCPA_UPDATE_CHECK_ENABLED=true` 且 `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD=true`
- `OMCPA_UPDATER_ENABLED=true` 且 `OMCPA_UPDATER_URL=http://oh-my-cpa-updater:8090`

完整环境变量说明请参阅[配置与运维指南](operations.md)。

### 修改端口

宿主机 `8080` 端口被其他服务占用时，修改方式取决于运行模式：

1. **标准 Docker Compose（桥接网络）**：
   只修改 `.env` 中的宿主机映射 `OMCPA_BIND`（例如改为 `18317`）：

   ```dotenv
   OMCPA_BIND=127.0.0.1:18317
   ```

   请保持 `ports:` 右侧容器端口为 `:8080`（`${OMCPA_BIND:-127.0.0.1:8080}:8080`）。容器内进程和内置健康检查仍监听 `:8080`。如果直接改了右侧容器端口而未改 `OMCPA_LISTEN_ADDR`，流量将被转发到无进程监听的端口。

2. **原生可执行文件**（或自行采用 `network_mode: host` 并将 `OMCPA_LISTEN_ADDR` 传入容器 `environment:` 的场景）：
   由于没有容器端口映射层，直接在 `.env` 中设置 `OMCPA_LISTEN_ADDR`：

   ```dotenv
   OMCPA_LISTEN_ADDR=127.0.0.1:18317
   ```

修改宿主机端口后，请同步更新浏览器访问地址、本地健康检查 URL 与反向代理上游地址。

### 存储与目录权限

两份官方 Compose 文件默认配置为 `volumes: - ${OMCPA_DATA_PATH:-oh-my-cpa-data}:/data`。未设置 `OMCPA_DATA_PATH` 时，Docker 会自动创建 `oh-my-cpa-data` 命名卷并继承镜像 `/data` 的权限（`10001:10001`，`0700`），无需手动创建目录。使用该命名卷时请保持默认的 `OMCPA_USER=10001:10001`。

如果希望将 SQLite 数据库放在 `compose.yml` 同级宿主机目录（如 `./oh-my-cpa-data`），请在 `.env` 中配置：

```dotenv
OMCPA_DATA_PATH=./oh-my-cpa-data
```

挂载宿主机目录时 Docker 不会自动修改目录属主，且容器以非 root 用户运行。可通过以下任一方案使目录属主与容器进程一致：

- **方案 A — 以当前宿主机用户运行容器（无需 `sudo chown`）**：

  ```bash
  mkdir -p -m 700 ./oh-my-cpa-data
  printf 'OMCPA_DATA_PATH=./oh-my-cpa-data\nOMCPA_USER=%s:%s\n' "$(id -u)" "$(id -g)" >> .env
  ```

  切勿将主服务设为 `OMCPA_USER=0:0`。

- **方案 B — 保持容器默认 `10001:10001` 并修改宿主机目录属主**：

  ```bash
  mkdir -p -m 700 ./oh-my-cpa-data
  sudo chown -R 10001:10001 ./oh-my-cpa-data
  echo "OMCPA_DATA_PATH=./oh-my-cpa-data" >> .env
  ```

重要规则：
- 修改 `OMCPA_USER` 只影响进程运行身份，不会自动修改磁盘上已有文件的属主。
- 修改 `OMCPA_DATA_PATH` 会切换容器挂载的数据位置，不会自动把命名卷中的旧数据搬迁到新目录。
- 严禁在 OMC 运行期间直接拷贝正在使用的 SQLite 文件；请先停服或使用[SQLite 运维与备份手册](ops/sqlite-operations.md)中的在线备份与导出功能。

## 远程访问与反向代理

默认 Compose 仅监听 `127.0.0.1`。从另一台机器临时访问可通过 SSH 端口转发：

```bash
ssh -L 18080:127.0.0.1:8080 user@server
```

若需通过 HTTPS 公网访问，请将反向代理指向上游 `127.0.0.1:8080`（或自定义 `OMCPA_BIND` 端口），在 `.env` 中设置外部访问的 `OMCPA_PUBLIC_URL`（`https://...`）及反代节点 IP/CIDR（`OMCPA_TRUSTED_PROXY_CIDRS`）。请勿在未配置 TLS 的情况下直接把 `8080` 暴露到公网。

### 反向代理配置

OMC 将前端页面与 `/api/*` 后端整合在同一个 HTTP 服务与端口（默认 `127.0.0.1:8080`），因此反向代理**只需转发一个上游端口**，根路径 `/` 无需裁剪或重写路径（若需同时对外代理 CPA 推理端口 `8317`，可另配独立域名或端口；仓库 `deploy/nginx.conf` 提供了完整示例）。

Caddy 示例：

```caddyfile
omc.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

nginx 示例：

```nginx
server {
    listen 80;
    server_name omc.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

配置 HTTPS 反向代理后，在 `.env` 中补全公开地址与反代源 IP/CIDR，然后重建容器使环境变量生效（Docker 桥接模式下，宿主机上的反代访问容器看到的对端 IP 通常是 Docker 网桥网关 IP 而非 `127.0.0.1`；若反代与 OMC 同处宿主机网络命名空间则可使用 `127.0.0.1/32,::1/128`）：

```dotenv
OMCPA_PUBLIC_URL=https://omc.example.com
OMCPA_TRUSTED_PROXY_CIDRS=<proxy-peer-ip-or-cidr>
```

通过代理验证健康状态：

```bash
curl -fsS https://omc.example.com/api/healthz
```

若配置了 `OMCPA_BASE_PATH`（例如 `/omc`），请在反代规则中完整保留该前缀并同时转发前缀本身及其下所有路径。

## 安装为桌面 / 移动应用（PWA）

控制台支持浏览器标准 PWA 安装，可在独立窗口中运行并显示 OMC 图标：

| 平台与浏览器 | 操作入口 |
| --- | --- |
| 桌面端 Chrome / Edge | 地址栏右侧安装图标，或浏览器菜单 → **将此网页安装为应用** |
| Android Chrome | 浏览器菜单 → **安装应用** / **添加到主屏幕** |
| 三星浏览器 | **添加到主屏幕** |
| iOS / iPadOS Safari（及 16.4+ 的 Chrome/Edge/Firefox/Orion） | 分享按钮 → **添加到主屏幕** |
| macOS Safari 17+ | 菜单栏 **文件 → 添加到程序坞** |

浏览器要求站点运行在安全上下文（`https://` 或本机 `http://127.0.0.1` / `localhost`）才提供安装入口。应用不缓存离线业务数据，每次打开都会直接连接线上实例读取最新资源；不同 `OMCPA_BASE_PATH` 各自对应独立的应用身份。

## 原生可执行文件

[GitHub Releases](https://github.com/WizisCool/oh-my-cpa/releases) 为 Darwin（macOS）、Windows、Linux 与 FreeBSD 提供 **amd64** 与 **arm64** 预编译包（Unix 为 `.tar.gz`，Windows 为 `.zip`）。可执行文件已内嵌前端控制台与 IANA 时区库，无需安装 Node、Go 或 Docker，HTTPS 使用系统证书库；CPA 仍需独立安装（v8.0.0+）。Darwin 与 Windows 二进制未签名，请务必先核对 SHA-256 校验和。

以 Linux amd64 为例：

```bash
VERSION=MAJOR.MINOR.PATCH
OS=linux
ARCH=amd64
ASSET="oh-my-cpa_${VERSION}_${OS}_${ARCH}.tar.gz"
mkdir -p oh-my-cpa && cd oh-my-cpa &&
curl -fLO "https://github.com/WizisCool/oh-my-cpa/releases/download/v${VERSION}/${ASSET}" &&
curl -fLO "https://github.com/WizisCool/oh-my-cpa/releases/download/v${VERSION}/checksums.txt" &&
grep -F "  $ASSET" checksums.txt | sha256sum -c - &&
tar -xzf "$ASSET" &&
cp -n .env.example .env &&
chmod 600 .env
```

Windows 可从同一发布页下载 `.zip` 与 `checksums.txt`，用 PowerShell `Get-FileHash -Algorithm SHA256` 比对后执行 `Expand-Archive`，复制 `.env.example` 为 `.env` 并用文件系统 ACL 限制目录与 `.env` 访问权限。

编辑 `.env` 设置 `OMCPA_MASTER_KEY`（64 位十六进制随机串）、`OMCPA_CPA_BASE_URL`、`OMCPA_CPA_MANAGEMENT_KEY` 与一致的 `TZ`；保持 `OMCPA_VERSION` 留空以保留构建内嵌版本号。模板默认监听 `127.0.0.1:8080` 并把 SQLite 存在工作目录下的 `./data`。然后运行 `./oh-my-cpa`（Windows 为 `.\oh-my-cpa.exe`），验证[安装与连通性](#安装验证与排障) 后打开 `http://127.0.0.1:8080/`。

原生部署升级步骤：先停止 `oh-my-cpa` 进程，备份 `.env` 与数据目录，校验并解压新版本包后替换可执行文件，保持原工作目录、`.env` 与数据目录不变再次启动。

## 从源码构建

需要 Go 1.26+、Node.js 22+、pnpm 11+ 与运行中的 CPA：

```bash
git clone https://github.com/WizisCool/oh-my-cpa.git
cd oh-my-cpa
pnpm install --frozen-lockfile
cp .env.example .env
```

在 `.env` 中填好 `OMCPA_MASTER_KEY`、`OMCPA_CPA_MANAGEMENT_KEY` 与 `OMCPA_CPA_BASE_URL`，然后编译并启动：

```bash
pnpm build
go build -trimpath -o bin/oh-my-cpa ./cmd/oh-my-cpa
./bin/oh-my-cpa
```

服务在前台运行，可使用 systemd 等服务管理器托管。真实环境变量优先级高于 `.env`，也可用 `OMCPA_ENV_FILE` 指定配置文件路径。

## 安装验证与排障

```bash
curl -fsS http://127.0.0.1:8080/api/healthz
```

正常部署会返回 `"status":"ok"` 与 `"cpa_connected":true`。若只返回 Docker healthy 但 `cpa_connected` 为 `false`，控制台会以 `"status":"degraded"` 启动并提示连接问题。

| 症状 | 原因定位 | 处理办法 |
| --- | --- | --- |
| `docker compose up` 报错 `Bind for 127.0.0.1:8080 failed: port is already allocated` | 宿主机端口 `8080` 已被占用 | 在 `.env` 中设置 `OMCPA_BIND=127.0.0.1:18317`（若 CPA `8317` 冲突则设 `CPA_BIND`），不要改容器端口 `:8080` |
| 修改 `ports:` 后容器运行但浏览器无法访问 | 容器端口被改离 `:8080` 导致与进程监听端口不匹配 | 恢复 `${OMCPA_BIND:-127.0.0.1:8080}:8080`，仅调整 `.env` 中的 `OMCPA_BIND` |
| 日志提示 `listen on ... address already in use` | 原生二进制或 `host` 网络容器中 `:8080` 已被占用 | 在 `.env` 设置 `OMCPA_LISTEN_ADDR=127.0.0.1:18317` |
| 日志提示 `data directory /data is not writable by uid:gid ...: permission denied` | 宿主机挂载目录权限与 `OMCPA_USER` 不匹配 | 保持默认命名卷与 `10001:10001`，或对宿主机目录执行 `chown 10001:10001` / 在 `.env` 指定宿主机的 `OMCPA_USER=<uid>:<gid>` |
| CPA 启动失败且 `config.yaml` 变成目录 | 首次启动前未创建 `config.yaml` 文件 | 停服删除 `config.yaml/` 目录，重新下载 `cpa.config.example.yaml` 为 `config.yaml` 后启动 |
| `/api/healthz` 返回 `degraded`（`cpa_connected: false`） | `OMCPA_CPA_BASE_URL` / `OMCPA_CPA_MANAGEMENT_KEY` 有误或 CPA 拒绝远程管理 | 对照[连接现有 CPA](#连接现有-cpa) 检查网络与地址，必要时在 CPA `config.yaml` 设置 `management.allow-remote: true` |
| 登录成功后立刻跳回登录页 | `OMCPA_PUBLIC_URL` 以 `https://` 开头（Cookie 标记 `Secure`），但当前通过 `http://` 访问 | 本地 HTTP 访问请留空 `OMCPA_PUBLIC_URL`，或改由 HTTPS 反代地址访问 |
| 控制台提示升级 CPA | CPA 版本低于 v8.0.0 | 将 CPA 升级至 v8.0.0 或更高版本 |
| 请求记录长期为空 | 设置了 `OMCPA_USAGE_INGEST_MODE=off`、CPA 未开启统计，或被其他面板抢先消费队列 | 开启 CPA 用量统计并确保仅有一个消费者读取用量队列 |

## 升级

版本升级会自动执行只增不改（forward-only）的数据库迁移，不支持直接降级，回退必须依赖数据备份。每次迁移前 OMC 都会自动制作一份加密快照；手动与定时备份/恢复步骤详见 [SQLite 运维与恢复手册](ops/sqlite-operations.md)。`.env` 文件需单独备份。

### 现有部署升级兼容性说明

常规升级（在控制台点击**立即更新**，或沿用原有 `compose.yml` 与 `.env` 执行 `docker compose pull && docker compose up -d`）会完整保留原有数据挂载、用户权限、端口、网络与 `OMCPA_BASE_PATH`。

仅当你**用最新版模板替换了旧版 Compose 文件**时，需注意以下两项变更：

- **早期 `deploy/compose.*.yml` 宿主机挂载路径**：旧版子目录下的模板曾默认使用 `../oh-my-cpa-data` 与 `../cpa/...`；新版默认改为命名卷 `oh-my-cpa-data` 与 `./config.yaml` 等。替换模板前请在 `.env` 中显式固定旧路径：
  ```dotenv
  OMCPA_DATA_PATH=../oh-my-cpa-data
  # 全家桶模板还需保留：
  CPA_CONFIG_PATH=../cpa/config.yaml
  CPA_AUTH_PATH=../cpa/auths
  CPA_LOG_PATH=../cpa/logs
  CPA_PLUGIN_PATH=../cpa/plugins
  ```
- **早期默认 `/omc` 子路径部署**：旧部署如未显式配置 `OMCPA_BASE_PATH` 但反代仍期望 `/omc`，升级前请在 `.env` 补上 `OMCPA_BASE_PATH=/omc`。

### 在控制台中一键更新

发现新版本时，**系统信息**页会在 Oh My CPA 或 CLIProxyAPI 旁显示**立即更新**。确认后 `oh-my-cpa-updater` 会依次：

1. 拉取新镜像（OMC 强制拉取经签名清单校验的不可变镜像摘要，CPA 拉取当前容器所用的镜像标签）；
2. 停止旧容器并沿用原环境变量、数据卷、端口、网络与 Compose 标签重建新容器；
3. 等待新容器健康检查通过后移除旧容器；若新容器异常退出或不健康，则清理新容器并重启旧容器完成自动回滚。

在以下三种情形中页面不提供自动更新按钮并给出说明：镜像固定了版本号或摘要（如 `wiziscool/oh-my-cpa:vX.Y.Z`）、CPA 未以同机容器方式运行、或从源码编译的构建未内置发布签名公钥。

### 为已有部署启用控制台自动更新

如果旧版部署最初未包含 `oh-my-cpa-updater`，在 Docker 宿主机执行一条命令即可启用（无需修改 `compose.yml`）：

```bash
docker run --rm --pull always -u 0 -v /var/run/docker.sock:/var/run/docker.sock wiziscool/oh-my-cpa:latest updater install
```

该命令会自动定位正在运行的 OMC 与 CPA 容器（多实例时可用 `--container` / `--cpa-container` 指定），创建 `oh-my-cpa-updater` 容器并把当前 OMC 升级至最新版本。如需移除，运行 `docker rm -f oh-my-cpa-updater`。请注意 `oh-my-cpa-updater` 挂载了宿主机 Docker Socket，而主服务 `oh-my-cpa` 始终保持非 root（`10001:10001`）、只读与无 Socket 权限隔离（详见[配置与运维指南](operations.md)）。

### 手动升级

在 `compose.yml` 所在目录执行：

```bash
docker compose pull oh-my-cpa oh-my-cpa-updater
docker compose up -d --no-deps oh-my-cpa oh-my-cpa-updater
```

如未启用 `oh-my-cpa-updater`，从两条命令中去掉该服务名即可。若要切换至指定版本，可在 `.env` 中设置 `OMCPA_IMAGE=wiziscool/oh-my-cpa:vX.Y.Z`。

## 约束条件

- 务必安全保管且不要更换 `OMCPA_MASTER_KEY`，否则已加密数据将无法解密。
- 每个本地磁盘数据目录只能运行一个 OMC 实例。
