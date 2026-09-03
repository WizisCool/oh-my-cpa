# Oh My CPA 大修复与产品推进执行目标（Codex 主任务）

> **状态**：待 Codex 执行
>
> **主分支**：`master`（本项目未发布，只维护这一条主线）
>
> **计划基线**：`78352d5e232007f94a9ca0a4c8c7a6394a0ebf35`
>
> **基线安全标签**：`pre-overhaul-base-20260904`（指向大规模 Beta 工作入库前的 `4b1c80db4375fa19b8ee763b5e0cf205143bb87b`）
>
> **原则**：先修安全与正确性，再补领域闭环和功能广度；每一步必须可验证、可回滚、保持 `master` 可构建。

---

## 1. Codex 执行契约

你是此次大修复的实现 Agent。请直接在项目根目录工作，先完整阅读：

1. 本文件 `goal.md`；
2. `README.md`；
3. `CONTEXT.md`；
4. `docs/design.md`；
5. `docs/cpamc-parity.md`；
6. `docs/adr/0001-go-react-sqlite-modular-monolith.md`；
7. 本文件点名的源码和测试。

### 1.1 总目标

将 Oh My CPA 从“首个可用 Beta 纵向切片”推进为：

- 不把上游秘密扩散到日常资源模型、普通浏览器响应/持久状态或历史数据库；
- 配置、日志、资源和用量在失败、并发与崩溃场景下行为正确；
- 资源身份模型有明确 CPA Binding，可稳定连接用户身份与 CPA 运行资源；
- 用户能查看用量事件、请求详情、过滤维度、采集状态与单请求日志；
- 逐步完成高价值 CPAMC parity，而不是用 capability probe 冒充已完成功能；
- 自动化测试、CI、部署与 Git 纪律足以支撑持续推进。

### 1.2 必须保留的架构边界

- CPA 继续负责协议适配、凭据执行和代理请求；Oh My CPA 不复制执行平面。
- 浏览器只能访问 Oh My CPA 的固定白名单 API；禁止增加“任意 CPA endpoint/任意 URL 代理”。
- CPA Management Key 的配置值只保存在 Go 后端；浏览器登录/重新认证时可通过受限 `no-store` 请求瞬时提交该 key，但不得保存、回显、记录或直接发给 CPA，成功后只持有 HttpOnly session/窄 scope grant。
- 普通 DTO、日志、错误、偏好、localStorage/sessionStorage/IndexedDB/Cache Storage/Service Worker cache 和长期 Query cache 不得含秘密。用户明确触发并重新认证后的 Auth File/raw Config/request-log 下载或编辑，是有意把敏感内容交给当前管理员浏览器的窄例外；必须 `no-store`、不进入应用持久状态/遥测/日志、到期清 cache，并在 UI 明示风险。已交付的字节无法从 DevTools/进程内存保证擦除，验收不得作此虚假承诺。
- SQLite 仍按单 Oh My CPA 副本设计；不要未经 ADR 改为分布式多写。
- `/omc` 子路径必须继续原生工作；不得写死根路径。
- 前端继续嵌入 Go 二进制、零 CDN 离线运行。
- `CONTEXT.md` 只记录领域术语与关系，不写实现细节；重要、难逆、具有真实取舍的决策写 ADR。
- `docs/design.md` 是视觉系统事实源；组件不得继续扩散硬编码颜色。

### 1.3 禁止事项

- 禁止 `git reset --hard`、`git clean -fdx`、`git checkout -- .`、强制推送或改写已提交历史。
- 禁止用 stash 作为长期保存或交接手段。
- 禁止把 `.env`、数据库、CPA 本地目录、`tmp/`、`web/dist/`、`.pi/`、真实 token/key、用户数据提交到 Git。
- 禁止习惯性使用 `git add -A`；每次必须按文件/目录路径暂存并检查清单。
- 禁止把多个无关阶段揉成一个巨型 commit。
- 禁止因为页面能探测端点就移除 placeholder；只有 UI、API、加载/空/错态和主要写操作闭环后才算完成。
- 禁止在没有迁移和回滚/兼容策略时直接破坏历史数据库。
- 禁止通过静默截断、静默覆盖或吞掉错误来“让流程继续”。
- 禁止用单元测试通过替代浏览器、迁移、故障注入和真实部署边界验证。
- 不要在本轮顺手升级 Go、React、Ant Design、Vite 或 SQLite driver 的大版本；依赖升级另立任务。

### 1.4 工作方式

- 按本文件阶段顺序执行；P0 未完成前不得开发新的 parity 模块。
- 每个阶段先写/更新测试，再实现，再跑该阶段门禁，再提交。
- 遇到本计划与源码冲突时，以可复现的源码/运行证据为准，但必须在 commit 或 ADR 中记录偏差原因。
- 每完成一个阶段，更新本文件末尾“执行记录”，写明 commit、测试、已知限制；不要改写阶段目标来掩盖未完成项。
- 所有用户可见文案必须同时提供中文和英文。

---

## 2. 当前事实基线

### 2.1 产品定位

Oh My CPA 是 CLIProxyAPI（CPA）之上的用户拥有管理与身份层：

- CPA：协议适配、凭据执行、代理请求；
- Oh My CPA：发现 CPA 技术资源、赋予用户身份与组织信息、提供管理门面、采集与分析用量。

### 2.2 架构

```text
React 18 + TypeScript + Ant Design + TanStack Query
                       ↓ /omc/api/v1
Go + chi 模块化单体
  ├─ HttpOnly 管理员 session
  ├─ 固定 CPA Management API client/facade
  ├─ Discovery 归一化
  ├─ SQLite repository（WAL、foreign keys、单连接）
  └─ Usage ingest
       capture → inbox → decode → event → hourly/daily rollup
```

关键位置：

- API 路由：`internal/api/handler.go:53-128`
- CPA client：`internal/cpa/management/client.go`
- Discovery：`internal/cpa/discovery/discovery.go`
- Repository：`internal/repository/`
- Usage：`internal/usage/ingest/`、`internal/repository/usage*.go`
- React 路由：`web/src/App.tsx:89-121`
- DB 迁移执行：`internal/repository/db.go`
- 前端运行时子路径注入：`internal/api/handler.go:540-606`

### 2.3 当前成熟度

- 首个“登录 + 资源身份覆盖 + Dashboard + Auth Files + Logs + Config + Usage ingest”纵向切片已形成，约 70–80%，可视为 Beta/内部可用。
- 完整 CPAMC parity 约 35–45%。下列页面目前只是 capability probe：
  - Quick Start
  - AI Providers
  - OAuth
  - Quota
  - Plugins
  - Plugin Store
  - System
- Source、Subscription、Account、Credential、Endpoint、Connection、CPA Binding 已写入领域词汇，但当前数据库主要还是 `cpa_instances + discovered_resources + resource_overrides`，尚未形成完整关系。

### 2.4 计划编写前已通过的验证

```bash
go test ./...
go vet ./...
pnpm type-check
pnpm check-i18n
pnpm test:payload
node --experimental-strip-types scripts/test-dirty.ts
pnpm --dir web build
```

额外审计事实：

- Ant Design CLI：35 个组件、145 次导入；a11y 规则 0、performance 规则 0、deprecated 警告 22。
- 自建只读浏览器审计覆盖 8 路由 × 2 viewport × 2 theme，共 32 组合。
- 390px 下 `AllResourcesPage` 主区 `clientWidth=390`、`scrollWidth=717`。
- 当前本地健康接口返回 200，但 `cpa_connected=false`、overall `degraded`；因此 Auth Files/Logs/Config 的 CPA happy path 尚需 deterministic fake CPA 与可选 live smoke 补验。
- 项目自带 `scripts/browser-acceptance.mjs` 已因旧文案和旧 DOM selector 漂移，当前不能作为发布门禁。

### 2.5 当前 Git 状态约定

- 只使用 `master`；不要求为本次开发创建分支。
- 计划基线快照：`78352d5`，提交信息为 `chore(repo): checkpoint accumulated beta work before overhaul`。
- `pre-overhaul-base-20260904` 是大修前安全锚点。
- 当前没有 Git remote。配置 origin 前，任何“已 push/已创建 PR”的说法都不成立。

---

## 3. 全局验收规则（Definition of Done）

每个阶段必须满足适用子集；最终发布候选必须全部满足：

### 3.1 代码与测试门禁

```bash
go test ./...
go vet ./...
pnpm type-check
pnpm check-i18n
pnpm test:payload
node --experimental-strip-types scripts/test-dirty.ts
pnpm build
pnpm lint:antd
pnpm verify:secrets
```

说明：

