# 环境变量

OMC 从环境变量读取全部配置，同时也会读取工作目录下的 `.env` 文件（可用 `OMCPA_ENV_FILE` 指定其他路径）；进程环境变量优先于 `.env`。所有字段定义以 `internal/config/config.go` 为准，格式非法会在启动时直接报错退出。

Docker 容器仅能读取其 Compose `environment:` 段显式传递的变量。沿用旧版 Compose 模板时，新增的环境变量需同时补充到 `environment:` 区块中才能传入容器。

## 必填项

| 变量 | 用途 |
| --- | --- |
| `OMCPA_CPA_BASE_URL` | CPA 服务地址，例如 `http://127.0.0.1:8317` |
| `OMCPA_CPA_MANAGEMENT_KEY` | CPA 明文管理密钥，同时作为控制台登录密码 |
| `OMCPA_MASTER_KEY` | 静态加密主密钥：64 位十六进制串（`openssl rand -hex 32`）或至少 32 字节 |

`compose.full.yml` 改用 `CPA_MANAGEMENT_KEY`：它同时设置新 CPA 的 `MANAGEMENT_PASSWORD` 与 OMC 的 `OMCPA_CPA_MANAGEMENT_KEY`，网关地址指向同一编排中的 CPA。

## Compose 模板

以下变量由官方 Compose 模板读取，而非 OMC 本身。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMCPA_BIND` | `127.0.0.1:8080` | 映射到容器 `8080` 端口的宿主机 `[ip:]port`（例如当 `8080` 被占用时设为 `127.0.0.1:18317`） |
| `CPA_BIND` | `127.0.0.1:8317` | 映射到 CPA `8317` 端口的宿主机 `[ip:]port`（仅 `compose.full.yml`） |
| `OMCPA_DATA_PATH` | `oh-my-cpa-data` | 默认使用命名卷，也可填写宿主机目录路径如 `./oh-my-cpa-data` |
| `OMCPA_USER` | `10001:10001` | 运行 `oh-my-cpa` 容器的非 root `uid:gid`（挂载宿主机目录时需保证可写；默认命名卷归 `10001:10001` 所有） |
| `OMCPA_NETWORK_NAME` | `oh-my-cpa` / `oh-my-cpa-standalone` | Docker 网络名称 |
| `OMCPA_NETWORK_EXTERNAL` | `false` | 在 `compose.omc.yml` 中设为 `true` 以加入已有 Docker 网络 |
| `CPA_CONFIG_PATH`、`CPA_AUTH_PATH`、`CPA_LOG_PATH`、`CPA_PLUGIN_PATH` | `./config.yaml`、`./auths`、`./logs`、`./plugins` | `compose.full.yml` 中 CPA 持久化文件路径 |
| `OMCPA_IMAGE` / `CPA_IMAGE` | `wiziscool/oh-my-cpa:latest` / `eceasy/cli-proxy-api:latest` | 固定镜像版本标签或摘要 |
| `DOCKER_SOCKET_PATH` | `/var/run/docker.sock` | 挂载至 `oh-my-cpa-updater` 的宿主机 Docker Socket 路径 |

## 服务与访问

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMCPA_VERSION` | 内嵌发布标签（未打标源码构建为 `v0.1.0-dev`） | 仅覆盖显示与 User-Agent 版本号，不改变程序功能 |
| `OMCPA_LISTEN_ADDR` | `:8080` | 进程监听地址（原生模板默认 `127.0.0.1:8080`；Docker 桥接模式改宿主机端口请使用 `OMCPA_BIND`） |
| `OMCPA_BASE_PATH` | `/` | 子路径前缀，默认挂在根路径 `/`；子路径会自动规范化并去掉末尾斜杠 |
| `OMCPA_DEFAULT_LANGUAGE` | 未设置（跟随浏览器） | 为控制台设定全局默认语言：`zh`、`zh-Hant`、`en`、`ms` 或 `auto`；用户在浏览器内手动切换过语言后以用户选择为准 |
| `OMCPA_DATA_DIR` | `/data`（镜像）/ `./data`（二进制） | 保存 `oh-my-cpa.db` 的本地磁盘目录 |
| `OMCPA_PUBLIC_URL` | 未设置 | 浏览器访问的完整来源地址；为 `https://` 时会话 Cookie 会带上 `Secure` 标记 |
| `OMCPA_TRUSTED_PROXY_CIDRS` | 未设置 | 逗号分隔的受信任反向代理 CIDR，用于依据转发头识别客户端真实 IP 进行登录限流 |
| `TZ` | 系统时区 | 服务器日历时区，详见[时区设置](../operate/time-zone.md) |

