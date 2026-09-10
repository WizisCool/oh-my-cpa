# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **核心用户**：在本地开发机、个人服务器、HomeLab、VPS 或 Tailscale 私有网中自建并运行 AI 基础设施的个人开发者与站长。
- **使用场景与任务**：用户拥有多套异构 AI 凭据（如 ChatGPT Plus/Pro OAuth 凭据、OpenCode Go / Command Code API Key、DeepSeek、上游聚合中转接口等），通过底层 CLIProxyAPI (CPA) 统一做协议适配与中转调度；用户使用 Oh My CPA 作为管理控制台，为技术驱动赋予明确的业务归属、直观命名、状态监测、模型定价与用量统计。
- **衍生受众（受限阶段）**：小型团队或工作室成员共用单 CPA 实例时的只读或受限控制面（后续演进目标）。

## Product Purpose

- 为 CLIProxyAPI (CPA) 提供用户专属的“AI 资源身份与整理中心”（Identity & Triage Center）。
- 解决底层代理网关中凭据只有无序技术字段（如驱动类型、auth_index、文件路径）的困扰，建立清晰的本地元数据映射层。
- **成功标准**：
  1. **零密钥泄露**：CPA 管理密钥及各上游 Secret 不进入普通浏览器状态、日常日志或公开响应；
  2. **发现与整理闭环**：底层配置或文件变动被自动捕获进 `discovered_resources` / `cpa_bindings`，未认领（Unclaimed）状态可被确认，历史归属不因上游改动而错位（详见 `docs/adr/0002-cpa-binding-and-identity-hierarchy.md`）；
  3. **实时感知与统计**：具备秒级滑动的实时（15m）到多周期用量看板，支持准确的模型成本估算与缓存命中度量；
  4. **极致清爽的操作体验**：毫秒级响应，开箱即用，无任何网络 CDN 依赖。

## Positioning

- **“CPA 负责执行，Oh My CPA 负责身份与整理”**。
- Oh My CPA 不复刻底层执行平面的协议代理，不充当通用反向代理，而是作为专用控制面（Control Plane）。
- 建立用户自己的命名、图标、颜色、备注与定价事实源，所有权归用户所有并持久化于本地 SQLite，与 CPA 实例松耦合解耦。

## Operating Context

- **部署形态**：与 CPA 同机部署，通常作为 Docker Compose 内部网络同栈服务，或运行于内网独立端口；
- **访问入口**：默认绑定于子路径 `/omc/`，通过 Caddy / Nginx 等反向代理或本地 Vite 代理进入；
- **拓扑架构**：Go 模块化单体后端（提供 `/omc/api/v1` 等端点），SQLite WAL 模式存储，嵌入式编译的 React + TypeScript + Ant Design SPA 前端；
- **开发流**：Air 监听 Go/SQL 文件自动热重载，Vite 提供前端 HMR 并单向代理 API；
- **认证模式**：整套系统单一凭据源——CPA Management Key。服务端基于 HMAC-SHA256 签发 HttpOnly `SameSite=Strict` Cookie，前端无管理员密码也无持久化 Secret。

## Capabilities and Constraints

- **核心功能**：
  - CPA 资源自动发现与稳定绑定：`auth-files`、`codex-api-key`、`openai-compatibility` 等族按 ADR 0002 的五级身份层级解析出稳定 Resource Key 与 Binding Fingerprint（Claimed / Ignored / Missing 生命周期）；发现与绑定模型仍由后端维护，控制台当前通过 Providers 与 Auth Files 页面呈现，不再单设待整理队列页面；
  - 资源业务属性覆盖：自定义 DisplayName、Color、内置 PresetIcon / LobeIcon、Notes（后端 `PATCH /resources/{id}/override` 与 `resource_overrides` 仍在，当前无前端调用方）；
  - 凭据生命周期与真实阻断：支持 OAuth 凭据文件管理（列表 / 上传 / 下载 / 删除 / 启停 / priority-weight-note 字段编辑 / 模型列表）；Provider 级别停用真实下发至 CPA 协议层（通过 `excluded-models: ['*']` 实现有效阻断）。后端 auth-file 字段白名单还接受 `prefix` / `proxy_url` / `disable_cooling` / `excluded_models` / `expired`，但当前抽屉表单只暴露 priority、weight、note 三项；
  - 监控看板与用量流：基于 CPA RESP 协议采集流式用量事件；支持 15m 实时滑动窗口、多预设周期与开闭自定义时间范围；
  - 模型计费与成本计算：以请求时价格快照为准（ADR 0003），models.dev 价格自动同步与本地行级定价覆盖；
  - 系统自检与脱敏诊断包导出、插件与插件商店管理、审计日志留痕；
  - 零 CDN 离线运行：前端产物完整内嵌至 Go 二进制，内网与断网环境正常工作。
