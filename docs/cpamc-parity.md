# CPAMC parity matrix

本文档把官方 [Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center) 的功能清单与 Oh My CPA 的实现边界绑定起来。

## 目标与兼容基线

- **目标上游**：`router-for-me/CLIProxyAPI` 的 `/v0/management` API。
- **官方 UI 基线**：CPAMC README 声明 CLIProxyAPI `>= 7.1.0`，推荐使用最新版本。
- **Oh My CPA 原则**：CPA 仍负责代理执行与协议适配；Oh My CPA 负责管理体验、真实 CPA 数据的安全门面，以及资源的用户身份层。
- **密钥边界**：CPA Management Key 只在 Go 进程中解密和使用，浏览器只持有 Oh My CPA 的 HttpOnly 管理员 session。CPA 返回的凭据内容仅通过管理员 session 的受保护管理页面按需展示，UI 默认遮罩。
- **兼容策略**：接口按白名单转发，不提供任意 URL 通用代理；上游不存在的接口以明确的“不支持/需要升级”状态呈现。

## 功能矩阵

状态含义：`已覆盖` = 已有真实接口和页面；`进行中` = 已有基础契约，仍需补齐交互或专项适配；`计划` = 已确认需求，尚未实现。

| 官方功能 | 原型入口 | CPA Management API | Oh My CPA 状态 | 验证方式 |
| --- | --- | --- | --- | --- |
| 管理员登录与连接状态 | 登录、顶部连接胶囊 | 本地 session；服务端调用 `/auth-files` 探活 | 已覆盖 | 登录/登出、无效 session、CPA 断连手工验证 |
| 仪表盘连接、版本、数量、模型概览 | `dashboard` | `/config`、`/auth-files`、`/api-key-usage`、`/latest-version` | 进行中 | 真实 CPA fixture + 空态/断连态 |
| 快速开始与请求示例 | `quick_start` | `/config`、`/api-keys`、固定代理端点 | 进行中 | 从真实配置生成 URL、复制示例 |
| 配置读取 | `config_management` | `GET /config`、`GET /config.yaml` | 已覆盖（已对真实 CPA 7.2.146 验证） | 读取并显示真实 JSON/YAML |
| 配置可视化标量编辑 | `config_management` | `/debug`、`/proxy-url`、`/request-log`、`/logging-to-file`、`/usage-statistics-enabled`、`/request-retry`、`/max-retry-*`、`/ws-auth`、`/force-model-prefix`、`/routing/strategy` | 已覆盖（已对真实 CPA 7.2.146 验证） | 每个白名单端点的 GET/PUT 合约测试与乐观交互 |
| 配置源码编辑与保存 | `config_management` | `PUT /config.yaml` | 已覆盖（已对真实 CPA 7.2.146 验证） | YAML 错误 400、配置错误 422、脏状态保护、Ctrl+S 快捷保存 |
| 代理客户端 API Keys | 配置、快速开始 | `GET/PUT/PATCH/DELETE /api-keys` | 已覆盖 | 独立端点增删、单次明文呈现与脱敏列表 |
| Gemini/Interactions/Codex/Claude/xAI/Vertex Key | `ai_providers` | 各 provider 的 `GET/PUT/PATCH/DELETE /{provider}-api-key` | 已覆盖 | 统一提供商列表、脱敏展示与状态切换 |
| OpenAI 兼容提供商 | `ai_providers` | `GET/PUT/PATCH/DELETE /openai-compatibility` | 已覆盖 | 多 key、端点去敏、模型列表与启停开关 |
| 模型发现 | 提供商操作、快速开始 | CPA `/v1/models`（固定代理调用待专项实现） | 计划 | 需要明确代理 API key 选择与审计边界 |
| 认证文件列表/筛选 | `auth_files` | `GET /auth-files` | 已覆盖（已对真实 CPA 7.2.146 验证） | 真实字段归一化、runtime-only/disabled 空态 |
| 认证文件上传 | `auth_files` | `POST /auth-files` multipart | 已覆盖（已对真实 CPA 7.2.146 验证） | JSON 文件上传、错误文件反馈 |
| 认证文件下载/删除 | 详情/批量操作 | `GET /auth-files/download`、`DELETE /auth-files` | 已覆盖（已对真实 CPA 7.2.146 验证） | 安全文件名、下载内容、批量删除 |
| 认证文件启用/禁用与字段 | 详情/批量操作 | `PATCH /auth-files/status`、`PATCH /auth-files/fields` | 已覆盖（已对真实 CPA 7.2.146 验证） | 状态、priority/weight/note/proxy 等字段 |
| 认证文件模型列表 | 详情 | `GET /auth-files/models` | 已覆盖（真实 CPA 7.2.146 返回 200；旧版本 404 时返回 501 capability_missing） | 旧 CPA 404 时显示能力提示 |
| OAuth 排除模型/别名 | `auth_files` 子页面 | `/oauth-excluded-models`、`/oauth-model-alias` | 计划 | provider key 归一化和通配符专项测试 |
| OAuth 登录 | `oauth` | `GET /{provider}-auth-url`、`GET /get-auth-status`、`DELETE /oauth-session`、`POST /oauth-callback` | 已覆盖 | provider/state 轮询、取消、回调输入；不模拟 token |
| Vertex JSON / iFlow Cookie 导入 | OAuth/认证文件 | `POST /vertex/import` 及 provider 专用流程 | 计划 | 以官方版本能力探测为准 |
| 配额观察 | `quota_management`、凭据详情 | `auth-files` 返回的 quota/model_quotas 观察数据 | 已覆盖 | 凭据详情/抽屉展示、字段级安全过滤 |
| 配额重置 | 配额行操作 | `POST /reset-quota {auth_index}` | 已覆盖 | 只接受稳定 `auth_index`，二次确认、审计与前端重置闭环 |
| 用量队列 | 仪表盘/观测 | `GET /usage-queue?count=N` | 计划 | 明确破坏性消费语义后再提供“读取并确认”操作 |
| API Key 用量桶 | 仪表盘/提供商 | `GET /api-key-usage` | 进行中 | 20 个 10 分钟桶与空态 |
| 实时日志与增量拉取 | `logs` | `GET /logs?after=&cursor=&limit=` | 已覆盖（真实 CPA 7.2.146 验证） | cursor 优先、`after` 回退并回退一秒；`cursor-reset` 重建缓冲；5s 轮询可暂停 |
| 清理日志 | `logs` | `DELETE /logs` | 已覆盖 | 二次确认、清空后重建缓冲 |
| 错误日志文件 | `logs` | `/request-error-logs`、`/request-error-logs/:name` | 已覆盖（真实文件列表 + 下载验证） | 文件名在 Go 侧拒绝穿越，不转发到 CPA |
| 单请求日志下载 | 日志详情 | `GET /request-log-by-id/:id` | 已覆盖（`/usage/events/{id}/request-log`） | 404 视为能力缺失，不渲染成空文件 |
| 插件列表/开关/删除/配置 | `plugins` | `/plugins` 及 `/plugins/:id/*` | 已覆盖 | 启停开关、JSON 配置模态编辑、卸载二次确认与强审计 |
| 插件商店安装 | `plugin_store` | `/plugin-store`、`POST /plugin-store/:id/install` | 已覆盖 | 商店列表、权限审查、安装确认与强审计 |
| 系统版本/更新检查 | `system_info` | `/latest-version`、CPA response headers | 已覆盖 | 真实版本比对、更新提示、不把“检查”误报为“升级完成” |
| 运行自检/诊断 | `system_info` | CPA 探活、管理端点能力探测、脱敏诊断导出 | 已覆盖 | 组件健康拓扑、脱敏诊断包下载、强审计保护 |
| 任意上游 API Call | provider/调试操作 | CPA `POST /api-call` | 计划（显式开关） | 默认关闭；开启前需 SSRF/审计/目标限制设计 |
| 多 CPA 实例 | 顶部连接/系统信息 | Oh My CPA 自有实例模型 | 计划 | 增加实例 CRUD、密钥轮换、实例级权限后实现 |
| Oh My CPA 资源身份层 | 待整理/所有资源 | Oh My CPA 自有 `/api/v1/resources*` | 已覆盖 | 保持用户名称、图标、颜色、备注和状态不被 rediscovery 覆盖 |

