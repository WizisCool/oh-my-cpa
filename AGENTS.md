# AGENTS.md — Oh My CPA 项目级 Agent 契约

> 本文件由 Pi / Claude Code 等 Agent 在会话启动时自动加载（同级 `AGENTS.override.md` 会取代它）。
>
> **第一原则：上下文文档与代码同步。** 不要等"下一次专门整理文档的任务"——文档漂移是当次改动的缺陷，必须在当次改动内修掉。

---

## 1. 项目一句话

CPA 负责协议适配、凭据执行与代理请求；Oh My CPA 在其上提供**用户拥有的身份、命名、整理、管理门面与用量观测**。二者同栈部署，Oh My CPA 是单副本 Go 模块化单体 + 内嵌 React SPA + SQLite WAL，零 CDN 离线运行。

先读这三份再动手：

1. `CONTEXT.md` — 领域术语与规则（时间窗口、i18n、认证模型、价格语义）。
2. `docs/architecture.md` — 模块地图、数据流、不变量。
3. `docs/design.md` — 视觉系统事实源。

---

## 2. 上下文文档地图：改什么，就必须同步改哪里

把下表当成硬约束。改动落在"触发条件"里，就必须在同一次改动中更新对应文档，并在提交信息或回复中说明更新了哪一份。

| 文档 | 作用 | 必须更新的触发条件 |
| --- | --- | --- |
| `CONTEXT.md` | 领域术语、领域规则 | 新增/重命名/废弃领域概念；时间窗口、i18n、认证、价格、供应商停用等规则变化；发现术语描述与实现不符 |
| `docs/architecture.md` | 模块地图、数据流、不变量、表结构、后台循环 | 新增或删除 `internal/*` 包；路由/中间件变化；数据流阶段变化；新增后台循环；数据库表或迁移门禁变化 |
| `docs/design.md` | 视觉系统与 antd token 事实源 | 调色板、排版、间距、动效、token 映射变化（同时改 `web/src/theme/themeConfig.ts` 与 `web/src/index.css`） |
| `DESIGN.md` | 品牌设计系统摘要（供 design 工具读取） | 同 `docs/design.md`；两者必须一致 |
| `PRODUCT.md` | 产品定位、能力清单、约束 | 能力增删、约束变化、目标用户或定位变化 |
| `README.md` | 用户与运维入口 | 命令、环境变量、默认值、端点、部署方式、安全边界变化 |
| `docs/adr/NNNN-*.md` | 重要且难逆的架构决策 | 出现有真实取舍的决策时**新增**一篇；不要改写已 Accepted 的 ADR，用新 ADR 取代 |
| `docs/cpamc-parity.md` | 与 CPAMC 的功能对位矩阵 | 某项从"计划/进行中"落地为"已覆盖"；接口能力或页面接线变化；发现新的缺口 |
| `docs/ops/sqlite-operations.md` | 备份、恢复、主密钥治理、迁移门禁 | 迁移/备份策略、保留期、保留条数、相关环境变量默认值变化 |
| `docs/plans/model-prices.md` | 定价设计、匹配规则、已知限制 | 定价匹配链、同步规则、价格表结构变化 |

### 文档维护检查清单（声明完成前逐项执行）

1. **跑机械检查**：`pnpm check-docs` 验证全部上下文文档中被反引号引用的仓库路径都能解析、没有指向已淘汰产物、且非档案文档没有写绝对行号。
2. **找**：用本次改动涉及的标识符、端点、环境变量、表名、页面名去 grep 全部 `*.md`，列出所有相关陈述。
3. **对**：逐条与当前代码/运行结果对照，不靠记忆。
4. **改**：纠错（与实现不一致）→ 更新（已废弃的接口/配置/依赖）→ 补全（缺失的模块、数据流、决策）。
5. **验**：文档中出现的路径、端点、环境变量名、默认值、表名是否真实存在且取值一致。
6. **扫残留**：搜 `prototype`、已删除文件、已下线页面/端点、已更名的标识符——这类引用是本仓库历史上最高频的文档缺陷。
7. **写清语言**：技术参考文档用英文；面向用户/运维的说明沿用该文件既有语言，**同一文件内不要中英混杂**（代码注释一律英文，见 §4）。

`pnpm check-docs` 只能证明路径存在，证明不了句子是否属实；第 2–5 步仍然要人（或 Agent）读完再改。新增一条“已淘汰产物”规则时，在 `scripts/check-docs.mjs` 的 `RETIRED_REFERENCES` 里加上原因，并跑 `pnpm test:docs`。