- **强制约束**：
  - 子路径原生兼容：全局代码必须原生支持 `/omc` 前缀（`VITE_BASE_URL`），禁止硬编码根路径 `/`；
  - 单副本单写者：面向单实例 SQLite WAL 设计，不引入未决的分布式多写机制；
  - 严格白名单 API：浏览器只与 Oh My CPA 后端通信，严禁提供通用的任意 CPA 端点透传；
  - 双语完全本地化：中文与英文全量对齐（`web/src/i18n/index.tsx`），界面禁止中英夹杂与未经翻译的英文。

## Brand Commitments

- **品牌标识**：Oh My CPA，标志性命令行提示符前缀 `›_`，“Make CPA yours”。
- **视觉风格**：Terminal-flat console（极简平铺终端控制台）。
  - 扁平无阴影：全局 `box-shadow: none`，无装饰性渐变，层级仅通过 1px 细边框与背景明度差表达；
  - 等宽字体：Sarasa Mono SC 优先，Berkeley Mono / IBM Plex Mono 作为回退，数据采用等宽对齐；
  - 克制的主题，突出的数据（Quiet chrome, loud data）：UI 框架沉底，色彩仅用于关键状态；
  - 绝对的语义化色彩：绿（正常/健康）、橙（降级/告警）、红（异常/禁用）、灰（离线/非活跃）；
  - 极速动效：过渡时间 pinned ≤ 100ms，以手部响应跟随（跟手）为唯一目的，严禁加载闪烁与图表动画。

## Evidence on Hand

- **核心领域术语与规则**：`CONTEXT.md`；
- **模块地图、数据流与不变量**：`docs/architecture.md`；
- **历史执行计划与阶段验收记录（已完结归档）**：`goal.md`；本仓库后续的 Agent 契约改为 `AGENTS.md`；
- **系统架构决策记录**：`docs/adr/`；
- **视觉与 Token 权威源**：`docs/design.md`，代码映射见 `web/src/theme/themeConfig.ts` 与 `web/src/index.css`（根目录 `DESIGN.md` 是同一套 token 的 design-tool 摘要，两者必须一致）；
- 自动化测试用例：`internal/api/*_test.go`，覆盖凭据防护、看板统计、配额限流与 DTO 严格白名单机制。

## Product Principles

1. **用户所有权优先（User-Owned Identity）**：底层驱动与协议参数只是技术细节，业务身份、命名和组织永远归属用户。
2. **防线内聚，零隐患外泄（Zero Secret Leakage）**：认证密钥与上游 Secret 止步于后端，控制台只传递状态与必要展示信息。
3. **真实诚实，状态明确（Honest UI & Granular States）**：明确区分无服务（Blocked）、加载中（Loading）与无数据（Empty）；网络颠簸与错误时保持上一帧数据并提示告警，绝不出现整页突兀空白。
4. **克制至上，高效为纲（Quiet & Restrained Craft）**：不堆砌花哨动效，不使用虚假占位符，以极高信息密度与明确视觉层次服务开发者工作流。

## Accessibility & Inclusion

- 全键盘支持与醒目的 `:focus-visible` 轮廓；
- 严格遵循 WCAG AA（≥ 4.5:1）色彩对比度，连续状态指示（如 Cache Rate）基于 OKLCH 空间计算并保障文字对比度；
- 状态表达去色盲化：状态通过“指示灯（Pip）+ 文本”双重显式传达，禁止仅依赖颜色区分状态；
- 完整支持 `prefers-reduced-motion`，系统开启减弱动画时自动冻结动态进度并关闭位移淡入。