- `pnpm build` 是最终门禁，因为它构建并同步嵌入资产；中间只验证前端时可用 `pnpm --dir web build`，避免无意义修改 `internal/web/dist/index.html`。
- 将 `check-i18n` 改造成发现缺失 key 时非零退出；在此之前退出码 0 不是严格门禁。
- 不依赖开发机全局命令：阶段 0 将 Ant Design CLI、Playwright 与秘密扫描器版本固化到仓库脚本/工具清单和 lockfile。
- Ant Design deprecated 警告应建立可跟踪基线并逐步归零；a11y/performance 不得新增问题。

### 3.2 浏览器矩阵

至少覆盖：

- 1440×900 与 390×844；
- dark 与 light；
- 未登录、登录成功、session 失效；
- deterministic fake CPA happy path；
- CPA offline、能力缺失、认证失败、服务器错误；
- `/omc` 子路径；
- Dashboard、Triage、All Resources、Auth Files、Logs、Config、Instances、Usage Events；
- 键盘导航、可见 focus、无 document 级横向溢出；
- 浏览器 console/pageerror/requestfailed 无未解释错误。

### 3.3 安全与数据门禁

- staged 内容执行秘密扫描；fixture 只能用明显假值。任何命中先停工并判定；若真实秘密已存在历史且用户仍禁止改写，则先 revoke/rotate，记录 commit/rule/不可逆 fingerprint，再添加只匹配该历史 fingerprint 的审阅例外；当前工作树和新提交不允许豁免，禁止宽泛 path/rule allowlist。
- `/resources`、普通日志/错误响应、healthz、审计事件不得含 API key、OAuth token、原始 Auth File、Management Key 或带 userinfo 的 URL；显式 raw 下载/编辑按 1.2 的窄例外验收。
- 所有迁移必须在：空库、从 001、从当前 003、含历史敏感 details/error/inbox 数据的库上验证。
- destructive/sensitive 操作必须有认证、same-origin、输入限制、确认和审计事件。
- 数据一致性修复必须有故障注入测试，而不只测成功路径。

### 3.4 Git 门禁

提交前：

```bash
git diff --check
git diff --cached --name-status
git diff --cached --check
git status --short
```

阶段完成后：

- commit 只包含一个主题；
- commit message 使用 Conventional Commits；
- 测试输出和剩余风险写入 commit body 或执行记录；
- `git status --porcelain` 必须为空；
- 禁止把生成物和本地运行数据留成未跟踪噪音。

---

# 4. 阶段 0：仓库、Git 与自动化规范化

## 目标

让后续每次变更边界清楚、换行稳定、门禁可重复执行；保持单 `master` 工作流，不引入未发布项目不需要的分支复杂度。

## 实施

1. 新增 `.gitattributes`：
   - 源码、Markdown、YAML、JSON、SQL、shell/Node 脚本固定 LF；
   - `.bat/.cmd/.ps1` 按 Windows 需要明确规则；
   - 字体、图片等 binary 标记 `-text`。
2. 新增 `.editorconfig`：UTF-8、final newline、默认 LF、Go/TS/JSON/YAML/Markdown 的缩进约定。
3. 在独立 commit 中执行一次 `git add --renormalize .`；先看 diff，确保只有换行变化与明确文件；不要和功能修复混合。
4. 强化 `.gitignore`：继续忽略 `.pi/`、`tmp/`、`web/dist/`、`.env`、DB/WAL、CPA 本地目录；保留 `internal/web/dist/index.html` 当前嵌入入口策略，直到另有 ADR。
5. 修改 `scripts/check-missing-i18n.mjs`：收集缺失 key，最后 `process.exitCode = 1`；为脚本本身增加正/负 fixture 测试，避免“只打印不失败”。
6. 新增项目 toolchain matrix 并固定精确版本：Go `1.24.x`（先固定 CI/Docker 所用 patch 并同步 `go.mod` 的兼容要求；当前开发机 `go1.26.4` 只能算额外兼容验证）、Node `22.x` patch、pnpm `11.19.0`、`@ant-design/cli@6.6.2`、`playwright-core@1.62.1` 及其 Chromium revision、Gitleaks `v8.24.3`。支持的 OS/architecture archive、官方 URL 和 SHA-256 进入受控清单；CI/脚本启动先验证版本。
7. 将 `@ant-design/cli@6.6.2` 以 exact version 加入 root `devDependencies`，增加 `lint:antd` 脚本（调用本地 binary：`antd lint web/src --format json`）；不得把全局安装视为 CI 前置条件。
8. 将 `playwright-core@1.62.1` 以 exact version 加入 root `devDependencies` 并进入 `pnpm-lock.yaml`；`scripts/browser-acceptance.mjs` 从项目依赖导入。CI 明确执行 `pnpm exec playwright install --with-deps chromium`，本地可执行 `pnpm exec playwright install chromium`；`OMCPA_BROWSER` 只作为可选 system-browser smoke override。
9. 固定 Gitleaks `v8.24.3`（如实施时因平台不可用需更换，只能改为另一个明确版本并记录原因），在 `scripts/tools-versions.json` 或等价受版本控制文件中保存版本和官方 release archive SHA-256：
   - `scripts/secret-scan.* --staged`：扫描待提交 diff，工具缺失/版本不符时 fail closed；
   - `scripts/secret-scan.* --worktree`：扫描工作树；
   - CI：用同一固定版本同时扫描 worktree 与 `--all` Git history；
   - `gitleaks.toml` 只允许窄范围、带注释的明显假 fixture，不用宽泛 allowlist 隐藏历史命中。
10. 新增统一脚本，例如：
   - `pnpm verify:static`
   - `pnpm test:web`（在组件测试落地后）
   - `pnpm verify:e2e`
   - `pnpm verify:secrets`
   - `pnpm verify`
11. 建立 CI（若使用 GitHub，则 `.github/workflows/ci.yml`）：
   - 固定 Go/Node/pnpm 版本；
   - pnpm frozen lockfile；
   - Go test/vet；
   - typecheck/i18n/payload/dirty；
   - production build；
   - deterministic fake CPA E2E；
   - checkout `fetch-depth: 0` 并核对预期 tags，执行固定版本 worktree + full-history secret scan；
   - 缓存不得影响正确性。
12. 将 `scripts/browser-acceptance.mjs` 拆成：
   - 默认 deterministic fake CPA E2E，可在 CI 运行；
   - 可选 `OMCPA_LIVE_CPA=1` smoke，不作为普通 PR 必需条件。
13. 修复当前旧 selector：登录使用 role/name 或稳定 test id；Config 使用当前语义角色/稳定 test id，不绑定易变 CSS class。
14. 审查 `OMCPA_WRITE_TEST=1`：写入前必须显式进入目标页面；所有写入使用隔离 fake CPA 数据目录，结束后清理。
15. 提交 fake CPA scenario server/fixture contract、隔离数据目录 helper、001/003/敏感历史 DB fixture builder、故障注入 seam 与 E2E case table。明确哪些 viewport/theme/state 是完整笛卡尔积，哪些是代表性 smoke；秘密检查至少覆盖 DOM、普通 network body、localStorage、sessionStorage、IndexedDB、Cache Storage、Query cache。SQL migration 004 必须依赖并测试 modernc SQLite 的 JSON1；若验证不可用，先设计正式 versioned Go migration registry，不得临时在启动路径插 ad-hoc Go 清理。
16. 在尚无 remote/runner 时，“CI 门禁”定义为：从项目外 verified bundle 创建全新 clone，运行与 workflow 相同命令并校验 workflow 语法；配置 remote 后，才追加 hosted run URL/ID 和 green 结果为验收证据。

## 验收

- CRLF/LF 警告消失或有明确预期；
- i18n 负 fixture 会让命令失败；
- 无 remote 时，从项目外 verified bundle 创建的干净 clone 运行全套 workflow 命令；有 remote 后再要求 hosted CI 绿灯；
- 浏览器测试不需要真实 CPA 即可验证 happy path；
- `git status --porcelain` 为空。

## 建议提交

- `chore(repo): define line ending and editor conventions`
- `test(i18n): fail validation on missing translations`
- `ci: add deterministic quality gates`
- `test(e2e): replace brittle browser acceptance selectors`

---

# 5. 阶段 1：P0 秘密治理

## 问题与证据

当前存在管理员 session 后的秘密扩散链路。它不是未认证泄漏，但违反最小暴露原则与 `README.md:135` 的承诺：