**不要写易腐的绝对行号。** 引用 `internal/api/handler.go` 而不是 `handler.go:53-128`；引用符号名而不是行位置。行号只在 ADR/审计这类冻结的历史档案里允许出现，且必须标注当时的基线提交。

---

## 3. 完成定义（Definition of Done）

任何改动在被声明完成前必须同时满足：

- 开发循环优先跑 `pnpm test:fast`，它只执行与当前工作树改动相关的检查；
- 一个逻辑功能完成后跑 `pnpm verify`（严格工具链 + 全量静态门禁 + worktree 密钥扫描）；
- 声明任务完成前跑 `pnpm verify:full`（额外包含历史密钥扫描、生产构建、bundle 预算与完整确定性浏览器验收）；
- 本次改动触发的全部上下文文档已按 §2 更新；
- 没有残留的过时注释、死引用或未本地化的用户可见文案。

CI（`.github/workflows/ci.yml`）并行运行静态门禁与浏览器门禁：PR 使用 `verify:browser:smoke` 快速反馈，`master` push 使用完整 `verify:browser`，两者都保留严格工具链、密钥扫描和干净工作区断言；同一 ref 的新运行会取消尚未完成的旧运行。浏览器失败时会把截图、HTML 和应用日志作为短期 artifact 上传。

---

## 4. 代码注释规范

**核心：解释 Why，不解释 What。** 代码已经说清"做了什么"，注释只负责"为什么这样做"——设计意图、决策背景、取舍、边界条件、非显然的约束。

- **语言**：注释一律**英文**，禁止中英混用。即使是引用中文 UI 文案，也要用英文概念表述（`实时` → `Live`，`至今` → `open-ended`）。
- **精简**：只在核心逻辑、潜在边界条件、复杂算法处标注。不要复述函数名或代码本身（`// increment counter`、`// loop over items` 一律删除）。
- **同步**：逻辑变更必须同步更新注释。残留的失效或误导性注释等同缺陷。
- **禁止历史残留**：不要引用已被删除的文件、已下线的页面、已更名的标识符或已废弃的外部契约。

正例（来自 `internal/usage/ingest/runner.go`）：

```go
// Auto. Availability is probed with AUTH, never by popping: CPA's queue is
// destructive, so a probe that consumed a record would silently lose it.
```

反例：

```go
// Get the config.
func (s *Service) FetchConfig(ctx context.Context) (Config, error) {
```

---

## 5. 命名规范

| 风格 | 适用 |
| --- | --- |
| `lowerCamelCase` | Go/TS 局部变量、函数与方法、类/结构体属性、参数 |
| `UpperCamelCase` | 类、接口、结构体、React 组件、导出类型 |
| `SCREAMING_SNAKE_CASE` | 模块级常量（`MAX_LOG_BUFFER_LINES`、`RENDER_CHUNK`），以及全局静态只读配置 |
| `snake_case` | 数据库表名与字段名、SQL 列、JSON wire 字段 |
| `kebab-case` | URL 路径、CSS 类名（含 `*.module.css`）、Git 分支 |

语义要求：

- 禁止无意义缩写（`temp`、`tmp`、`a`、`b`、`obj`、`el`、`val`、`res`、`idx`）；仅纯循环计数器允许 `i`、`j`。注意 `idx` 尤其危险：在配额/凭据循环里它往往是 string Auth Index，而不是数字下标。
- 布尔值必须带状态前缀：`isActive`、`hasPermission`、`canEdit`、`shouldRetry`。React 的 `useState` 布尔值同样适用（`isVisible`、`isSubmitting`）。
- 函数/方法用动宾结构：`calculateTotal()`、`validateInput()`、`nextDelay()`、`formatRequestTick()`。
- 用户可见文案不得硬编码在后端响应或前端组件里；新增文案必须同时进 `web/src/i18n/index.tsx` 的 `[zh, en]` 对。

**边界（不要为了风格去改这些）**：

- **Wire 契约名保持外部拼写**。`json:"disabled"` 对应的 Go 字段、CPA 原生字段、DB 列名、查询参数都属于外部契约，改 Go/TS 标识符不会改善可读性却会扩大 diff；命名规则适用于我们自己发明的标识符。
- **第三方组件的 prop 名同理**。`<Sider collapsed={isCollapsed}>`、`<Modal open={isOpen}>` 左侧是 antd 的接口，右侧才是我们的状态名；批量重命名时不要把 prop 名一起换掉。同理，`className="..."` 里的字符串是 CSS 类名（kebab-case），不要被标识符重命名误伤。
- Go 中 `Valid()` 这类返回 bool 的方法是标准库习惯（`sql.NullString.Valid`），不强制改成 `IsValid`。
- **CSS Modules 的类名是 kebab-case，通过 `styles['kebab-case']` 访问**。不要写 `styles.camelCase`。这条无法靠 `tsc` 拦住（`vite/client` 把 `*.module.css` 类型成 `Record<string, string>`，拼错不报错），所以由 `pnpm check-css-modules` 把关；新增/重命名类后必须同时跑它。

