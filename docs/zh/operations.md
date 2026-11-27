# 运维

已安装控制台的日常运维：各项任务的入口，以及部署必须遵守的约束。全部配置项见[环境变量](reference/environment.md)。

| 任务 | 指南 |
| --- | --- |
| 修改端口，或把数据放到宿主机目录 | [端口与存储](operate/ports-storage.md) |
| 版本提醒与一键更新 | [更新](operate/updates.md) |
| 备份、恢复与数据库维护 | [备份与恢复](ops/sqlite-operations.md) |
| 保管主密钥、轮换管理密钥 | [密钥](operate/keys.md) |
| 选择每日统计使用的日历 | [时区](operate/time-zone.md) |
| 审计外部访问主机、触发方式与离线降级 | [外部请求清单](#外部请求清单) |

## 部署约束

- **单副本运行**：SQLite WAL 要求单进程独占写权限，禁止多个实例共享同一 `/data` 目录，也不得置于 NFS/CIFS 等网络文件系统上。
- **主密钥不可丢失**：`OMCPA_MASTER_KEY` 用于加解密数据库敏感凭据与载荷。
- **内嵌框架策略**：文档响应声明 `frame-src 'self' blob:` 以同源承载插件页面，反代切勿放宽为允许任意外部域嵌入。
- **网络安全与反代**：CPA 应处于私网或回环网络内；公网暴露控制台必须配置 HTTPS，且仅将真实直连代理节点列入 `OMCPA_TRUSTED_PROXY_CIDRS`。
- **网关版本**：强制要求 CPA v8.0.0+。CPA v8 可读取原 v7 格式 `config.yaml`，OMC 首次保存配置时会触发其迁移至 v8 结构，但在此之前会自动将原始 YAML 加密备份以便随时下载或回退（见 [CPA v8 集成契约](cpa-v8-compat.md)）。其中载荷替换规则的 `system`/`developer` 角色、`target.paths` 路径目标及 `{ pattern, replacement }` 正则条目需 CPA v8.0.77+；v8.0.75–v8.0.76 仅支持 `role: user` 与字面量映射，早于 v8.0.75 的版本不支持载荷替换。
- **子路径与搜索引擎**：配置了 `OMCPA_BASE_PATH` 时反代须完整保留前缀并转发；所有响应默认附带 `X-Robots-Tag: noindex, nofollow, …` 且支持 `/robots.txt` 禁止收录。
- **容器运行时**：非 root（`10001:10001`）、只读根文件系统，内置健康检查；当 CPA 离线时 `/api/healthz` 返回 `degraded` 而不崩溃退出。

## 外部请求清单

下表列出 Oh My CPA 服务端、浏览器 SPA 与 `oh-my-cpa-updater` 更新器边车发起的全部内置外部 HTTP(S) 请求。服务端发起的外部下载统一遵循 **OMC 设置 → 网络代理**（`internal/outbound/proxy.go`）；浏览器发起的请求直接经由访问者浏览器网络；开启 `OMCPA_DEMO_MODE=true` 后服务端禁用后台刷新循环并拒绝服务端外部调用。

由运维人员显式配置的业务目标不列入内置表：已配置的 CPA 网关（`OMCPA_CPA_BASE_URL`、`OMCPA_CPA_USAGE_ADDR`）、本地更新器边车（`OMCPA_UPDATER_URL`）、手动连通性测试（`30s`，`internal/api/management_provider_probe.go`，其中 Claude、Gemini 与 Vertex 省略 Base URL 时默认使用 `api.anthropic.com`、`generativelanguage.googleapis.com` 与 `aiplatform.googleapis.com`）与模型列表拉取（`15s`，`internal/api/management_provider_models.go`）指向的提供商地址、远程数据库备份目标及其 Google Drive 或 OneDrive 交互式 OAuth 流程（`internal/backup/rclone_destination.go`、`internal/backup/oauth.go`，令牌交换超时 `30s`，OneDrive 授权含 `https://graph.microsoft.com/v1.0/me/drive`），以及需要用户主动点击才会打开的外部超链接。

| 用途与目标端点（覆盖项） | 发起方 | 触发方式与频率 | 超时与重试 | 受阻或失败时的降级行为 | 代码路径 |
| --- | --- | --- | --- | --- | --- |
| **模型价格与规格同步** — `https://openrouter.ai/api/v1/models?output_modalities=all`（固定地址；上限 `32 MiB`） | 服务端 | 启动时执行一次，此后默认每 `24h` 定时同步（可在定价设置中调整为 `1`–`168h` 或设为 `0` 关闭定时）；支持手动同步（`POST /api/v1/pricing/sync`）；每 `5m` 目录对账优先复用 `15m` 内存缓存与 SQLite 快照，仅在 SQLite 尚无快照且存在未定价模型时请求网络 | 单次 HTTP 超时 `20s`（整次同步截止 `2m`）；不立即重试，等待下次定时周期或手动同步 | 保留 SQLite 中最近一次 OpenRouter 目录与已同步价格；自定义价格与手动关联不受影响；Model Square 规格仅读取本地缓存 | `internal/pricing/openrouter.go`、`internal/pricing/service.go`、`internal/remotedata/fetch.go` |
| **展示货币汇率同步** — `https://api.frankfurter.dev/v2/rates?base=USD`（固定地址；上限 `1 MiB`；拒绝重定向） | 服务端 | 启动时若距 SQLite 中已记录的 `attempted_at_ms` 达到刷新间隔则立即拉取，此后默认每 `24h` 刷新（OMC 设置可调 `1`–`168h` 或设为 `0`）；支持手动刷新（`POST /api/v1/exchange-rates/refresh`） | 单次 HTTP 超时 `20s`（刷新上下文 `30s`）；拉取失败会推进 `attempted_at_ms` 并等待下一个完整周期（仅本地 SQLite 读写失败时每 `5m` 重试） | 断网与重启后继续使用 SQLite 中最近一次完整汇率快照（拒绝残缺响应）；美元计费不受影响，尚无缓存汇率的其他币种显示 `—` | `internal/exchangerate/frankfurter.go`、`internal/exchangerate/service.go`、`internal/exchangerate/policy.go`、`internal/remotedata/fetch.go` |
| **OMC 与 CPA 版本发布检查** — `https://api.github.com/repos/<owner>/<name>/releases?per_page=30&page=1..2`（固定主机 `api.github.com`，仅允许同源重定向；仓库默认 `WizisCool/oh-my-cpa` 与 `router-for-me/CLIProxyAPI`，可通过 `OMCPA_OMC_REPO` / `OMCPA_CPA_REPO` 覆盖；配置了 CPA `server.github-token` 时自动携带；单页上限 `4 MiB`） | 服务端 | `OMCPA_UPDATE_CHECK_ENABLED` 为 `true` 时在首个周期后执行后台巡检（布尔开关，默认 `true`，设为 `false` 关闭后台版本与插件更新巡检；检查间隔在 **OMC 设置**自动刷新控件中配置，默认 `60m`，范围 `15m`–`24h` 或 `0`）；打开“系统信息”页（`OMCPA_UPDATE_CHECK_ON_PAGE_LOAD`）与手动检查（`POST /api/v1/management/system/check-updates`）共同受单产品 `15m` 最小尝试间隔限制；每产品最多翻 2 页（单页缓存附带 `If-None-Match`） | 单次请求 `15s`；不立即重试（失败同样计入 `15m` 冷却，等待下次巡检或窗口结束后的检查） | 保留 SQLite 中已存储的版本索引并展示脱敏后的 `check_error`；发布说明正文仅驻留内存，离线或重启后显示为不可用 | `internal/release/github.go`、`internal/release/service.go`、`internal/release/policy.go`、`internal/api/management_system.go` |
| **仓库 Star 数读取** — `https://api.github.com/repos/WizisCool/oh-my-cpa`（固定主机与固定仓库；配置了 CPA `server.github-token` 时自动携带；上限 `1 MiB`） | 服务端 | 每次后台版本巡检结束时（`OMCPA_UPDATE_CHECK_ENABLED`）及顶栏挂载调用 `GET /api/v1/management/system/repository`（受 `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD` 控制）；全局内存共享 `1h` 最小尝试间隔 | 上下文超时 `5s`（客户端超时 `15s` 内）；不重试（失败同样推进 `1h` 冷却；前端查询设置 `retry: false`） | 首次成功前返回 HTTP `200` 且 `stargazers_count: null`（顶栏仅显示普通 GitHub 链接）；已读取过则在后续失败时继续保留内存中的旧计数 | `internal/release/stargazers.go`、`internal/api/management_system.go`、`web/src/components/common/HeaderNav.tsx` |
| **GitHub 令牌配额探测** — `https://api.github.com/rate_limit`（固定主机 `api.github.com`；拒绝重定向；上限 `64 KiB`） | 服务端 | 仅在 **OMC 设置 → GitHub 令牌** 中点击测试令牌时按需触发（`POST /api/v1/management/github-token/test`） | 超时 `15s`；不重试 | 返回结构化 `invalid` 或 `error` 诊断结果，不改动已保存的 CPA 配置 | `internal/release/rate_limit.go`、`internal/api/management_github_token.go` |
| **OMC 签名发布清单与签名文件** — `https://github.com/<owner>/<name>/releases/download/<tag>/release-manifest.json` 及 `.sig`（仓库取自 `OMCPA_OMC_REPO`；最多 2 次 HTTPS 重定向，仅允许跳转至 `objects.githubusercontent.com` 或 `release-assets.githubusercontent.com`；单文件上限 `64 KiB`） | 服务端 | 仅在控制台触发 Oh My CPA 容器更新时按需下载（`POST /api/v1/management/system/updater/apply`） | 单文件超时 `15s`；不重试 | 失败关闭并返回 HTTP `502`（`manifest_unavailable` 或 `manifest_missing`），同时写入审计日志；运行中的容器保持不变 | `internal/release/manifest.go`、`internal/api/management_system_updater.go` |
| **服务端 Google Fonts 在线安装** — `https://fonts.googleapis.com/css2?...`（可通过 `OMCPA_GOOGLE_FONTS_URL` 切换兼容镜像）及样式表引用的字体文件，限定 `fonts.gstatic.com`、`fonts.gstatic.cn`、`fonts.googleapis.com`、`fonts.googleapis.cn` 或镜像同站点（最多 2 次重定向；上限：CSS `2 MiB`、`600` 个字面、单文件 `32 MiB`、总计 `96 MiB`） | 服务端 | 仅在设置页手动安装 Google Fonts 字体族时按需触发（`POST /api/v1/fonts/google`）；安装完成后写入 SQLite 并由 OMC 同源下发 | 总安装超时 `3m`（HTTP 截止延至 `4m`），最多 8 并发下载切片；CSS 返回 `400`/`404` 时回退一次不带 `:wght@400;700` 的查询；无网络传输重试 | 返回 HTTP `404` 或 `502`，不改动现有字体；已安装字体与离线本地上传（`POST /api/v1/fonts/upload`）完全离线可用 | `internal/fontasset/google.go`、`internal/api/fonts.go` |
| **浏览器 CJK 补充字体** — `https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;600;700&display=swap` 及引用的 `https://fonts.gstatic.com/...` `.woff2` 分片（固定地址；`credentials: 'omit'`、`referrerPolicy: 'no-referrer'`；不受 `OMCPA_GOOGLE_FONTS_URL` 影响） | 浏览器 | 标签页首次可见时每会话注册一次，针对内置 Sarasa Mono SC 分片之外的 CJK/韩文字符按需懒加载 `.woff2` 分片；导出对话 HTML/PNG 与仪表盘小票 PNG 时按需拉取所需分片内嵌 | 显式样式表拉取与导出时拉取采用 `8s` 超时（`AbortSignal.timeout(8000)`）；常规渲染通过 URL 形式的 `FontFace` 由浏览器按需加载 `.woff2` 分片，遵循浏览器默认超时；无自动重试循环（样式表拉取失败会清空缓存 Promise，以便后续导出重新尝试） | 静默跳过远端字体，回退至内置 Sarasa 分片与操作系统本地 CJK 字体；页面展示与导出流程均正常完成 | `web/src/theme/cjkFont.ts`、`web/src/main.tsx`、`web/src/agent/conversationDownload.ts`、`web/src/components/dashboard/receipt/receiptImage.ts` |
| **插件发布方声明的远程图标** — CPA 插件元数据中可选的 `http://` 或 `https://` 图标地址（`logo`、`metadata.logo`、`oauth_provider_entries[].logo`；拒绝带凭据的 URL；内联 `data:image/` 不发请求） | 浏览器 | 渲染插件或插件注册的 OAuth 提供商视图时经隔离 `<img referrerPolicy="no-referrer">` 按需加载，导出请求清单 PNG 时经 `fetch()` 读取；遵循浏览器标准 HTTP 缓存 | 遵循浏览器默认图片/请求超时；无自定义重试 | 页面渲染自动回退至内置提供商图标或默认拼图图标且不阻塞页面；请求清单 PNG 导出会在绘制前等待图标 `fetch()` 完成，主机无响应时导出可能等待至浏览器请求超时，失败后才回退为中性占位框 | `web/src/types/pluginOAuthProviders.ts`、`web/src/components/plugins/PluginIcon.tsx`、`web/src/components/common/MarkArtwork.tsx`、`web/src/components/common/RemoteImage.tsx`、`web/src/components/usage/requestSheetPainter.ts` |
| **OpenUI 外部图片与来源图标** — `@openuidev/react-ui` 组件渲染的外部 `http://`/`https://` 图标（如来源网站 favicon）或 Agent `present_openui` 回答中包含的外部图片 URL（遵循文档 `Referrer-Policy: no-referrer`） | 浏览器 | 浏览实时 `present_openui` 界面以及导出对话 HTML/PNG 进行离屏渲染时（包含当前不可见的界面）按需加载，导出清理随后会从保存文件中剥离非内联地址 | 遵循浏览器默认图片超时；无自定义重试 | 图片加载失败时按浏览器默认占位/回退布局显示，不阻塞控制台；已保存的独立 HTML 导出会剥离非内联资源地址并强制执行 `img-src data:` | `web/src/pages/agent/tools/openui.tsx`、`web/src/agent/openui/staticRender.tsx`、`web/src/agent/conversationDownload.ts`、`web/src/agent/openui/exportMarkup.ts`、`web/src/agent/conversationHtml.ts` |
| **容器镜像拉取** — 运行中 OMC（默认 `wiziscool/oh-my-cpa`，按验签后的 `@sha256:...` 摘要拉取）与 CPA（默认 `eceasy/cli-proxy-api`，按原标签拉取）镜像所属仓库（Docker Hub `registry-1.docker.io` / `auth.docker.io` 及存储重定向，或自定义镜像仓库） | 更新器边车（`oh-my-cpa-updater`）或宿主机 Docker 守护进程 | 仅在未固定版本的容器部署中触发容器更新时按需执行（`POST /api/v1/management/system/updater/apply`，`OMCPA_UPDATER_ENABLED=true`）；默认路由交由 Docker 拉取（`POST /images/create`），`proxy` 或 `direct` 路由由边车拉取并流式导入 Docker（`POST /images/load`） | 边车经 `go-containerregistry` 走 `proxy`/`direct` 拉取超时 `30m`（代理失败绝不回退直连）；默认路由遵循宿主机 Docker 超时（控制台最长监视任务 `45m`） | 在改动运行中容器前将任务终止为 `failed`，或在新容器健康检查失败（`OMCPA_UPDATER_HEALTH_TIMEOUT`，默认 `5m`）时自动回滚 | `internal/updater/service.go`、`internal/updater/engine.go`、`internal/updater/proxy_image.go` |

### 委托 CPA 发起的外部请求

部分外部地址出现在 OMC 代码中是因为 OMC 负责管理 CPA 配置或调用 CPA 管理接口，实际外网请求均由 **CPA** 发起：

- **CPA 模型目录（`models.router-for.me`）**：`https://models.router-for.me/models.json`、`https://models.router-for.me/codex_client_models.json` 与 `https://models.router-for.me/devin_models.json` 在 `web/src/types/configSchema.ts` 中仅作为 CPA `models.catalog`、`models.codex-catalog`、`models.devin-catalog` 配置项的输入框占位示例。Model Square 的**刷新目录**按钮只调用 CPA 管理接口（`POST /v8/management/routing/model-definitions/refresh`，`internal/api/model_square_refresh.go`、`internal/cpa/management/client_model_definitions.go`），由 CPA 自行拉取目录。
- **Oh My CPA 插件注册表（`raw.githubusercontent.com`）**：`https://raw.githubusercontent.com/omc-community/omc-plugins/main/registry.json`（`internal/pluginregistry/registry.go`）在开启 OMC 插件源开关时由 OMC 同步写入 CPA 的 `plugins.store-sources`（`internal/api/management_plugin_source.go`）。注册表与插件包均由 CPA 下载；OMC 的后台与手动插件更新检查（`internal/api/management_plugins.go`）仅查询 CPA 管理接口。
- **上游 OAuth 配额与订阅端点**：`internal/quota/service.go` 与 `internal/quota/devin.go` 白名单中的各提供商配额端点（`chatgpt.com`、`api.anthropic.com`、`daily-cloudcode-pa.googleapis.com`、`daily-cloudcode-pa.sandbox.googleapis.com`、`cloudcode-pa.googleapis.com`、`api.kimi.com`、`api.kimi.ai`、`cli-chat-proxy.grok.com`、`api.x.ai`、`api.meta.ai`、`server.codeium.com`）均经由 CPA 的 `api-call` 管理接口转发，由 CPA 使用受管凭据发起请求。

OMC、CPA 与更新器的出站代理路由说明见[更新](operate/updates.md)，全部环境变量开关见[环境变量](reference/environment.md)。