1. `management.AuthFile.Account` 读取 CPA `account`：`internal/cpa/management/client.go:756-785`；
2. `buildTrafficOverview` 在 `account_type == "api_key"` 时把 `file.Account` 与 usage key 比较，证明它可能是实际 API key：`internal/api/management_overview.go:376-393`；
3. discovery 将 `file.Account` 写入 `ResourceDetails.Extra["account"]`：`internal/cpa/discovery/discovery.go:79-111`；
4. repository 将完整 details 写入 `discovered_resources.details_json`：`internal/repository/repository.go:146-183`；
5. `/resources` 将完整 `ResourceDetails` 返回浏览器：`internal/api/handler.go:446-493`。
6. 第二条 P0 链：`internal/usage/decode.go:324-329` 的 `apiGroupKey()` 优先取 payload `api_key`，随后写入 `usage_events.api_group_key`（`migrations/002_usage_ingest.sql`、`internal/repository/usage.go`），再由 `internal/api/usage_events.go:23-86,208-220`、facets/filter 返回/使用；因此 API key 可能进入历史数据库和普通浏览器 API。
7. `internal/repository/usage.go:383-407` 仅截断便保存 `error_events.body`，`internal/api/usage_events.go:194-201` 把 correlated errors 直接放进详情；上游错误若回显 Authorization/token/userinfo，会形成第三条扩散链。

## 实施

1. 先加失败测试：
   - Discovery fixture 中 `account_type=api_key`、`account=<明显假 secret>`；
   - 断言 domain resource、repository `details_json`、`GET /resources`、override response 都不含该值；
   - 同时覆盖 token、headers、proxy userinfo、raw config 等常见秘密形态。
2. 从 `fromAuthFile` 删除 `Extra["account"]`，并在本阶段删除 fallback identity 中的 `file.Account`（当前 `internal/cpa/discovery/discovery.go:74-76`）。若 UI/分析需要，只保留：
   - `account_present: true/false`
   - `account_type`
   - 非敏感 label/status/source（逐项确认）
   - 若 CPA 没有稳定 ID/auth index 且安全元数据不足以区分，标记 identity collision/待人工绑定；不得退回数组位置或把 plaintext secret 用作 key。稳定 ID 完整层级与 keyed HMAC 策略在阶段 5 ADR 固化。
3. 收紧 `domain.ResourceDetails`：
   - 优先用明确 typed fields；
   - 如必须保留 Extra，定义固定允许键集合；禁止通用上游 map 直接流向 response。
4. 将 `resourceResponse.Details` 改成显式 public DTO/投影，而不是复用 domain persistence object。只返回当前 UI 真正使用的数据；当前前端只使用 `details.models`，其余字段需逐项证明用途。
5. 在任何数据迁移前先落地阶段 8 的最小运维前置：受权限保护的自动备份、free-space check、备份 SHA-256、restore smoke，以及 backup retention。备份可能包含正在清除的秘密，必须加密/限权/到期删除。迁移遵循 expand/contract 和至少上一版本 binary 可读的新 schema；已应用 migration 文件永不删除，回滚代码后若不兼容，先修 forward compatibility/new migration，不能只执行 `git revert` 后直接启动旧二进制。
6. 新增下一号不可变迁移（当前已有 001–003，使用 `004_...sql`）：
   - 先以当前 modernc SQLite 做 JSON1 capability test；可用时删除 `$.extra.account` 及确认的敏感历史键；
   - 若 JSON1 不可用，先为 `internal/repository/db.go` 设计有版本记录、transaction、测试和失败语义的正式 Go migration registry；不得临时在启动路径插一次性清理；
   - 同一治理批次清理历史 `error_events.body`、`usage_inboxes.raw_message/last_error` 中不该长期保留的秘密，或先迁移为加密 raw storage + 默认只存 redacted projection；不得把普通错误 redaction/历史清理推迟到阶段 4；
   - 不得只停止新写入而遗留旧秘密。
7. 为 migration 加测试：合法 JSON、有 account、无 account、空 object、异常历史值、带 Authorization/token/userinfo 的 error/inbox，以及备份/恢复；异常值处理必须明确，不得让应用静默启动在半迁移状态。
8. 审查所有 browser DTO：Auth Files、Dashboard、Usage Event、Error body、Config scalar、Health；形成 DTO allowlist 测试。特别保留并回归验证 `internal/api/management_auth_files.go` 的显式 `managementAuthFileResponse` 投影：`AuthFile.Account`、path、token、metadata 和 raw content 不得进入普通列表/详情响应；`Account` 仅允许在后端瞬时匹配逻辑中使用，不持久化、不记录、不返回。显式下载仍是独立高意图管理操作，必须 `no-store`、审计并保留输入限制。
9. 修复 `usage.DecodeEvent`/persistence/browser DTO 的 API key 扩散：当前 `apiGroupKey()` 优先返回 payload `api_key`，随后进入 `usage_events.api_group_key`、facets、filters 和普通 API。改为不可逆 keyed HMAC/fingerprint + 独立安全 label，迁移/清理历史明文；`source`、endpoint、client metadata 也执行字段级 redaction/最小化。先核实 CPA `source` 语义；若可能是 client key/token，不得以原值持久化或返回。普通 `error_events.body` 写入前 redaction，详情 API 再做 public projection；raw diagnostic 内容只能进入加密、retention 受限且需重新认证的窄通道。
10. 在本阶段引入最小 append-only `audit_events` schema/service，并先覆盖：Auth File 删除/下载、Logs clear、Config save/raw reveal、request-log 下载；记录非秘密 target ID/fingerprint、动作、结果、request ID、来源摘要，绝不记 request body、原始文件名中的敏感片段或秘密值。审计写失败的用户行为和告警策略必须显式定义并测试。
11. 更新 `README.md` 安全边界，描述经过验证的事实，不写超出测试的绝对承诺。

## 验收

- 新发现和历史数据均不含 `extra.account`，fallback key 不再由 plaintext account 派生；
- 管理员 `/resources`、普通 Auth Files/Usage Events/Error response 不含任何 fixture secret，历史 `api_group_key` 不再保存/返回明文 key；
- 迁移从 003 升级成功且可重复启动；备份可恢复、限权并有到期策略；
- `go test ./...`、secret scan 通过；
- 浏览器 network/DOM/local state 中搜索 fixture secret 无命中。

## 建议提交

- `test(security): reproduce credential leakage in resource projection`
- `fix(security): remove credential material from discovered resources`
- `fix(migrations): purge stored resource account secrets`
- `docs(security): align resource exposure guarantees`

---

# 6. 阶段 2：Config 可靠性、并发与秘密边界

## 现有问题

### 2.1 拉取失败后 fail-open

- source query：`web/src/pages/ConfigPage.tsx:234-258`
- 空文档回退默认值：`ConfigPage.tsx:262-308`
- 无 query error 阻断，仍渲染 workbench：`ConfigPage.tsx:923-990`
- CPA offline 时实测仍显示“59 项配置 · 已同步”。

### 2.2 保存基线竞争

`saveMutation.mutate(rawYaml)` 后，`onSuccess` 使用可变 `rawYaml` 设置服务端基线：`ConfigPage.tsx:311-329`。请求期间继续编辑可被误标为已同步。

### 2.3 原始 YAML 默认进入浏览器

- Go 原样 GET/PUT：`internal/cpa/management/client.go:336-360`、`internal/api/management_config.go:135-185`
- 页面挂载即请求；
- `remote-management.secret-key` 是普通 string field：`web/src/types/configSchema.ts:308-315`。

## 目标状态

- 配置基线未加载时不能编辑、不能保存、不能显示“已同步”；
- 保存只确认实际提交的版本；
- 多个 Oh My CPA 客户端不会静默覆盖；若 CPA 无原生 CAS，外部直接写 CPA 的竞争限制必须被检测到尽可能程度并在 UI/文档明示；
- 默认视觉模式只读取安全投影；完整原始 YAML 仅在高意图、短时、重新认证的 Source 会话内出现。

## 实施

1. 为 `ConfigPage` 建状态机测试：initial/loading/loaded/error/dirty/validating/saving/save-success/save-error/conflict。
2. source query error：blocking Alert、safe error、Retry；所有编辑与保存禁用；保留旧已成功基线时可选择“显示旧数据但禁止保存”，并明确 stale 状态。
3. dirty baseline：`onSuccess(data, variables)` 使用 mutation variables；请求期间新编辑保持 dirty。必要时保存按钮冻结，但不能丢输入。
4. 后端增加 revision 与明确的一致性契约：
   - GET 返回原 YAML 的 SHA-256/强 ETag 作为 revision；revision 是比较标识，不等于上游 CAS；
   - PUT 要求 `If-Match` 或 request revision；Oh My CPA 内部 writer 使用同一 instance-scoped mutex/serialized mutation seam，在锁内重新 GET、比较、单次 PUT、再 GET 并返回结果 revision；两名 Oh My CPA 客户端因此不会静默覆盖；
   - 先确认 CPA 是否原生支持 ETag/conditional write。若不支持，直接写 CPA 的外部客户端仍可能在“锁内 GET 与 PUT”之间竞争，文档/UI 必须写成 best-effort conflict detection，不能承诺原子防护；E2E 要模拟此 race；
   - 不匹配返回 409/412 + machine-readable `config_conflict`；
   - UI 显示重新加载/复制本地修改/人工合并，不自动覆盖。