## 当前实现顺序

1. **基础替代壳与能力探测**：按照原型落地深色终端式导航、顶部连接状态、响应式布局；未接入完整界面的页面均通过 `GET /api/v1/management/capabilities/{key}` 执行只读安全端点探测，明确区分「接口可用/缺失」与「页面待接线」，杜绝空泛的假就绪状态。
2. **真实管理门面**：Go 端扩展受 session 保护的 CPA 白名单转发，统一处理上游 404/401/422/网络错误和下载响应。
3. **真实高频页面**：Dashboard、Auth Files、Logs 已覆盖；接下来进入 Config、Providers、OAuth、Quota 等日常管理闭环。
4. **专项页面**：Plugins、System、Quick Start 及 provider-specific 能力探测。
5. **安全/兼容收口**：api-call 显式开关、多实例、审计、旧 CPA 版本矩阵、端到端回归。

## 已知限制

- CPA Management API 是持续演进的版本化外部契约，页面必须把 404/405 视为能力缺失而不是空数据。
- **CPA 会把 `/v0/management/*` 调用本身写进日志文件。** 控制台每 5 秒轮询一次，日志里就会出现自己的噪音，因此「隐藏管理流量」必须默认开启；CPAMC 靠隐藏整个日志入口来规避同一问题。
- 文件日志关闭时 CPA 对 `GET /logs` 返回 **400 `logging to file disabled`**。门面把它翻译成 409 `file_logging_disabled`，页面据此解释原因并给出开关位置，而不是报“请求失败”。
- `/usage-queue` 会消费队列记录，不能在普通自动刷新中调用。
- `POST /api-call` 支持由 CPA 代替凭据发起任意上游请求，具有 SSRF 和数据外泄风险，默认不开放。
- 完全替代 CPAMC 不等于复制其浏览器 localStorage 密钥存储；Oh My CPA 保持服务端密钥边界。