## 网关连接

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMCPA_CPA_USAGE_ADDR` | 取自 `OMCPA_CPA_BASE_URL` 的 `host:port` | CPA 用量数据流地址 |
| `OMCPA_REQUEST_TIMEOUT` | `15s` | 常规 CPA 管理接口调用超时 |
| `OMCPA_CPA_TLS_SKIP_VERIFY` | `false` | CPA 使用自签名/私有证书时跳过 TLS 校验 |

## 用量采集与数据保留

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMCPA_USAGE_INGEST_MODE` | `auto` | 采集模式：`auto`、`subscribe`、`resp_pull`、`http_pull` 或 `off` |
| `OMCPA_USAGE_IDLE_INTERVAL` | `1s` | 队列为空后的首次轮询等待间隔 |
| `OMCPA_USAGE_MAX_IDLE_INTERVAL` | `10s` | 空闲退避上限，需显著低于 CPA 的 `redis-usage-queue-retention-seconds` |
| `OMCPA_USAGE_BATCH_SIZE` | `1000` | 单次拉取记录上限（1–10000） |
| `OMCPA_USAGE_RETENTION_DAYS` | `90` | 单条请求记录及详情保留天数，`0` 为永久保留；仪表盘聚合统计永久保留。可在 **OMC 设置 → 数据保留** 中热修改 |
| `OMCPA_USAGE_INBOX_RETENTION_DAYS` | `7` | 已解码原始用量载荷在收件箱表中的保留天数，`0` 表示与请求记录同步 |

## 版本检查、更新器、字体与演示

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMCPA_UPDATE_CHECK_ENABLED` | `true` | 控制后台定时检查发布版本与插件更新 |
| `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD` | `true` | 控制打开“系统信息”页时是否触发检查 |
| `OMCPA_OMC_REPO` / `OMCPA_CPA_REPO` | `WizisCool/oh-my-cpa` / `router-for-me/CLIProxyAPI` | 版本检查查询的 GitHub `owner/name` |
| `OMCPA_DEMO_MODE` | `false` | 启用内置演示数据集模式（见[演示模式](#演示模式)） |
| `OMCPA_UPDATER_ENABLED` | `true` | 设为 `false` 时隐藏控制台更新器入口 |
| `OMCPA_UPDATER_URL` | `http://oh-my-cpa-updater:8090` | 更新器控制接口地址 |
| `OMCPA_GOOGLE_FONTS_URL` | `https://fonts.googleapis.com` | 字体库在线安装使用的样式 API 地址（可替换为兼容镜像）；本地上传字体无需外网 |



## 更新器

由 `oh-my-cpa-updater` 容器从自身环境读取，安装时均无需设置；见[更新](../operate/updates.md)。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMCPA_UPDATER_LISTEN_ADDR` | `:8090` | 监听地址 |
| `OMCPA_UPDATER_SOCKET` | `/var/run/docker.sock` | 挂载的 Docker Socket |
| `OMCPA_UPDATER_OMC_CONTAINER` | 按镜像自动探测 | 当同宿主机存在多个 OMC 实例时显式指定目标容器 |
| `OMCPA_UPDATER_CPA_CONTAINER` | 按 `OMCPA_CPA_BASE_URL` 解析 | 显式指定 CPA 容器名称 |
| `OMCPA_UPDATER_SELF_CONTAINER` | 自动识别 | 更新器自身容器名或 ID |
| `OMCPA_UPDATER_LINK_NETWORK` | 空 | `updater install` 建立的桥接网络 |
| `OMCPA_UPDATER_HEALTH_TIMEOUT` | `5m` | 更新器等待新容器变为 healthy 的超时时长；显式设置后还会在镜像 `start-period` 过期后继续等待慢迁移完成 |
| `OMCPA_UPDATER_PUBLIC_KEY` | 内置公钥 | 分支构建覆盖签名的 Base64 Ed25519 公钥 |

## MCP 桥接

`oh-my-cpa mcp` stdio 桥接命令仅读取 `OMCPA_SERVER_URL`、`OMCPA_CPA_MANAGEMENT_KEY` 与可选的 `OMCPA_VERSION`；远程 MCP 端点没有独立配置项。见 [Agent 与 MCP](../features/agent.md)。

## 演示模式

设置 `OMCPA_DEMO_MODE=true` 后，OMC 将基于内置演示数据集启动（每次启动自动重建独立的 `oh-my-cpa-demo.db`），无需真实 CPA 与管理密钥即可浏览所有只读功能，并自动拦截登录、凭据修改、插件执行和外部请求。静态 Cloudflare 演示站点构建方法见 [Cloudflare 演示运维](../../ops/cloudflare-demo.md)。