5. 默认视觉模式改用 typed safe config DTO，并逐字段定义读取、写入、验证与敏感性；不得假设当前少量 scalar facade 覆盖完整视觉表单。`proxy_url` 必须移除 userinfo 和敏感 query，覆盖编码凭据、malformed URL；secret 字段只返回 configured/fingerprint/last-four 等安全状态。视觉保存优先做一次 revisioned server-side YAML AST patch，保留 comments/unknown fields 并保持文档级原子性；若只能多次 scalar PUT，必须明示 non-atomic、返回逐字段 partial-success 且不能宣称整体同步。
6. 原始 Source 模式：
   - 用户点击后先解释风险；
   - 要求重新输入 CPA Management Key，后端仅验证，不把 key 交给前端存储；
   - 创建短时、一次性或窄 scope 的 reveal grant；
   - 只在 grant 有效时请求 raw YAML；
   - 离开 Source、超时、登出后清理 React/Query cache；响应 `Cache-Control: no-store`；不进入 localStorage/sessionStorage/IndexedDB/Cache Storage/Service Worker cache/遥测/日志。Raw YAML 一旦经明确授权交付，可能存在于当前页面内存或浏览器 DevTools；不作无法验证的远程擦除承诺。
7. 敏感字段：默认不返回原值；使用 unchanged sentinel/patch 语义，而不是把掩码写回真实配置。
8. 全量 YAML PUT 做服务端 YAML parse 和关键 schema 防护；错误返回行列与 machine-readable code。
9. 使用阶段 1 已建立的审计服务记录：谁（session/来源摘要）、何时、保存了哪个 revision、结果；绝不记录 YAML 或秘密值。
10. 保持 comments/unknown fields：视觉编辑继续基于服务器文档或后端 patch，不得重建整份默认 YAML。

## 验收

- GET 502 时页面只显示错误与 Retry，不显示“已同步”，保存不可达；
- 保存 A 时继续编辑 B，A 成功后 B 仍 dirty；
- 两个 Oh My CPA 客户端同 revision，第二个保存收到冲突而不是覆盖；模拟 direct CPA write 时验证原生 CAS（若有）或明确的 best-effort 限制（若无）；
- visual save 的一次文档 patch 或 partial-success contract 经测试，不会把部分写入误标成整体同步；
- 默认加载页面的网络响应不含 Management Key/provider key/token；
- Source 模式无重新认证不能取原文；超时后请求失败；
- dirty/payload/YAML tests 全通过。

## 建议提交

- `test(config): cover unavailable and concurrent editor states`
- `fix(config): block editing until server baseline is loaded`
- `fix(config): preserve edits made during save`
- `feat(config): enforce revision based conflict detection`
- `feat(security): gate raw configuration behind reauthentication`

---

# 7. 阶段 3：Logs、Health、Resources 与 UI 正确性

## 7.1 Logs

现有问题：

- status query 失败时 tail 永不启用，页面长期“加载中”：`web/src/pages/LogsPage.tsx:186-195,319-385`；
- clear mutation 失败只关闭确认，无反馈：`LogsPage.tsx:222-229`。

实施：

- `status.isError` 显示 Alert + Retry；区分 offline/auth/capability/unknown；
- clear 失败 message/Alert，保留日志和确认上下文；
- 增加组件与 E2E 失败路径测试；
- 继续保持 disabled/unsupported/offline/error 的不同操作建议。

## 7.2 Health / Instance

- `InstanceStatusPage.tsx:35` 必须使用 `health.cpa_connected` 判断 CPA 在线；overall app status、DB、CPA 分开显示。
- 公共 `/healthz` 不返回内部 `cpa_base_url`；详细拓扑移到认证后的实例/overview API。
- `database_status` 必须来自真实轻量 `PingContext`，不能无条件写 `ok`。
- 定义 liveness/readiness：进程活着、DB 可用、CPA disconnected 各自的 HTTP/JSON 语义与容器 healthcheck 需求。

## 7.3 All Resources

现有问题：

- filter 混用 `status` 与 `custom_display_name`：`AllResourcesPage.tsx:33-61`；
- 状态列显示“已自定义/待处理”而不是四态：`AllResourcesPage.tsx:148-158`；
- query error 被空数组吞掉；
- 390px 主区宽 717px。

实施：

- 直接按 `claimed | unclaimed | ignored | missing` 过滤和显示；“已个性化”是独立属性；
- query error 显示 Alert + Retry，不能冒充空表；
- 移动端优先改为实体卡片/Descriptions；若保留 table，只允许 table wrapper 局部滚动并提供可发现提示，document/app-content 不溢出；
- 搜索、分页和筛选应在移动端可操作；
- missing/ignored 的可用操作和恢复行为要有领域定义与测试。

## 7.4 可访问性、i18n、token

- `AppLayout.tsx:208,238` 的品牌交互改为真实 `<button>`/`Link`，或完整实现 Enter/Space；
- 翻译 `ResourceEditDrawer.tsx:339` 的 `Auth Index:`；
- 定义/替换 `--bg-surface`、`--font-mono`；统一到 `--surface` 和主题字体 token；
- 清理资源组件的 `#007aff`、`#fff`、RGBA 与大量 inline layout style；动态用户颜色除外，但要验证合法色值和对比度；
- 修复 22 条 Ant Design deprecated 警告，保持当前 major；
- 键盘遍历 Drawer、Menu、表格/卡片 action、Modal/Popover，焦点返回触发器。

## 验收

- Logs status/clear 的每类失败都有稳定 UI 和 Retry；
- CPA offline、DB failure、overall degraded 显示不互相混淆；
- 四态筛选和标签完全由 domain status 驱动；
- 390px dark/light 无 app-content/document 横向溢出；
- a11y/performance lint 0，deprecated 归零或有明确剩余基线；
- zh/en 都无非专有名词硬编码混入。

## 建议提交

- `fix(logs): close status and truncate error flows`
- `fix(health): separate app database and CPA readiness`
- `fix(resources): honor lifecycle status in filters and labels`
- `fix(resources): provide responsive mobile resource view`
- `fix(ui): align accessibility translations and design tokens`

---

# 8. 阶段 4：Usage 一致性与可解释的数据完整性

## 8.1 Rollup/checkpoint 原子性

`internal/repository/usage_analytics.go:143-147` 先 commit additive rollup，再调用 `SetUsageCheckpoint`；中间崩溃会双计数。

实施：

- checkpoint 读取、batch high-water 选择、rollup upsert 与 checkpoint advance 全部进入同一个 serialized transaction/`tx.QueryRowContext`/`tx.ExecContext`，或使用可证明正确的 conditional watermark claim；只把 commit 放进去不足以解决两个并发 aggregator 选择同一范围的问题；
- 故障注入覆盖 rollup fail、checkpoint fail、commit fail；任一失败都不得留下半状态；
- 同 grain 两个并发 `AggregateUsageGrain` 测试必须得到 exact totals；重复执行同一窗口幂等。

## 8.2 Destructive pop 的丢失窗口

`internal/usage/ingest/runner.go:414-424` 先 pop，`runner.go:459-465` 后落 inbox。远端 destructive pop 与本地 SQLite 无法形成跨系统原子事务，因此不能宣称 exactly-once。

实施：

- pull 路径 pop 返回后立即在一次本地 transaction 写入整批，不再跨 timer 缓冲；
- subscribe 路径缩小内存窗口，正常 shutdown flush；
- append 失败时持久化 coverage gap/collector error，不能假装已完整；定义 `ingest_gaps` 或等价 durable schema，至少含 instance、source mode、发生时间区间、估计数量/unknown、原因码、安全摘要、acknowledged_at；重启后仍可见；
- 明确定义 delivery semantics：destructive pop 的 at-most-once risk、已知 gap、重投递/重复语义；写入文档与 ingest status；修正 `migrations/002_usage_ingest.sql` 中“same transaction as the pop”等不可能的注释；
- 不直接对 `request_id/event_key` 加唯一约束：CPA retry/多 usage records 可能共用 request ID。先定义 delivery identity（如 instance + CPA stable event id，或原始 payload hash + source occurrence identity）与 inbox→event invariant，再通过迁移、transaction 和 conflict handling 去重；`DO NOTHING` 必须同时正确标记 inbox；
- 增加 pop-success/append-failure、process cancellation、shutdown flush、合法同 request ID 多记录、同 delivery 重投、restart gap 可见测试。

## 8.3 非唯一 auth_index JOIN

`internal/repository/usage_events.go:143-145,220-222` 只按 `(instance_id, cpa_auth_index)` JOIN，而该组合不唯一。

短期：

- 查询禁止非唯一扇出；使用确定性 binding 或返回 unbound，而不是任意重复；
- 加 fixture：同 auth index、多 resource family，事件列表不能重复、cursor/pagination 不乱。

