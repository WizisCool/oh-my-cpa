# 配置与运维指南

完成[安装指南](install.md)后的日常运维参考：Oh My CPA 的全部配置项、部署边界、自动更新机制、Agent 与 MCP 接入、模型目录以及配额刷新与窗口预热说明（[英文原版](../operations.md)）。数据库备份与恢复请另阅 [SQLite 运维与恢复手册](ops/sqlite-operations.md)。

## 原生部署说明

原生发布支持 Darwin、Windows、Linux 与 FreeBSD 的 amd64/arm64 架构。单可执行文件已内嵌前端控制台与 IANA 时区库，HTTPS 请求直接使用系统根证书。自带环境模板默认绑定本地回环接口并将数据保存在 `./data`。请使用专用运行账号托管进程并收紧 `.env` 与数据目录的文件权限，留空 `OMCPA_VERSION` 以保留编译内嵌版本号。升级原生程序前请停止 OMC 并备份 `.env` 与数据目录。

## 环境变量配置

OMC 从环境变量读取全部配置，同时也会读取工作目录下的 `.env` 文件（可用 `OMCPA_ENV_FILE` 指定其他路径）；进程环境变量优先于 `.env`。所有字段定义以 `internal/config/config.go` 为准，格式非法会在启动时直接报错退出。

Docker 容器仅能读取其 Compose `environment:` 段显式传递的变量。沿用旧版 Compose 模板时，新增的环境变量需同时补充到 `environment:` 区块中才能传入容器。

### 必填项

| 变量 | 用途 |
| --- | --- |
| `OMCPA_CPA_BASE_URL` | CPA 服务地址，例如 `http://127.0.0.1:8317` |
| `OMCPA_CPA_MANAGEMENT_KEY` | CPA 明文管理密钥，同时作为控制台登录密码 |
| `OMCPA_MASTER_KEY` | 静态加密主密钥：64 位十六进制串（`openssl rand -hex 32`）或至少 32 字节 |

