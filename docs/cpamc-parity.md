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
| 仪表盘连接、版本、数量、模型概览 | `dashboard` | `/config`、`/auth-files`、`/api-key-usage`、`/latest-version` | 已覆盖 | `GET /management/overview` 聚合三个只读端点，仪表盘次级区与系统页消费；部分失败以 `partial_errors` 降级而非整页报错 |
| 快速开始与请求示例 | `quick_start` | `/config`、`/api-keys`、固定代理端点 | 已覆盖 | 四步式向导、多客户端配置、端点及 cURL/Python/Node.js 代码示例复制 |
| 配置读取 | `config_management` | `GET /config`、`GET /config.yaml` | 已覆盖（已对真实 CPA 7.2.146 验证） | 读取并显示真实 JSON/YAML |
| 配置可视化标量编辑 | `config_management` | `/debug`、`/proxy-url`、`/request-log`、`/logging-to-file`、`/usage-statistics-enabled`、`/request-retry`、`/max-retry-*`、`/ws-auth`、`/force-model-prefix`、`/routing/strategy` | 已覆盖（已对真实 CPA 7.2.146 验证） | 每个白名单端点的 GET/PUT 合约测试与乐观交互 |
| 配置源码编辑与保存 | `config_management` | `PUT /config.yaml` | 已覆盖（已对真实 CPA 7.2.146 验证） | YAML 错误 400、配置错误 422、脏状态保护、Ctrl+S 快捷保存 |
| 代理客户端 API Keys | 配置、快速开始 | `GET/PUT/PATCH/DELETE /api-keys` | 已覆盖 | 独立端点增删、单次明文呈现与脱敏列表 |
| Gemini/Interactions/Codex/Claude/xAI/Vertex Key | `ai_providers` | 各 provider 的 `GET/PUT/PATCH/DELETE /{provider}-api-key` | 已覆盖 | 统一提供商列表、脱敏展示与状态切换 |
| OpenAI 兼容提供商 | `ai_providers` | `GET/PUT/PATCH/DELETE /openai-compatibility` | 已覆盖 | 多 key、端点去敏、模型列表与启停开关 |
| 模型发现 | 提供商操作、快速开始 | 不经 CPA：直连提供商 `Base URL` 的 `/models`（失败时回退 `/v1/models`）；认证文件模型走 `GET /auth-files/models` | 已覆盖 | `POST /management/providers/pull-models` 由服务端发起并受审计；提供商 URL 与密钥只存在于 Go 侧 |
| 认证文件列表/筛选 | `auth_files` | `GET /auth-files` | 已覆盖（已对真实 CPA 7.2.146 验证） | 真实字段归一化、runtime-only/disabled 空态 |
| 认证文件上传 | `auth_files` | `POST /auth-files` multipart | 已覆盖（已对真实 CPA 7.2.146 验证） | JSON 文件上传、错误文件反馈 |
| 认证文件下载/删除 | 详情/批量操作 | `GET /auth-files/download`、`DELETE /auth-files` | 已覆盖（已对真实 CPA 7.2.146 验证） | 安全文件名、下载内容、批量删除 |
| 认证文件启用/禁用与字段 | 详情/批量操作 | `PATCH /auth-files/status`、`PATCH /auth-files/fields` | 已覆盖（已对真实 CPA 7.2.146 验证） | 状态、priority/weight/note/proxy 等字段 |
| 认证文件模型列表 | 详情 | `GET /auth-files/models` | 已覆盖（真实 CPA 7.2.146 返回 200；旧版本 404 时返回 501 capability_missing） | 旧 CPA 404 时显示能力提示 |
| OAuth 排除模型 | `auth_files` 子页面 | `/oauth-excluded-models`（OMC 侧走 `PATCH /auth-files/fields` 的 `excluded_models`） | 部分：接口已支持，控制台未暴露 | 后端字段白名单已接受 `excluded_models`，抽屉表单只暴露 priority/weight/note；补 UI 后需补通配符与审计测试 |
| OAuth 模型别名 | `auth_files` 子页面 | `/oauth-model-alias` | 计划 | provider key 归一化和通配符专项测试 |
| OAuth 登录 | `oauth` | `GET /{provider}-auth-url`、`GET /get-auth-status`、`DELETE /oauth-session`、`POST /oauth-callback` | 已覆盖 | provider/state 轮询、取消、回调输入；不模拟 token |
| Vertex JSON / iFlow Cookie 导入 | OAuth/认证文件 | `POST /vertex/import` 及 provider 专用流程 | 计划 | 以官方版本能力探测为准 |
| 配额观察 | `quota_management`、凭据详情 | `auth-files` 返回的 quota/model_quotas 观察数据 | 已覆盖 | 凭据详情/抽屉展示、字段级安全过滤 |
| 配额重置 | 配额行操作 | `POST /reset-quota {auth_index}` | 已覆盖 | 只接受稳定 `auth_index`，二次确认、审计与前端重置闭环 |
| 用量队列 | 仪表盘/观测 | `GET /usage-queue?count=N`（RESP 订阅同等） | 已覆盖（服务端采集，无控制台读取动作） | `internal/usage/ingest` 在后台排空队列；控制台不提供“读取并确认”，因为该接口是破坏性消费，暴露给浏览器会与采集器争抢记录。请求记录页的“刷新”通过 `POST /usage/ingest/refresh` 让服务端立刻排空一次（命令交由采集器 goroutine 执行）并等待入库可见，前端不直接碰队列 |
| API Key 用量桶 | 仪表盘/提供商 | `GET /api-key-usage` | 进行中 | 端点已接入 `/management/overview`，仪表盘次级区渲染 provider 级统计；overview 返回的 20 个 10 分钟全局 `traffic` 桶尚未渲染 |
| 实时日志与增量拉取 | `logs` | `GET /logs?after=&cursor=&limit=` | 已覆盖（真实 CPA 7.2.146 验证） | cursor 优先、`after` 回退并回退一秒；`cursor-reset` 重建缓冲；5s 轮询可暂停 |
| 清理日志 | `logs` | `DELETE /logs` | 已覆盖 | 二次确认、清空后重建缓冲 |
| 错误日志文件 | `logs` | `/request-error-logs`、`/request-error-logs/:name` | 已覆盖（真实文件列表 + 下载验证） | 文件名在 Go 侧拒绝穿越，不转发到 CPA |
| 单请求日志下载 | 日志详情 | `GET /request-log-by-id/:id` | 已覆盖（`/usage/events/{id}/request-log`） | 404 视为能力缺失，不渲染成空文件 |
| 插件列表/开关/删除/配置 | `plugins` | `/plugins` 及 `/plugins/:id/*` | 已覆盖 | 启停开关、JSON 配置模态编辑、卸载二次确认与强审计 |
| 插件商店安装 | `plugin_store` | `/plugin-store`、`POST /plugin-store/:id/install` | 已覆盖 | 商店列表、权限审查、安装确认与强审计 |
| 系统版本/更新检查 | `system_info` | `/latest-version`、CPA response headers | 已覆盖 | 真实版本比对、更新提示、不把“检查”误报为“升级完成” |
| 运行自检/诊断 | `system_info` | CPA 探活、管理端点能力探测、脱敏诊断导出 | 已覆盖 | 组件健康拓扑、脱敏诊断包下载、强审计保护 |
| 任意上游 API Call | provider/调试操作 | CPA `POST /api-call` | 部分（仅服务端配额观测） | 面向浏览器的通用 `/api-call` 保持关闭；`internal/quota` 用该端点观测官方配额，目标受 `AllowedURLPrefixes` 编译期白名单限制，不接受用户提供的 URL |
| 多 CPA 实例 | 顶部连接/系统信息 | Oh My CPA 自有实例模型 | 计划 | 增加实例 CRUD、密钥轮换、实例级权限后实现 |