长期由阶段 5 的 CPA Binding 解决：usage event 在 ingest/bind 时保存稳定 `resource_id`/`binding_id`，查询不再动态猜测。

## 8.4 Retention 与敏感数据

- 阶段 1 已完成普通投影 redaction、历史清理与最小审计；本阶段补充 `usage_inboxes.raw_message`、error body、discarded poison message 的分层加密 raw storage 与个人数据最小化；
- 为 inbox/error/discarded/ingest gaps 定义独立 retention；
- retention 必须清理 discarded 数据，防无界增长；
- UI 展示经过 redaction 的错误；raw request log 使用受控下载、no-store、重新认证和既有审计服务。

## 验收

- 故障窗口和同 grain 并发 aggregator 都不双计；
- 同 auth index 多资源不重复事件；
- append failure 在 ingest status 可见；
- discarded/inbox/error retention 有测试；
- 文档不再声称 exactly-once，而是准确描述语义和覆盖区间。

## 建议提交

- `fix(usage): commit rollups and checkpoints atomically`
- `fix(usage): persist pulled batches without buffering gaps`
- `fix(usage): prevent ambiguous auth index joins`
- `feat(usage): expose collector coverage and delivery semantics`

---

# 9. 阶段 5：CPA Binding 与领域模型闭环

## 原则

不要一次性“大爆炸式”重写所有表。先解决身份稳定与运行绑定，再增量抽出实体。领域关系以 `CONTEXT.md` 为准，任何调整先用具体场景验证并更新词汇；难逆 schema/identity 决策写 ADR。

## 必须覆盖的场景

1. 同一 Source 的一个 Subscription 有两个 Account，每个 Account 有多个 Credential。
2. 一个 Credential 可访问多个 Endpoint/Protocol 组合。
3. 同一 Connection 同时绑定两个 CPA instance。
4. CPA `auth_index` 变化，但用户认定还是同一 Credential/Connection。
5. 缺少 `auth_index`，CPA 配置数组重排或前部插入条目。
6. 同一 `auth_index` 被不同 CPA resource family 暴露。
7. Credential 被删除后资源变 missing，但历史 usage 仍应归属原 Connection。
8. API key 轮换后秘密变化，身份不应因明文 key 进入数据库；必要时使用 keyed HMAC/不可逆标识，但必须接受“秘密本身改变会改变 HMAC”这一事实，并通过人工/上游 ID/rebinding 保持用户身份。

## 实施顺序

### 5.1 ADR 与最小 schema

- 新 ADR：身份与 CPA Binding 策略，包括稳定性、秘密明文不可入 identity、历史 usage 归属、冲突处理、fingerprint key version 和轮换/重新绑定方案。
- ADR 固定 discovery identity hierarchy：①经验证稳定的 CPA immutable ID；②family-scoped stable auth index；③对规范化 credential material 做 keyed HMAC（只在否则不可区分时，存 key version，不存明文）；④唯一的非敏感元数据；⑤仍不可区分时报告 identity collision 并要求人工绑定，绝不静默使用数组位置。
- 首先增加 `cpa_bindings`，至少包含：
  - stable local id
  - connection/resource identity reference
  - instance id
  - CPA resource family/type
  - auth index（可空）
  - stable non-secret fingerprint
  - status/last seen/missing timestamps
  - uniqueness/invariant
- `discovered_resources` 可先作为 discovery observation 保留，不立即删除。

### 5.2 修复 fallback identity

当前 Codex/OpenAI compatibility fallback 包含数组 index：`internal/cpa/discovery/discovery.go:115-178`。按 ADR hierarchy 重写；数组位置不能进入 stable identity，连“最后冲突消歧”也不能静默使用，因为重排会换身份。两个非敏感元数据完全相同、只有 key 不同的条目必须使用 keyed HMAC 或进入 explicit collision/manual binding。

禁止：把 raw API key、token、带 userinfo URL 或可逆秘密写入 resource key/details。HMAC 是 keyed pseudonymous fingerprint，不称作“非秘密字段”，并需限制 dictionary/correlation 风险。

### 5.3 增量抽实体

按用户价值逐步引入：

1. Source
2. Account / Subscription（允许缺省）
3. Credential metadata（只存引用和非秘密描述）
4. Endpoint
5. Connection
6. CPA Binding

可先让 Connection 关联现有 override，再迁移 UI；每步提供兼容读取，避免一次提交同时改全部 API、DB 和 UI。

### 5.4 Usage 绑定

- ingest 或后续 binding processor 将 event 绑定到稳定 binding/resource id；
- 历史 usage 保留快照名称或 nullable reference，删除当前实体不删除历史事实；
- 未匹配事件明确标为 unbound，可在 UI 中整理，不做猜测式多 JOIN。

## 验收

- 两个 metadata-identical API keys 重排的 fixture 不丢/串 override；有稳定 ID 时 key rotation 不换身份，无稳定 ID 时进入 explicit rebinding/collision，不伪装可自动保持；
- auth index 变化有明确重新绑定策略；
- 多 family 同 auth index 不产生重复 usage；
- missing resource 历史 usage 仍可读；
- schema migration 在现有数据上无损；
- `CONTEXT.md` 与 ADR、代码名一致。

## 建议提交

- `docs(adr): define stable CPA binding identity`
- `feat(domain): persist CPA bindings for discovered resources`
- `fix(discovery): stabilize identities without positional keys`
- `feat(domain): introduce connection identity incrementally`
- `feat(usage): bind events to stable connections`

---

# 10. 阶段 6：Usage Events 用户界面

## 已有能力

后端与 client 已存在：

- `GET /usage/events`
- `GET /usage/events/{id}`
- `GET /usage/events/{id}/request-log`
- `GET /usage/facets`
- `GET /usage/ingest-status`

位置：

- `internal/api/usage_events.go`
- `web/src/api/client.ts:275-289`
- `web/src/types/usageEvents.ts`

## 实施

1. 新增 `/usage/events` 页面和导航入口，命名与 `CONTEXT.md` 一致。
2. 列表：时间、result、provider/source、model/alias、connection/resource、latency/TTFT、token、request id。
3. 使用 server cursor 分页；不要把所有事件加载到浏览器。
4. Filters 使用已有 facets：time range、provider、source、model、auth/binding、executor、result、request id。
5. URL search params 保存可分享筛选；用户 preference 只保存非敏感视图偏好。
6. Detail Drawer/Page：完整 token breakdown、错误、服务层、endpoint 的安全摘要、resource/binding。
7. request log：仅当 `has_request_log`；下载前确认其可能含敏感请求信息；后端 no-store、审计、文件名与 ID 校验。
8. ingest status：当前 mode、last event、backlog、discarded、coverage/gap、错误、delivery semantics；不要只显示“在线/离线”。
9. Loading/empty/error/partial error/offline 全部闭环。
10. 大列表性能：虚拟化或分页，不用无限 DOM；避免引入完整图表库到事件页首屏。

## 验收

- fake CPA 数据下可从 Dashboard drill down 到筛选后的事件；
- cursor 无重复/遗漏；
- unbound/missing resource 有明确显示；
- 390px 可用；
- request log 权限和 no-store 测试通过；
- 浏览器中不泄漏本不应返回的秘密。

## 建议提交

- `feat(usage): add filterable request event explorer`
- `feat(usage): add request detail and log retrieval`
- `feat(usage): surface ingestion health and coverage`

---

# 11. 阶段 7：按价值推进 CPAMC Parity

## 完成判定

每个模块只有同时满足以下条件才能从 placeholder 移除：

- 有真实用户页面；
- 使用固定 allowlist API；
- 有权限、输入与秘密投影边界；
- loading/empty/error/offline/unsupported 状态完整；
- 主要写操作有确认、结果反馈和审计；
- fake CPA E2E 覆盖；
- `docs/cpamc-parity.md` 的 Backend/UI/Runtime 三列同步。

## 顺序 7.1：Auth Files 深化

已有列表、筛选、上传、下载、删除、启停。补：

- 字段编辑（已有后端 `PATCH /fields`，只允许明确白名单字段）；
- 模型详情（已有 `/models`）；
- quota/model quota 展示；
- priority/weight/note 等安全字段；
- 不回显 token/path/metadata/raw account。

## 顺序 7.2：Providers 与代理 API Keys

- Codex/OpenAI compatibility/Claude/Gemini 等 provider CRUD；
- API Keys 使用独立 typed endpoint，不依赖整份 YAML 保存；
- key 创建/轮换/删除使用 write-only input，列表只显示 fingerprint/末尾、安全元数据；
- provider endpoint、protocol、models、disabled 状态与 Connection/Binding 对齐。

## 顺序 7.3：OAuth