### 服务与访问

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMCPA_VERSION` | 内嵌发布标签（未打标源码构建为 `v0.1.0-dev`） | 仅覆盖显示与 User-Agent 版本号，不改变程序功能 |
| `OMCPA_LISTEN_ADDR` | `:8080` | 进程监听地址（原生模板默认 `127.0.0.1:8080`；Docker 桥接模式改宿主机端口请使用 `OMCPA_BIND`） |
| `OMCPA_BASE_PATH` | `/` | 子路径前缀，默认挂在根路径 `/`；子路径会自动规范化并去掉末尾斜杠 |
| `OMCPA_DEFAULT_LANGUAGE` | 未设置（跟随浏览器） | 为控制台设定全局默认语言：`zh`、`zh-Hant`、`en`、`ms` 或 `auto`；用户在浏览器内手动切换过语言后以用户选择为准 |
| `OMCPA_DATA_DIR` | `/data`（镜像）/ `./data`（二进制） | 保存 `oh-my-cpa.db` 的本地磁盘目录 |
| `OMCPA_PUBLIC_URL` | 未设置 | 浏览器访问的完整来源地址；为 `https://` 时会话 Cookie 会带上 `Secure` 标记 |
| `OMCPA_TRUSTED_PROXY_CIDRS` | 未设置 | 逗号分隔的受信任反向代理 CIDR，用于依据转发头识别客户端真实 IP 进行登录限流 |
| `TZ` | 系统时区 | 服务器日历时区，详见[时区设置](#时区设置) |

### 网关连接

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMCPA_CPA_USAGE_ADDR` | 取自 `OMCPA_CPA_BASE_URL` 的 `host:port` | CPA 用量数据流地址 |
| `OMCPA_REQUEST_TIMEOUT` | `15s` | 常规 CPA 管理接口调用超时 |
| `OMCPA_CPA_TLS_SKIP_VERIFY` | `false` | CPA 使用自签名/私有证书时跳过 TLS 校验 |

### 用量采集与数据保留

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMCPA_USAGE_INGEST_MODE` | `auto` | 采集模式：`auto`、`subscribe`、`resp_pull`、`http_pull` 或 `off` |
| `OMCPA_USAGE_IDLE_INTERVAL` | `1s` | 队列为空后的首次轮询等待间隔 |
| `OMCPA_USAGE_MAX_IDLE_INTERVAL` | `10s` | 空闲退避上限，需显著低于 CPA 的 `redis-usage-queue-retention-seconds` |
| `OMCPA_USAGE_BATCH_SIZE` | `1000` | 单次拉取记录上限（1–10000） |
| `OMCPA_USAGE_RETENTION_DAYS` | `90` | 单条请求记录及详情保留天数，`0` 为永久保留；仪表盘聚合统计永久保留。可在 **OMC 设置 → 数据保留** 中热修改 |
| `OMCPA_USAGE_INBOX_RETENTION_DAYS` | `7` | 已解码原始用量载荷在收件箱表中的保留天数，`0` 表示与请求记录同步 |

### 版本检查、更新器、字体与演示

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMCPA_UPDATE_CHECK_ENABLED` | `true` | 控制后台定时检查发布版本与插件更新 |
| `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD` | `true` | 控制打开“系统信息”页时是否触发检查 |
| `OMCPA_OMC_REPO` / `OMCPA_CPA_REPO` | `WizisCool/oh-my-cpa` / `router-for-me/CLIProxyAPI` | 版本检查查询的 GitHub `owner/name` |
| `OMCPA_DEMO_MODE` | `false` | 启用内置演示数据集模式（见[演示模式](#演示模式)） |
| `OMCPA_UPDATER_ENABLED` | `true` | 设为 `false` 时隐藏控制台更新器入口 |
| `OMCPA_UPDATER_URL` | `http://oh-my-cpa-updater:8090` | 更新器控制接口地址 |
| `OMCPA_GOOGLE_FONTS_URL` | `https://fonts.googleapis.com` | 字体库在线安装使用的样式 API 地址（可替换为兼容镜像）；本地上传字体无需外网 |

`oh-my-cpa mcp` stdio 桥接命令仅读取 `OMCPA_SERVER_URL`、`OMCPA_CPA_MANAGEMENT_KEY` 与可选的 `OMCPA_VERSION`。

## 部署约束

- **单副本运行**：SQLite WAL 要求单进程独占写权限，禁止多个实例共享同一 `/data` 目录，也不得置于 NFS/CIFS 等网络文件系统上。
- **主密钥不可丢失**：`OMCPA_MASTER_KEY` 用于加解密数据库敏感凭据与载荷。
- **内嵌框架策略**：文档响应声明 `frame-src 'self' blob:` 以同源承载插件页面，反代切勿放宽为允许任意外部域嵌入。
- **网络安全与反代**：CPA 应处于私网或回环网络内；公网暴露控制台必须配置 HTTPS，且仅将真实直连代理节点列入 `OMCPA_TRUSTED_PROXY_CIDRS`。
- **网关版本**：强制要求 CPA v8.0.0+。CPA v8 可读取原 v7 格式 `config.yaml`，OMC 首次保存配置时会触发其迁移至 v8 结构，但在此之前会自动将原始 YAML 加密备份以便随时下载或回退（见 [CPA v8 集成契约](cpa-v8-compat.md)）。
- **子路径与搜索引擎**：配置了 `OMCPA_BASE_PATH` 时反代须完整保留前缀并转发；所有响应默认附带 `X-Robots-Tag: noindex, nofollow, …` 且支持 `/robots.txt` 禁止收录。
- **容器运行时**：非 root（`10001:10001`）、只读根文件系统，内置健康检查；当 CPA 离线时 `/api/healthz` 返回 `degraded` 而不崩溃退出。

## 轮换 CPA 管理密钥

CPA 管理密钥由部署环境变量统一拥有：它既保护控制台登录会话，也用于 OMC 管理客户端、用量采集和远程 MCP Bearer 鉴权。因此可视化配置页仅以只读方式展示该密钥，普通配置保存与备份恢复不会修改它。

需要轮换密钥时，请在同一维护窗口同步更新双方部署：

1. 备份 `.env` 与 OMC 数据目录；
2. 将 CPA 的管理密钥配置与 OMC 的 `OMCPA_CPA_MANAGEMENT_KEY` 同时更新为同一新值（使用 `compose.full.yml` 时只需更新 `CPA_MANAGEMENT_KEY`）；
3. 重新创建容器使新环境变量生效（`docker compose up -d --force-recreate cpa oh-my-cpa`，单纯 `restart` 不会加载新版 `.env`）；
4. 使用新密钥重新登录（旧密钥签发的会话会立即失效）。

## 时区设置

在环境变量中设置 `TZ=Asia/Shanghai`（或其他 IANA 时区）决定服务器默认日历切分。在 **OMC 设置 → 时区** 中可进一步覆盖控制台展示时区；更改时区后系统会基于 15 分钟聚合桶自动重建本地日统计，而底层已存储请求时间戳保持 UTC 瞬时值语义不变。阶梯计费规则中的独立结算时区仍按规则自身定义执行。

## 更新检查机制

“系统信息”页定时向 `api.github.com` 查询 OMC 与 CPA 最新稳定版信息（遵循 OMC 出站网络策略），每款产品默认享有 15 分钟请求节流保护以避免耗尽 GitHub API 匿名配额（每秒/每小时 60 次；若网关配置了 `server.github-token`，OMC 会在内存中复用该令牌把配额提升至 5,000 次且不将令牌返回前端）。发现新版本时左侧导航栏会亮起提示圆点，也支持单版本忽略。插件列表同样定期通过 CPA 插件源检查可用更新。

关闭后台与开屏请求可分别设置 `OMCPA_UPDATE_CHECK_ENABLED=false` 与 `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD=false`（手动点击**检查更新**仍可触发）。

## 控制台自动更新（`oh-my-cpa-updater`）

更新器使用同一镜像以 `oh-my-cpa updater serve` 模式运行在 Docker 内网 `:8090`，不对外发布端口：

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

安全与网络机制要点：
- **最小职责隔离**：主服务 `oh-my-cpa` 无 Socket 权限、只读且非 root；更新器仅响应两类已鉴权请求（查状态、按产品名升级），校验来自 `OMCPA_MASTER_KEY` 派生的 HMAC Token，不接受外部传入任意镜像名或命令，也不会升级已被版本标签或摘要固定（pin）的容器。
- **签名与防回滚**：OMC 自身更新严格校验证书公钥与 GitHub Release 的 `release-manifest.json.sig` Ed25519 签名后按摘要拉取；新容器健康检查失败时先停止并移除失败容器，再恢复旧容器并重绑关联网络命名空间依赖容器。若残留的 `<name>-omc-previous` 已停止、当前目标容器健康且清理不涉及更新器自身命名空间切换，更新器会在升级前自动清理该历史备份。
- **统一出站代理策略**：在 **OMC 设置 → 网络代理** 中切换系统环境、直连或显式代理后，OMC 的外部请求（版本检查、价格同步、汇率、字体与测活）、CPA 全局 `requests.proxy-url` 及更新器流式拉取镜像都会遵循该路由（支持在控制台、CPA 与更新器容器均支持对应路由时协同生效；配置明文密码与密钥仍全程加密存储）。

## 数据库在线维护

在 **系统信息** 页可执行截断 WAL（`PRAGMA wal_checkpoint(TRUNCATE)`）或空间重建（`VACUUM`）；运行期间串行排队并在磁盘剩余空间不足两倍数据库大小时提前拒绝重建，防止破坏运行中实例。离线维护方法见 [SQLite 运维与恢复手册](ops/sqlite-operations.md)。

## Agent 与 MCP 集成

内置 `/agent` 工作区将对话与授权能力结果发送给用户选择的 CPA 模型：单条消息支持最多 4 张 ≤5 MiB 图片（PNG/JPEG/WebP）与 4 个文本附件（合计 ≤40 KiB），任务在服务端持久运行且支持断线续接重连，可通过停止按钮中断或新建会话释放附件与上下文。

外部编码 Agent 可以通过以下两种方式接入同一套能力注册表（详见 [Agent 能力与 MCP 指南](agent-capabilities.md)）：

| 传输方式 | 连接地址 | 凭据 |
| --- | --- | --- |
| Streamable HTTP（控制台直接提供） | `<控制台 URL>/api/mcp`，如 `https://omc.example.com/api/mcp` | `Authorization: Bearer <CPA 管理密钥>` |
| stdio 桥接（`oh-my-cpa mcp`） | 环境变量 `OMCPA_SERVER_URL` | 环境变量 `OMCPA_CPA_MANAGEMENT_KEY` |

外部 Agent 提交涉及状态变更的高风险操作时不会直接绕过安全边界，而是生成 `pending` 审批单与 `<控制台 URL>/authorize/<id>` 链接，由已登录管理员在浏览器完成确认、密码/密钥录入或 OAuth 登录授权后才执行。只读 SQL 查询工具仅对内置 Agent 开放。

## 模型操练场（Playground）

在 **操作 → 操练场** 选择已存在的客户端密钥与 live `/v1/models` 中的调用点发起实时对话测试（请求将按真实流量计入该密钥配额）。反向代理请禁用响应缓冲并将读超时设为高于 15 秒心跳间隔，刷新页面可无损重连最近 15 分钟内的服务端执行日志。

## 展示偏好与自定义图标

- **展示币种**：在 **OMC 设置 → 数据展示 → 展示币种** 可将仪表盘、请求记录与洞察金额按 Frankfurter 每日缓存汇率折算为 CNY、MYR、JPY、EUR 等货币展示；底层入账与价格编辑仍固定以 USD 结算。
- **TPS 口径**：支持选择是否把首字延迟（TTFT）计入平均输出速率计算，不改写历史记录。
- **自定义图标**：支持上传最多 100 枚静态 PNG/JPEG/WebP/SVG 图标（≤512 KiB，≤1024×1024）并在全站和数据库中随备份持久保存。

## 插件商店与可信插件页面

插件商店默认拉取 CPA 内置源与 [OMC Community 插件源](https://github.com/omc-community/omc-plugins)。来自官方主维护者（`omc-community` / `router-for-me`）的插件经一次确认即可安装，其他社区插件需输入完整插件 ID 二次确认。已安装插件页面由 OMC 同源安全代理托管并带入主题与语言信息，其配置写入请求同样纳入 OMC 串行写锁、审计与改前加密备份门禁。

## 演示模式

设置 `OMCPA_DEMO_MODE=true` 后，OMC 将基于内置演示数据集启动（每次启动自动重建独立的 `oh-my-cpa-demo.db`），无需真实 CPA 与管理密钥即可浏览所有只读功能，并自动拦截登录、凭据修改、插件执行和外部请求。静态 Cloudflare 演示站点构建方法见 [Cloudflare 演示运维](../ops/cloudflare-demo.md)。

## 可用模型目录与定价快照

`/model-square` 页面使用首个已配置客户端密钥读取 CPA 的实时 `/v1/models` 并叠加内置 `models.dev` 元数据快照（发布前 30 天内需通过 `pnpm models:sync` 更新）。

## OAuth 模型规则、路由与配额预热

- **模型规则与路由看板**：OAuth 管理支持设置提供商全局及凭据独立的 `excluded_models` 与别名映射；`/routing` 看板把 API Key、OpenAI 兼容渠道与 OAuth 凭据编排为多级优先级泳道，应用时按看板版本号校验并发冲突并先做配置加密备份。
- **配额观测与冷却**：后端以固定受控端点刷新各提供商配额，并在所有窗口均恢复可用且冷却到期后自动清除 CPA 冷却；局部模型受限（如单模型限流）不会错误地让整个凭据显示不可用。
- **窗口预热（Warmup）**：支持按配额窗口重置、每日定时或固定小时周期自动调度极轻量的激活探测（默认自动挑选价目表中价格大于 0 的最便宜模型，避免白跑免费模型无法激活付费窗口或浪费昂贵模型）；支持拖拽排序，且所有任务在发送请求前先落盘写入不可篡改执行记录并严格防范重发风险。