## 当前状态与后续顺序

已落地：Dashboard、Quick Start、AI Providers、OAuth 管理、OAuth 登录、OAuth 配额、Logs、Usage Events、Pricing、Config、Plugins、Plugin Store、System 共 13 个真实路由页面（外加一个重定向兜底），没有任何页面仍靠能力探测占位。

仍依赖能力探测的部分：`GET /api/v1/management/capabilities/{key}` 保留为旧 CPA 版本的只读兼容性探测，用于区分「接口可用/缺失」与「页面待接线」，不得用于冒充功能完成。

后续顺序：

1. **旧版本兼容收口**：为已知会在旧 CPA 上缺失的端点（已确认的有 `/auth-files/models`）统一“能力缺失”文案，并逐步补全其余端点的最低版本矩阵与降级表现。
2. **能力补齐**：OAuth 模型别名、auth-file 字段表单（prefix / proxy_url / disable_cooling / excluded_models / expired）的 UI 接线。
3. **多实例**：实例 CRUD、密钥轮换、实例级权限，需要先写 ADR（当前 `cpa_bindings.instance_id` 已按多实例建模，`/instances/default/*` 仍是单实例硬编码）。

## Oh My CPA 自有能力（CPAMC 无对位）

下列能力不属于 CPAMC 功能清单，但属于本产品的交付面，列在这里避免后续 Agent 把它们当成“超出范围”：

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| 用量请求浏览器 | `/usage/events`、`/usage/events/{id}`、`/usage/events/{id}/request-log`、`/usage/facets`、`/usage/ingest/refresh` | 多选分面（同维度取并集、跨维度取交集）、全局搜索、区间筛选、列布局与视图持久化、单请求详情与原始日志下载；刷新按钮先按需排空 CPA 队列并等到记录可查询，再重读列表与分面 |
| 请求时价格快照与模型目录 | `/pricing`、`/pricing/models`、`/pricing/sync`、`/management/dashboard` | 见 `docs/adr/0003-request-time-price-snapshots.md` 与 `docs/plans/model-prices.md` |
| 配额总览与凭据详情 | `/management/quota`、`/management/quota/{authIndex}` | 归一化快照 + 冷却、重置、Codex 重置积分 |
| 审计日志 | `/management/audit/events`、`/management/audit/export` | 追加写入；敏感导出写失败时 fail-closed |
| 服务端控制器偏好 | `/preferences` | 闭集 key，服务重启不丢失 |
| 能力探测门面 | `/management/capabilities/{key}` | 仅只读、编译期白名单 |

## 已知限制

- CPA Management API 是持续演进的版本化外部契约，页面必须把 404/405 视为能力缺失而不是空数据。
- **CPA 会把 `/v0/management/*` 调用本身写进日志文件。** 控制台每 5 秒轮询一次，日志里就会出现自己的噪音，因此「隐藏管理流量」必须默认开启；CPAMC 靠隐藏整个日志入口来规避同一问题。
- 文件日志关闭时 CPA 对 `GET /logs` 返回 **400 `logging to file disabled`**。门面把它翻译成 409 `file_logging_disabled`，页面据此解释原因并给出开关位置，而不是报“请求失败”。
- `/usage-queue` 会消费队列记录，不能在普通自动刷新中调用；控制台不暴露它，后台采集器是唯一消费者。
- `POST /api-call` 支持由 CPA 代替凭据发起任意上游请求，具有 SSRF 和数据外泄风险。面向浏览器的通用调用保持关闭；服务端仅在 `internal/quota` 中使用，且目标 URL 必须命中 `AllowedURLPrefixes` 的官方 HTTPS 前缀。
- 完全替代 CPAMC 不等于复制其浏览器 localStorage 密钥存储；Oh My CPA 保持服务端密钥边界。