- 获取授权 URL；
- 状态轮询；
- callback/完成；
- 取消、超时、拒绝、能力缺失；
- CSRF/state/PKCE（若 CPA 流程支持）和回调 origin 验证；
- token 永不经过普通页面 response。

## 顺序 7.4：Quota

- Auth File/model quota 观察；
- reset quota 前明确影响和确认；
- capability missing 与 provider 不支持不是通用 error；
- quota 时间、来源、stale 状态可见。

## 顺序 7.5：System diagnostics

- 版本、更新检查、CPA/DB/storage/collector 状态；
- 可下载经过 redaction 的诊断包；
- 不暴露内部地址、key、路径、Auth File 内容；
- 默认不自动执行升级；升级策略单独 ADR。

## 顺序 7.6：Plugins / Plugin Store

最后实现，因为供应链和执行风险最高：

- 插件 manifest、来源、版本、权限、签名/校验和；
- 安装/启停/升级/删除审计；
- Store 内容信任边界；
- 禁止把 capability probe 等同于插件可安全安装。

## 建议提交

每个模块至少拆分 API、UI、测试/文档提交，例如：

- `feat(auth-files): edit safe credential metadata`
- `feat(providers): manage CPA provider configurations`
- `feat(oauth): orchestrate provider authorization`
- `feat(quota): expose credential and model limits`
- `feat(system): add redacted diagnostics`
- `feat(plugins): manage verified CPA extensions`

---

# 12. 阶段 8：性能、部署、安全运营与发布准备

## 8.1 前端性能

当前生产构建约：

- 主入口 1.78 MB / gzip 525.67 kB；
- YAML editor 2.96 MB / gzip 767.13 kB；
- antd vendor 1.10 MB / gzip 344.71 kB；
- YAML worker 1.02 MB。

实施：

- 路由级 lazy import；
- charts、Usage Events、Config Source editor 分离 chunk；
- 审查 `@ant-design/charts` 是否因统一包引入不需要的 graphs/G6，优先更窄依赖或轻量图表；
- Monaco 只在 Source 模式实际打开时加载，而不是 Config 页面进入即加载；
- 建立 bundle budget，CI 超限失败或需显式批准；
- 测量而非只调高 Vite warning threshold。

## 8.2 登录、审计与安全头

- 登录按来源 IP/合理代理信任策略做有界限流、指数退避和统一错误；
- 扩展阶段 1 的 append-only 审计服务，覆盖所有新增管理写操作并提供 retention/export/完整性验证：动作、目标非秘密 ID、时间、结果、request ID、来源摘要；
- CSP 先 report-only，确认 Monaco worker、Vite build 与内嵌 runtime config 可工作后强制；
- HTTPS 增加 HSTS，添加 Permissions-Policy；
- 保留 nosniff、no-referrer、frame policy；
- 明确反向代理 trusted headers，禁止任意 X-Forwarded-For 欺骗限流/审计。

## 8.3 容器与供应链

- CPA image 从 `latest + pull_policy: always` 改为用户可配置且默认固定版本/digest；
- Oh My CPA runtime 使用非 root UID/GID；
- root filesystem read-only，只允许 `/data` 必要写入；
- `cap_drop: [ALL]`、`no-new-privileges`；
- CPA/OMCPA/Caddy healthcheck + readiness-aware depends_on（按 Compose 支持范围）；
- 依赖/镜像漏洞扫描与 SBOM；
- 固定 builder/runtime 镜像版本或 digest，并制定更新节奏。

## 8.4 SQLite 运维

阶段 1 已先实现 migration 所需的最小 secured backup/restore/compatibility gate；本阶段将其产品化为完整运维能力。文档和脚本必须覆盖：

- WAL 安全备份方式（在线 backup API 或明确 checkpoint/停机流程）；
- restore 演练；
- `OMCPA_MASTER_KEY` 备份与丢失后果；
- migration 前自动加密/限权备份、空间检查、SHA-256 和 backup retention；
- expand/contract、上一 binary 兼容检查和 corrective forward rollback；
- 数据 retention 与 vacuum 策略；
- 单副本限制。

## 8.5 发布前文档

- `README.md` 只描述真实已开放能力；
- `docs/cpamc-parity.md` 拆为 Backend / UI / Runtime verified / Notes；
- capability probe 页面清楚标“探测”，不写“功能就绪”；
- 更新安全边界、部署、备份恢复、升级与故障排查；
- 给首次用户提供真实 Quick Start 后再将其视为已完成模块。

## 验收

- bundle budget 有基线且关键首屏下降；
- 容器以非 root、只读 rootfs 启动，`/omc` 正常；
- healthcheck、备份、恢复演练有自动/人工证据；
- 安全头浏览器验证无 Monaco/worker 回归；
- parity 文档与路由/API/测试一致。

## 建议提交

- `perf(web): split charts and configuration editor bundles`
- `feat(security): rate limit sign in and audit mutations`
- `feat(security): enforce browser security policy`
- `chore(container): harden runtime and pin images`
- `docs(ops): add SQLite backup restore and upgrade runbook`

---

# 13. 单 master 的完整 Git 工作流

用户已明确：项目未发布，只使用 `master`，不创建长期 integration/feature 分支。必须在这个约束下仍保持历史可审计、可回滚。

## 13.1 当前交接必须先完成（由本计划作者执行，不交给实施 Agent 猜测）

在阶段 0 开工前，先把当前计划从 staged 状态安全固化：

1. `git diff --cached --name-status` 必须只含 `goal.md`；完整审阅 `git diff --cached -- goal.md`、`git diff --cached --check` 和 staged secret scan。
2. 单独提交 `docs(plan): add Codex overhaul roadmap and git workflow`；核对 commit 内容。
3. 保留旧 `pre-overhaul-base-20260904`；另建 annotated handoff tag 指向包含计划的提交。Beta commit `78352d5e...` 已由 master parent/history 与 bundle 保存；不得移动或覆盖既有 tag。
4. 在项目外创建 `--all` bundle，执行 `git bundle verify`、`git bundle list-heads`，确认 master、旧 baseline tag、新 handoff tag；记录绝对路径和 SHA-256。
5. 用 bundle 建临时 clone 并确认可 checkout master；完成后才可把工作区干净作为实施前置。

实施 Agent 开工时执行：

```bash
git switch master
git status --short --branch
git log --oneline --decorate -10
git tag --list "pre-overhaul-*" "handoff/*"
```

预期：工作区干净，HEAD 包含计划提交与 handoff tag；如果不干净，先识别来源，禁止丢弃未知改动。

配置 remote 前先记录：当前仓库没有 remote。用户提供 URL 后才执行：

```bash
git remote add origin <USER_PROVIDED_URL>
git remote -v
git push -u origin master --follow-tags
```

不要猜测 URL，不要自动创建公开仓库。

## 13.2 每个阶段的循环

1. 从干净 `master` 开始；记录 HEAD：

   ```bash
   git rev-parse HEAD
   git status --porcelain
   ```

2. 测试先行或至少先建立失败复现；修改范围只覆盖当前主题。
3. 查看改动：

   ```bash
   git diff --stat
   git diff -- <specific paths>
   git diff --check
   ```

4. 跑当前主题测试；通过后跑适用全量门禁。
5. 按路径暂存，禁止无脑 `git add -A`：

   ```bash
   git add path/to/file1 path/to/file2
   git diff --cached --name-status
   git diff --cached --check
   git diff --cached
   ```

6. 对 staged 内容执行 secret scan。真实 key/token 命中立即停止；不得依赖后续删除，因为 secret 会留在历史。
7. Conventional Commit：

   ```bash
   git commit -m "fix(scope): concise outcome"
   ```

8. 提交后验证：

   ```bash
   git show --stat --oneline HEAD
   git status --porcelain
   ```

9. 小步继续下一 commit。`master` 任何 commit 都必须可构建；不要在阶段中间提交明显无法编译的状态。

## 13.3 Commit 规则

允许类型：`feat`、`fix`、`test`、`docs`、`refactor`、`perf`、`ci`、`build`、`chore`。

要求：

- 一个 commit 一个可独立理解/回滚的目的；
- DB migration 与使应用兼容该 migration 的最小代码可以同 commit；大 UI 不同 commit；
- 纯格式/renormalize 与功能分开；
- 生成的嵌入入口只在相关 build commit 中更新；
- commit body 说明迁移、行为变化、测试与限制；
- 不使用“misc fixes”“WIP”作为留在 `master` 的提交。

## 13.4 阶段 tag

每个大阶段通过全量门禁后创建 annotated tag，例如：

```bash
git tag -a overhaul/01-secret-governance -m "Secret governance gates passed"
git tag -a overhaul/02-config-reliability -m "Config reliability gates passed"
```

若 tag 已存在，不覆盖；使用递增后缀或先人工核对。配置 remote 后推送 tags。

## 13.5 回滚

因为只用 `master`，代码失败后优先 **revert**，不改写历史：