---

## 6. 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | Air + Vite 开发入口（`http://127.0.0.1:5173/omc/`） |
| `pnpm dev:api` / `pnpm dev:web` | 只跑 Go/Air 或只跑 Vite |
| `pnpm cpa:start` | 从 `cpa/` 启动本地 CLIProxyAPI |
| `pnpm build` | 构建前端并同步到 `internal/web/dist`；类型检查已由独立门禁负责 |
| `pnpm test:fast` | 按工作树改动执行最小相关检查 |
| `pnpm verify` | 严格工具链 + 全量静态门禁 + worktree 密钥扫描 |
| `pnpm verify:full` | 并行编排的最终完整门禁 |
| `pnpm verify:full:serial` | 串行最终门禁，仅用于诊断并行编排差异 |
| `pnpm verify:browser` | 对已构建的 SPA 跑确定性浏览器验收（假 CPA 夹具） |
| `pnpm verify:browser:smoke` | 只跑登录、仪表盘和请求列表核心链路的浏览器 smoke |
| `pnpm verify:e2e` | 先构建，再跑完整确定性浏览器验收 |
| `pnpm verify:refresh` | 只验证请求记录页“刷新按钮真实拉取”的浏览器探针（含顺序断言） |
| `pnpm verify:secrets` | 工作区密钥扫描 |
| `pnpm check-i18n` | 找出代码里使用了但字典中缺失的 key |
| `pnpm check-docs` | 校验上下文文档的路径引用、淘汰产物引用与绝对行号（`pnpm test:docs` 自测） |
| `pnpm check-css-modules` | 校验每个 `styles[...]` 引用都能在对应 `*.module.css` 中找到（`pnpm test:css-modules` 自测） |
| `pnpm lint:antd` | antd 用法与可访问性规则 |

---

## 7. 交付面收尾：只描述被采用的状态

会话里的否决方案、中间尝试和措辞纠正都是**控制信息**，不是最终产物的身份。写交付面时假设读者没看过本次会话。

每个交付面都要单独判断：标题、文件名、正文、注释、标签、commit 信息、PR 描述、交付说明。

- **从正向目标生成，不要逐词修改被否文案。** 高显著度的标题、开篇、标签、文件名若来自被丢弃的方案，重写它，而不是替换同义词、委婉语或加括号说明。
- **省略的判据**：不知道本次会话的读者需要这条信息吗？省略会不会让产物不安全、不准确、误导、不兼容或不合规？它是不是任务开始时已提交（或用户已确认）状态中的真实变化，而当前交付面需要解释它？都不是，就整条删掉。
- **「不要提 X」不等于可以写「无 X」。** 不必要的对比要整体移除，不要留一句合规声明。
- **必须保留**：真实的基线变化、已执行的外部操作，以及必要的技术名称、诊断、测试、快照和审计事实。不要为了回避某个词而抹掉真实删除、API 名或安全事实。任务开始前已有的用户改动不算被否内容，也不要写进本次 commit 或 PR 叙述。
- **对照 diff 和回读状态写**，不要把无关改动吸收进叙事。产物变更后重新通读全部用户可见内容及其包装（含文件名与元数据），不要另加「已清理」「无残留」类声明。

---

## 8. 不要做的事

- 不要绕过 `internal/api` 的 DTO allowlist 直接透传 CPA 响应；不要新增"任意 URL / 任意 CPA 端点"代理。
- 不要把 CPA 管理密钥或任何上游 secret 写入普通响应、日志、偏好、前端持久化或文档。
- 不要在没有新迁移的情况下改动历史数据库结构；回滚只能是向前的（新迁移修复），不要手改 `schema_migrations`。
- 不要引入需要 CDN 的前端资源；前端必须能嵌入单个 Go 二进制离线运行。
- 不要写死根路径；`/omc` 子路径必须继续原生工作。
- 不要写 `path.go:123-456` 这种绝对行号引用（`pnpm check-docs` 会在非档案文档上直接失败）；引用文件名或符号名。
- 不要用"页面能探测到端点"冒充功能完成；占位页必须显式标注为占位。
- 不要改写已 Accepted 的 ADR；出现新取舍时新增一篇取代它。