```bash
git revert <bad-commit>
```

- 已应用数据库迁移不做 destructive down migration，migration 文件不从历史/新提交中删除；使用新的 forward migration 恢复兼容行为。
- 每个 migration 在合入前必须有加密/限权/校验的自动备份和 restore smoke；遵循 expand/contract，并验证上一可部署 binary 对新 schema 至少能启动/只读或明确拒绝而不损坏。`git revert` 若会让旧 binary 不兼容新 DB，必须先发布兼容/纠正 commit，不得直接部署 revert 结果。
- 对未提交、但确认由当前 Codex 刚产生的单文件错误，可手工修正；若文件所有权不明，先备份和询问。
- 绝不 force push master。

## 13.6 并行 Agent

当前“仓库只保留 master”策略下禁止并行 writer，所有修改串行执行；只读 reviewer 可并行，但不得改文件。

若未来用户明确要求并行写入，必须先获得一次显式决策来放宽“只有一个分支”的约束，再使用独立 worktree/短生命周期分支、文件所有权与单 writer 规则；未经该决策不得创建临时分支。

## 13.7 Remote 与保护规则

当前没有 remote。配置 GitHub/GitLab 后建议：

- 默认分支 `master`；
- 禁止 force push 和删除；
- required checks：Go、web static、E2E、secret scan、build；
- 即使直接推 master，也启用 push rules/status checks；
- 若托管平台强制 PR，与当前“只保留 master”策略冲突，先由用户决定是否为托管平台例外放宽；未经决定不创建分支，仍不建立长期 develop 分支。

## 13.8 交接与离线备份

每次重要交接：

```bash
git status --porcelain
git log --oneline --decorate -10
git bundle create ../oh-my-cpa-handoff-YYYYMMDD.bundle --all
git bundle verify ../oh-my-cpa-handoff-YYYYMMDD.bundle
git bundle list-heads ../oh-my-cpa-handoff-YYYYMMDD.bundle
```

Bundle 必须放项目目录外，避免自己被纳入仓库；记录绝对路径、SHA-256、verify/list-heads 结果，并从它创建临时 clone 做 checkout smoke。

---

# 14. 最终发布候选验收清单

## 安全

- [ ] 历史与新资源 details 无 account/API key/token；
- [ ] 默认 Config 页面响应无秘密；
- [ ] raw YAML/原始 Auth File/request log 需要重新认证或等价高意图授权、短时 scope、no-store，且明确属于敏感浏览器例外；
- [ ] usage `api_group_key`、error body、inbox raw、proxy URL 和 fallback identity 无明文秘密扩散；
- [ ] login rate limit 与 trusted proxy 策略已测试；
- [ ] 管理写操作均有无秘密审计；
- [ ] CSP/HSTS/Permissions-Policy 在部署环境验证；
- [ ] staged/repository/image secret scan 通过。

## 数据正确性

- [ ] checkpoint/high-water/rollup/update 同一 serialized transaction 或 conditional claim，并发 aggregator totals 正确；
- [ ] destructive pop 风险被最小化且公开表达，delivery identity/dedup invariant 与 durable gaps 经重启测试；
- [ ] 同 auth index 多资源不重复事件；
- [ ] CPA Binding 稳定，数组重排不丢 override；
- [ ] migration 空库与升级库均通过；
- [ ] migration 前 secured backup/restore、上一 binary 兼容与 corrective forward rollback 演练完成。

## 用户体验

- [ ] 所有真实页面 loading/empty/error/offline/unsupported 完整；
- [ ] Config 未加载不可编辑保存；并发冲突不静默覆盖；
- [ ] Resource 四态正确；
- [ ] Usage Events 与 ingest status 可用；
- [ ] 390px dark/light 无全局横向溢出；
- [ ] 键盘、焦点、zh/en 和 token 一致；
- [ ] placeholder 只存在于确实未完成模块，文案不误导。

## 工程

- [ ] `go test ./...`；
- [ ] `go vet ./...`；
- [ ] TypeScript typecheck；
- [ ] 严格 i18n；
- [ ] payload/dirty tests；
- [ ] component tests；
- [ ] deterministic fake CPA E2E 全矩阵；
- [ ] 可选 live CPA smoke；
- [ ] production build；
- [ ] Ant Design lint 无新增问题；
- [ ] bundle budget；
- [ ] 无 remote 时 verified-bundle fresh clone 全套命令通过；有 remote 时 hosted CI 全绿；
- [ ] `git diff --check`；
- [ ] `git status --porcelain` 为空。

## 文档与 Git

- [ ] README、CONTEXT、ADR、design、parity 与实现一致；
- [ ] 每阶段提交可独立回滚；
- [ ] annotated handoff/stage tags 完整；
- [ ] remote（如已配置）与本地 master 一致；
- [ ] 交接 bundle 已创建，并完成 SHA-256、verify、list-heads 和 restore-clone smoke；
- [ ] 无 `.env`、DB、tmp、web/dist、`.pi` 或真实秘密入库。

---

# 15. 完成报告格式

Codex 完成全部或一个阶段时，必须输出：

1. **完成范围**：对应本文件阶段和条目；
2. **行为变化**：用户、API、DB、部署分别说明；
3. **迁移**：版本、兼容、备份/恢复注意；
4. **测试证据**：命令与结果，不写“应该通过”；
5. **安全证据**：secret scan、DTO/redaction、浏览器检查；
6. **Git 证据**：commit hash、tag、`git status --porcelain`；
7. **剩余风险**：未验证的 live CPA、平台/浏览器或运维限制；
8. **下一阶段建议**：严格按依赖，不跳过 P0/P1。

---

# 16. 执行记录（由 Codex 追加，不重写历史条目）

## 计划交接基线

- Beta 快照：`78352d5e232007f94a9ca0a4c8c7a6394a0ebf35`
- 基线 tag：`pre-overhaul-base-20260904` → `4b1c80db4375fa19b8ee763b5e0cf205143bb87b`
- 计划文件：本文件
- 已知第一优先级：阶段 0 仓库规范化，然后阶段 1 秘密治理；不得先开发新 placeholder 模块。

## 阶段 0 执行记录（本次验收）

- 基线：`master` 当前提交 `72803f1`；工作区保持干净。
- 可复现性：使用项目外 verified bundle `<repo-parent>\oh-my-cpa-handoff-20260903.bundle` 创建全新 clone `<repo-parent>\oh-my-cpa-verified-20260904`；bundle SHA-256 为 `32BE7FFAF1BCD5F3D3064BFBB0386D9A48244DDBFF99BAF72DB46F35E1ECC496`，`git bundle verify`、`git bundle list-heads` 与 checkout smoke 均通过。
- 固定工具链验收：Node.js `22.23.2`、Go `1.24.13`、pnpm `11.19.0`、`@ant-design/cli` `6.6.2`、`playwright-core` `1.62.1`，Chromium revision `1234` / version `151.0.7922.34`；`pnpm verify:toolchain:strict` 通过。
- workflow 同等门禁：`pnpm install --frozen-lockfile`、Chromium 安装、`pnpm verify:static`、worktree/history secret scan、`pnpm verify:e2e`、`git diff --check` 均通过。
- 测试结果：Go test/vet、TypeScript、严格 i18n、payload/dirty tests、Ant Design lint、Gitleaks worktree/history scan 全部通过；deterministic fake CPA 浏览器验收通过 51 项检查。
- 运行边界：仓库尚未配置 remote，因此本阶段没有 hosted CI URL；本地 verified clone 已完成与 workflow 等价的可执行门禁。

## 阶段 1 执行记录（P0 秘密治理）

- 目标达成：
  1. 移除 `AuthFile.Account` 在资源 identity 与 `details_json` 中的流向；fallback identity 移除数组索引，在无稳定 ID 时明确标记 `identity_collision=true`；收紧 `domain.ResourceDetails` 为严格字段与固定 allowlist `Extra`。
  2. 收紧 `/resources` 响应为显式 `resourceDetailsResponse` DTO 投影，不返回底层 domain persistence 内部对象；URL 去除 userinfo、query 及 fragment。
  3. 新增 `migrations/004_sensitive_data_cleanup.sql` 与 `sanitizeHistoricalDataTx` 迁移治理钩子，清理历史 `details_json`、`usage_inboxes.raw_message/last_error`、`error_events` body/auth_status/quota_reason，并将历史明文 `api_group_key` 与 `source` 转化为安全 keyed HMAC 或脱敏标记，新增 `api_group_label` 列。
  4. 实现迁移前安全运维前置：可用磁盘空间检查、AES-GCM 加密备份、SHA-256 校验和生成与验证、`RestoreBackupSmoke` 还原烟雾测试，以及备份轮转策略（retention）。
  5. 修复 `usage.DecodeEvent`/persistence/API 的 key 扩散：`apiGroupIdentity` 输出 keyed HMAC 与独立 `api_group_label`；`usage_inboxes` 落库默认存储安全投影并在具备应用 cipher 时加密存储原始消息；`error_events` 写入时执行字段级 redaction。
  6. 建立最小追加写入 `audit_events` 表与审计服务，完整覆盖：Auth File 删除与下载、Logs 清理、Config scalar/source 保存、Config source 查看、request-log 下载；审计写失败时 fail-closed 阻止敏感内容外发或破坏性变更，并记录 ERROR 告警。
  7. 编写完整的迁移升级、备份还原、审计追加与失败注入、DTO allowlist 排除秘密的自动化测试。
  8. 更新 `README.md` 安全边界声明，严格对齐已验证事实。
- 验证结果：
  - `go test ./...` 全绿（涵盖 repository 迁移与备份还原测试、audit 服务与注入测试、DTO allowlist 测试、security、usage decode、ingest 与 API 测试）；
  - `go vet ./...` 零警告；
  - `pnpm type-check`、`pnpm test:i18n`、`pnpm check-i18n`、`pnpm test:payload`、`node --experimental-strip-types scripts/test-dirty.ts`、`pnpm build`、`pnpm lint:antd` 全部通过；
  - `pnpm verify:secrets:worktree` 与 `pnpm verify:secrets:history` 均无泄漏（0 leaks）；
  - `pnpm verify:e2e` 51 项 deterministic fake CPA 浏览器验收测试全部通过。
- 剩余风险与已知限制：
  - 依赖单节点本地 SQLite 与本地主密钥 `OMCPA_MASTER_KEY`；
  - CPA 后端如果直接返回不受控格式的错误，仍依赖基于规则与正则的文本脱敏；
  - 阶段 5 将在 ADR 中进一步固化完整 CPA Binding 层级体系。

## 阶段 2 执行记录（Config 可靠性、并发与秘密边界）

- 目标达成：
  1. 阻断配置拉取失败后的 fail-open 行为：当配置接口异常（如 CPA offline、502/503 或网络失败）时，阻断工作区进入可编辑或可保存状态，明确提示错误与 Retry，禁止无凭据回退默认值与宣称“已同步”；当存在旧数据但刷新失败时，明确显示 stale 状态并锁定保存。
  2. 修复保存基线竞争：`onSuccess(data, variables)` 严格使用提交的 snapshot 变量 `variables.yamlToSave` 作为新基线；请求期间产生的新修改保持 dirty，不被误标为已同步。
  3. 建立强版本（Revision）与冲突检测契约：
     - 后端计算并返回 YAML 的 SHA-256 强 revision 与 ETag；
     - PUT 保存请求强制校验 `If-Match` 头或请求体 `revision`；
     - 引入实例作用域互斥锁串行化写操作，锁内重新获取当前 YAML 校验 revision；若检测到并发修改，返回 409 Conflict 与机器可读错误码 `config_conflict`，前端提供重新加载最新配置或复制本地修改进行人工合并的选项，杜绝静默覆盖。
  4. 保护原始 YAML 与凭据秘密边界：
     - 默认视觉模式改用安全投影 `safe_yaml` 与安全 DTO，自动去除 `proxy_url` 中的 userinfo 及敏感 query 参数；
     - 敏感字段（`remote-management.secret-key`、`api-keys`、`tls.key` 等）采用 `__OMCPA_UNCHANGED__` 占位符脱敏保护，在服务端更新时执行 AST 节点还原，防止掩码写回破坏原始真实配置；
     - 原始 Source 模式接入高意图重认证机制：切换前弹出风险说明与重认证模态框，验证 CPA 管理密钥并生成 5 分钟有限授权 `grant_token`；无授权或授权过期时请求 raw YAML 返回 403 `reauth_required`；离开 Source 模式或注销后立即清理内存中 raw YAML 缓存。
  5. 关键 schema 与语法防护：后端在保存前执行严格 YAML 语法校验，语法错误返回行号、列号与机器可读错误码 `yaml_syntax_error`。
  6. 审计与离线化保障：所有配置读取与变更均写入不可篡改的 `audit_events` 表；Monaco Editor 严格本地化，消除控制台异常与页面错误。
  7. 自动化测试套件：
     - 新增 `scripts/test-config-states.ts`，覆盖 initial/loading/loaded/error/dirty/validating/saving/save-success/save-error/conflict 完整状态机；
     - 新增 Go 单元与集成测试：覆盖 revision 生成、409 冲突检测、缺少 revision 校验、403 授权保护、401 密钥验证、AST 敏感占位符还原与语法校验。
- 验证结果：
  - `go test ./...` 全部通过；
  - `go vet ./...` 零警告；
  - `pnpm type-check`、`pnpm check-i18n`、`pnpm test:i18n`、`pnpm test:payload`、`pnpm test:config-states`、`node --experimental-strip-types scripts/test-dirty.ts`、`pnpm lint:antd` 全部通过；
  - `pnpm build` 顺利产出并同步嵌入静态资产；
  - `pnpm verify:secrets:worktree` 与 `pnpm verify:secrets:history` 均无泄漏；
  - `pnpm verify:e2e` 53 项 deterministic browser checks 全部通过（包含源码模式重认证授权流程与无 page errors 校验）。
- 剩余风险与已知限制：
  - CPA 上游若被外部非 Oh My CPA 客户端绕过并发起并发写入，Oh My CPA 提供 best-effort 级别的冲突探测（锁内 re-fetch 校验），受限于 CPA 是否原生提供 CAS 支持；
  - 交付至浏览器内存或 DevTools 的 Raw YAML 无法做远程内存清除保证，因此依靠 `no-store` 和退出 Source 清理进行风险最小化。

## 阶段 3 执行记录（Logs、Health、Resources 与 UI 正确性）

- 目标达成：
  1. 修复 Logs 页面假死与无反馈问题：
     - 当 `logs-status` 接口失败（CPA offline、鉴权失败或网络故障）时，停止虚假 loading 状态，明确展示错误 Alert（区分 offline/auth/capability/unknown）与重试入口；
     - 修复 clearLogs 异常吞没：清空日志失败时提示具体错误原因，保留当前页面上下文与确认状态，并在清空成功后展示反馈。
  2. 修复 Health / Instance 拓扑泄露与状态混淆：
     - 公共 `/healthz` 移除内部 `cpa_base_url` 暴露，仅在认证后的实例/管理端点呈现拓扑；
     - `database_status` 真实接入 `PingContext` 轻量探针；
     - 明确 liveness 与 readiness 分离：数据库故障返回 503 与 `status: error`；CPA 断开连接时进程与数据库健康，返回 200 与 `status: degraded` 及 `cpa_connected: false`；
     - `InstanceStatusPage.tsx` 使用 `health.cpa_connected` 驱动 CPA 在线卡片，将应用探针、数据库健康与 CPA 连通性彻底解耦显示。
  3. 修复 All Resources 四态生命周期过滤与移动端布局：
     - 筛选器与状态标签由领域状态 `claimed | unclaimed | ignored | missing` 严格驱动，将“已个性化命名”与状态生命周期解耦独立展示；
     - 列表请求失败时阻断伪造空表，展示 Alert 与 Retry 链路；
     - 修复 390px 移动端布局横向溢出问题，加入响应式滚动容器；
     - 规范化 `ResourceEditDrawer.tsx` 国际化标签与 Missing/Ignored 可用行为。
  4. 改进可访问性与设计系统 Token：
     - `AppLayout.tsx` 的品牌交互增加键盘导航（Enter/Space）支持与 `aria-label`；
     - 补充缺失的 `--bg-surface` 与 `--font-mono` 主题字体与表面变量定义；
     - 清理资源与全局组件中不规范的行内样式与颜色；
     - 清理并收紧 Ant Design 弃用警告基线（从 22 条降至 7 条，0 新增问题，0 a11y 异常）。
- 验证结果：
  - `go test ./...` 全部通过（包含新增的 `TestHealthzLivenessAndReadinessPartitioning`）；
  - `go vet ./...` 零警告；
  - `pnpm type-check`、`pnpm check-i18n`、`pnpm test:i18n`、`pnpm test:payload`、`pnpm test:config-states`、`node --experimental-strip-types scripts/test-dirty.ts` 全部通过；
  - `pnpm lint:antd` 通过（0 a11y、0 usage、0 performance，弃用基线收紧至 7 条）；
  - `pnpm build` 顺利完成静态资源打包与嵌入；
  - `pnpm verify:secrets:worktree` 与 `pnpm verify:secrets:history` 零泄漏；
  - `pnpm verify:e2e` 53 项端到端检查全数通过。
- 剩余风险与已知限制：
  - 移动端视图目前采用局部横向滚动容器适配超宽表格，更深度的卡片流模式可随需求进一步拓展。
