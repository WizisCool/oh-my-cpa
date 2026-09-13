# Oh My CPA · Brand & Theme Tokens

Single source of truth for the visual system. OpenCode-inspired, product-owned:
interaction patterns and information density draw inspiration from OpenCode's
minimalist developer console, while brand identity (`›_`), warm terminal palette,
CPA information architecture, and security boundaries strictly belong to Oh My CPA.
Values are mirrored in code at:

- `web/src/theme/themeConfig.ts` — `palette` object + antd `ThemeConfig`
- `web/src/index.css` — CSS custom properties on `:root`

**Rule: never hardcode a color in components.** Import from `palette`, or use
the CSS variable. When a value changes, change it here and in those two files
only.

## 1. Design language

Terminal-flat console. Depth comes from **1px borders + background shifts**,
never shadows or gradients. Sarasa Mono SC first (Berkeley Mono, then IBM Plex
Mono as fallbacks), 4px radii, dense but breathable spacing.

| Principle | Meaning |
| --- | --- |
| Flat | `box-shadow: none` globally; borders carry all structure |
| Monospace | All text uses the mono stack; tabular numerals for data |
| Quiet chrome, loud data | UI scaffolding stays muted; status color is reserved for real state |
| Semantic color only | Green/red/amber mean enabled/error/warning — never decoration |

## 2. Color palette

### Dark (default)

| Token | Value | antd mapping | Usage |
| --- | --- | --- | --- |
| `--bg` | `#201d1d` | `colorBgBase`, `colorBgLayout`, `colorBgContainer` | App background, inputs, tables |
| `--surface` | `#302c2c` | `colorBgElevated`, `colorFillTertiary` | Cards, panels, dropdowns, hover states |
| `--fg` | `#fdfcfc` | `colorText`, `colorTextBase` | Primary text |
| `--fg-2` | `#c8c6c4` | `colorTextSecondary` | Secondary text |
| `--muted` | `#9a9898` | `colorTextTertiary` | Hints, legends, labels |
| `--meta` | `#6e6e73` | `colorTextQuaternary` | Group labels, footnotes |
| `--border` | `#464343` | `colorBorder` | Primary 1px borders |
| `--border-soft` | `#302c2c` | `colorBorderSecondary`, `colorSplit` | Row dividers, inner borders |
| `--accent` | `#007aff` | `colorInfo`, `colorLink` | Links, info, active bars, selection |
| `--accent-hover` | `#0056b3` | `colorPrimary` | Filled primary buttons |
| `--accent-active` | `#004085` | `colorPrimaryHover/Active` | Pressed state |
| `--success` | `#30d158` | `colorSuccess` | Enabled / healthy / ok pip |
| `--warn` | `#ff9f0a` | `colorWarning` | Degraded / quota warning |
| `--danger` | `#ff3b30` | `colorError` | Failed / disabled / delete |

### Light

| Token | Value |
| --- | --- |
| `--bg` | `#fdfcfc` |
| `--surface` | `#f1eeee` |
| `--fg` | `#201d1d` |
| `--fg-2` | `#424245` |
| `--muted` | `#6e6e73` |
| `--meta` | `#9a9898` |
| `--border` | `rgba(15, 0, 0, 0.12)` |
| `--border-soft` | `rgba(15, 0, 0, 0.07)` |

Accent/success/warn/danger are identical in both modes.

### Status pip semantics

`ok/loaded → success` · `degraded/quota → warn` · `invalid/error/401 → danger`
· `inactive/offline/disabled → meta (gray)`. Pips are 7×7px, radius 2px.

**One pip per verdict.** A pip labels the state of the number it sits on, so a
row that shows a rate and its two components gets one pip — on the rate. The
components carry state by their own colour instead: a failure count is `danger`
when it is above zero and `meta` when it is not, because "0 failures" is not a
success worth painting green.

**Success rate is a verdict, not a distance from 100%.** A gateway that fans out
to several upstreams always carries some noise — provider 429s, a timeout the
next retry absorbs, a request the caller cancelled — and a pip that turns amber
for that noise teaches its reader to ignore it. So the bands are wide, and they
are stated in *failures* rather than successes (`98% success` is a number nobody
reasons about; `2% of requests failed` is a decision):

| Window | Pip |
| --- | --- |
| no requests | `neutral` — nothing to judge |
| no failures | `success` — a clean window |
| too little evidence: under 20 requests *and* under 3 failures | `neutral` — a coin flip on four requests is not a trend |
| ≤ 5% failed | `neutral` — routine upstream noise |
| > 5% and ≤ 20% failed | `warn` — worth a look |
| > 20% failed | `danger` — broken, whatever the sample |

The bands live in `successRateVerdict` (`web/src/types/usageEventView.ts`). The
dashboard tile reads them; the request list does not show a verdict of its own,
for the reason below.

### Latency is not a verdict

The request list prints latency in plain `--fg` at every value. A long duration
is not a fault when the workload includes agents: a request that thinks for
minutes is doing its job, and the old `>= 4000 ms → amber` rule painted normal
traffic as degraded. Latency is read against its own baseline (the TTFT/stream
waterfall in the detail drawer), never against an absolute threshold, and the
semantic hues stay reserved for state.

### The request list carries no summary strip

The page used to open with a row of aggregates — page count, success rate with a
pip, mean latency, tokens, estimated cost. It was removed, and the rule it
violated is worth keeping:

- **Four of the five numbers restated the rows directly beneath them.** The page
  count is in the footer, and the totals are sums of the visible page, not of the
  window — so they changed meaning whenever the reader paged or filtered, without
  saying so, and they measured only the loaded page rather than what the reader
  believes they measure.
- **The one reading that was not a restatement was the success-rate pip, and it
  answered a question the list already answers per row.** A gateway's failure
  rate is a dashboard concern: it is a property of a *window*, and the dashboard
  owns windows. The list owns individual requests. Putting a window-level verdict
  on a page-sized sample (100 rows) made a 1-in-100 failure read as a 1%
  failure — the exact misreading that produced the 98%-shows-amber complaint.
- **A list is not a KPI view.** The strip consumed a full row of vertical space
  above the data it summarised, so on a 900px viewport 10% of the height went to
  information already available further down.

Totals belong where the whole window is in scope: the dashboard tiles, and the
detail drawer for one request. If a per-page figure is ever needed again, it
belongs in the footer next to the page count, stated as a page figure.

### Cache-rate scale

The request list's cache-rate badge is the one continuous reading in the app:
the value itself is a quality, so the badge paints it instead of bucketing it.
`0%` yellow → `100%` green, with no thresholds and no steps. **Red is not on the
scale**: a low hit rate is not a failure, and the danger hue is reserved for
failed requests, so a weakly-cached request never reads as an error.

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `--cache-rate-yellow` | `#ffd60a` | `#6e5b00` | 0% stop |
| `--cache-rate-green` | `#30d158` | `#00662a` | 100% stop |
| `--cache-rate-tint` | `12%` | `22%` | badge fill = hue over `--bg` |
| `--cache-rate-edge` | `32%` | `34%` | badge border = hue over `--bg` |

Rules:

1. **Interpolate in OKLCH**, via `color-mix(in oklch, …)`. Letting the browser
   mix keeps the stops as design tokens instead of hex values baked into a
   component, and OKLCH keeps the hue sweep even. The component never names a
   colour: `cacheScale.ts` returns the two stops as `var()` references plus the
   low stop's weight, and the CSS mixes them.
2. **The stops are palette steps, not new colours.** The dark stops are the
   semantic hues lightened until the 11px badge text clears **4.5:1** against the
   badge's own tint; the light stops are the darker reading of the same hues
   (the low end is ochre — a saturated yellow cannot also be legible on a light
   page). Measured worst case across the ramp in the browser harness: **6.70:1**
   dark, **4.69:1** light (asserted at ≥ 4.5:1 for every sampled rate, including
   the row's hover state). The light fill is stronger than the dark one because
   a light page needs more tint before the badge reads as a badge, which is why
   the two values differ.
3. **The top of the scale is presentation policy.** `100%` is not shown: the
   badge stops at **99.9%** (`MAX_CACHE_RATE`; the Go dashboard aggregate caps
   identically) so the app never claims a perfect hit rate. Readings carry **one
   decimal**; a rate that rounds to zero reads as `0%`, never `0.0%`.
4. **No data is not 0%.** A record with no token data gets the same badge shape
   at the neutral step (`--muted`) with an em dash, never a zero: "nothing
   cached" and "nothing measured" are different facts. The dashboard tile shows
   the same em dash when the window carried no prompt tokens.
5. The hue is redundant encoding — the percentage is printed in the badge — so
   the ramp needs no legend and no colour-only reading.

**Deferred: cache-write accounting.** A provider that accounts cache buckets
separately (Anthropic-style) reports prompt tokens as `input + cache_read +
cache_creation`, so its hit ratio currently reads high because the written
tokens sit outside the denominator. Counting them needs evidence the app does
not keep: CPA classifies each payload by provider/executor and emits a canonical
breakdown, but the decoder persists only the raw counts, and the hourly/daily
rollups carry no provider column, so a window cannot be split by convention.
Fixing it means persisting the breakdown (or per-convention token columns in the
rollup) before any arithmetic change. Until then the ratio is a bounded estimate
for cache-writing providers, and the request list is exact only for providers
whose input already includes the cached prefix.

### Caller-key display mask

The request list's Key column and the caller-key facet show a mask, never the
key. The shape is a short head, a fixed bullet run, and a short tail:
`sk-1234••••••••7890`. A key too short for edges to identify it is masked
completely (`••••••••`) — exposing four of an eight-character key would give
away half the secret while still failing to name it, so short keys are
intentionally indistinguishable from one another. The filler is a constant
length, so the mask never reveals the secret's length.

- **Identity is the fingerprint.** Grouping, filtering and deduplication use the
  keyed HMAC (`api_group_key`), which is also what the detail drawer shows. The
  mask exists only for a human reading the list.
- **Legacy masks are converted on read.** Rows ingested before the filler
  changed still carry `xxxxxxx`; the list, detail and facet projections
  normalize the filler and keep the visible edges. Nothing reconstructs a
  secret, and a missing mask stays missing.
- **Shape checking is not a security boundary.** A credential can contain the
  filler, so `IsMask` only stops an obviously unmasked value from being written
  to a display column; provenance comes from masking at ingestion.

## 3. Typography

```text
Font stack   "Sarasa Mono SC", "Sarasa UI SC", "Sarasa Term SC", "更纱黑体 SC",
             "Berkeley Mono", "IBM Plex Mono", ui-monospace, SFMono-Regular,
             Menlo, Monaco, Consolas, "Liberation Mono", monospace
Subset font  Build-time subsetted woff2 (< 100KB per weight, Regular & Bold)
             embedded in assets; local Sarasa Mono SC takes zero-latency priority.
Base size    14px (antd token fontSize)
Line height  1.5
Tabular      font-variant-numeric: tabular-nums on all numeric data
```

| Level | Size / weight | Usage |
| --- | --- | --- |
| Page title (`--text-xl`) | 22px / 700 | One per page, the verdict or page name |
| Section h2 | 16px / 600 | Dashboard sections |
| Hero number | 42px / 700, letter-spacing −0.04em | The one big KPI |
| KPI value | 28px / 700 | Stat cards |
| Body | 14px / 400 | Default |
| Data / mono | 12–13px | Tables, logs, code |
| Eyebrow | 10px / 500, letter-spacing 0.16em, uppercase, `--muted` | Tiny group labels above KPI numbers only |

**Hierarchy rules:**

1. One page title per page — the dashboard title is the *verdict* (运行稳定。),
   other pages use the nav label. No duplicated subtitles restating it.
2. No decorative subtitles. A subtitle exists only when it carries live data
   (e.g. `Default CPA · 已连接`, `3 个认证条目`), never static marketing copy.
   The same rule covers warning text: a state label (`CPA 未开启文件日志`) plus
   an action (`重试`) is the whole message. Sentences explaining *why* the switch
   exists, or promising what another screen will do, are documentation pasted
   into the UI — an operator who needs them is looking at the wrong product.
3. No stacked language pairs: a Chinese UI never shows English captions for the
   same thing (both languages localize fully; proper nouns like "Provider" may
   remain English in zh copy where that is the industry term).
4. Body max width `1440px`; page padding 32px desktop / 24px tablet / 16px phone.

## 4. Shape, spacing, elevation

```text
radius-sm     4px    inputs, buttons, tags, cards, pips (the app's radius)
radius-lg     6px    modals/drawers outer shell only
space scale   4 · 8 · 12 · 16 · 20 · 24 · 32 · 48px
section gap   32px (dashboard sections)
card padding  20px (antd Card paddingLG)
page head     title block left, actions right, 24px bottom margin
header        56px tall, 1px bottom border
sider         236px (58px collapsed), 1px right border
```

Elevation: **zero shadows** on layout, card, drawer, modal, popover, dropdown.
`--focus-ring: 0 0 0 2px var(--accent)` is the only ring.

## 5. Layout skeleton

```text
┌──────────┬──────────────────────────────────────────┐
│ brand ›_ │ breadcrumb (分组 / 页面)   actions  中|EN │ 56px, border-bottom
│──────────┼──────────────────────────────────────────┤
│ nav      │                                          │
│ (groups) │ page content        ← scrolls alone      │
│          │                                          │
│ foot:    │                                          │
│ CPA conn │                                          │
└──────────┴──────────────────────────────────────────┘
   236px        1fr    — both columns scroll independently
```

- `body { overflow: hidden }` — the shell is `100dvh`; sidebar and content
  scroll independently (`overscroll-behavior: contain`).
- Nav groups: 运行 / 网关 / 观测 / 控制 (+ Oh My CPA). Group labels 10px
  uppercase `--meta`. Items: icon + label only, no subtitles. Selected item =
  2px `--fg` inset rule (`box-shadow: inset 2px 0 0 var(--fg)`) + `--fg` bold text,
  never a filled background block. Hover uses `--surface` for immediate feedback.
- Sider foot shows live CPA connection + version in `--meta`.

### OpenCode-inspired patterns (OpenCode 设计哲学吸收)

Oh My CPA 吸收了 OpenCode 控制台纯粹、高效、工程师优先的设计理念，同时保持 Oh My CPA 自有的暖墨色调、安全边界与技术架构：

1. **开放式行列表 (Open List Pattern)**
   - 模型、凭据、配置项等列表优先采用无外层 Card 包装的开放式行列表。
   - 依靠极细的底边分割线 (`border-bottom: 1px solid var(--border-soft)`) 分隔行。
   - 结构清晰：左侧实体名与标识、中间技术元数据/Provider、右侧直接交互操作（如 Switch 开关、操作按钮）。
2. **按任务分配界面密度 (Task-dependent Density)**
   - 监控与高频数据（Dashboard、实时日志、资源整理）：高密度、紧凑、Tabular 等宽对齐。
   - 配置与系统管理（Config、计费、系统设置）：留白更加舒展，采用 32–48px 分节间距与全宽 1px 分割线。
3. **严格的卡片边界 (Honest Card Boundaries)**
   - 卡片仅用于：核心 KPI、关键实体摘要、同类对象横向比较。
   - 严禁将单个输入框或单个开关单独装入独立 Card 中制造“卡片拼贴”感。
4. **同级对比面板 (Peer Comparison Panel)**
   - 吸收多列横向对比卡片模式：外层整洁栅格 + 1px 细线边框 + 内部分隔线（上部主要对比值，下部次级关联源与底部品牌徽标）。
5. **上下文引导文案 (Contextual Next Actions)**
   - 允许一行简明、说明当前操作对象或下一步行为的引导句（如带下划线链接的 `了解更多.` / `联系我们`）。
   - 依然禁止空洞的营销副标或长篇大论的文档说明。
6. **顶部上下文槽位 (Top Context Slot)**
   - 左侧保留 `›_` 品牌标识，未来支持多 CPA 实例时可复用类似工作区下拉的“实例上下文选择器”；
   - 右侧承载真实会话状态、主题与中英切换。未接入真实能力前绝不伪造头像、余额或工作区假入口。
7. **表单与配置工作台规范 (Form Workbench & Setting Group Panels)**
   - **全宽顶栏与视觉平衡 (Full-width Toolbar & Viewport Anchoring)**：顶部操作栏（Toolbar）与 1px 底边线 100% 贯穿全屏，右侧操作区（搜索/刷新/保存）推至最右侧（与全局 Header 右侧操作严格垂直呼应），彻底消除顶栏在半路截断导致的“右侧空旷黑洞”；下方表单工作台则保持 216px 粘性分区导航 + 920px 阅读宽度 + 216px 右侧配重槽的三轨栅格（第三轨只负责居中配平，不放内容），形成“通栏置顶立格局，主体聚焦易输入”的专业层次。
   - **模块化设置面板 (Setting Group Panels)**：严禁所有字段全部生硬平铺在一条无尽的横向流水账中，也不得每个字段单独套卡片。而是将相关配置收敛为 **Setting Group Panel**（具备统一的 1px 细线外框、`--surface` 底色与 4px 终端圆角），内部依据配置性质采用三种专业结构：
     1. **Form Grid（表单网格）**：文本、数字、下拉框采用“标签与说明在上、控件在下”的局部工整网格；强相关短字段（如 Host 与 Port、重试次数与间隔）并列同行，短数字框限制为 120px，下拉框限制为 260px，输入焦点清晰聚焦；
     2. **Settings List（策略开关行）**：特性开关与运行标志行采用“左侧标题说明 + 右侧 Switch”的卡片内行列表，最大行宽收敛在卡片容器内，右侧具有坚实的边框边界，彻底杜绝孤立悬空；
     3. **Entity List（实体凭据列表）**：API Keys 列表保留独立的 32×32px 方形功能按键与 Tooltip，强化操作安全感与防误触；
     4. **TLS 渐进折叠 (Progressive Disclosure Panel)**：组头承载启用开关，关闭时只呈现状态说明，启用后平滑展开证书路径与私钥路径网格，折叠时保留已有 YAML 数据并禁用不可见控件。
   - **顶部紧凑粘性工具条 (Sticky Action Toolbar)**：页面标题、同步胶囊、模式切换（`可视化 / 源码`）与右侧操作区（搜索、刷新、保存）收敛为单行置顶工具栏，保存按钮固定于最右端，告别空置模式行与跨屏折返跑。
   - **独立触控目标 (Target Ergonomics)**：高频行内操作采用独立方形按键（32×32px，1px 边框与微弱底色），提供充足点击热区与 Tooltip 反馈，而非易误触的裸图标。
   - **表单控件规格**：复杂表单控件高度统一提升至 38px~40px / 14px 字号，强化输入舒适度与可读性；数字输入框采用左对齐并预留 34px 右侧内边距，彻底杜绝 AntD 步进加减按钮对数值的重叠与遮挡。
   - **IDE 级源码编辑器 (Monaco YAML Source Editor)**：
     - **离线与零 CDN 约束**：显式注入本地打包的 `monaco-editor` 核心与 `editor.worker`、`yaml.worker`，严禁通过 CDN 加载远程静态资源；禁止远程 Schema 请求（`enableSchemaRequest: false`）；
     - **轻量化按需拆包**：通过 `React.lazy` 实现动态加载，不增加首页和可视化模式的首屏体积；通过 Vite 别名按需收敛，剥离无关语言（TypeScript/CSS/HTML 等 workers），仅保留核心 `editor.worker` (274 KB) 与 `yaml.worker` (1017 KB)；
     - **终端扁平主题匹配**：针对暗色与浅色注册专属主题（`omc-dark`、`omc-light`），统一采用更纱黑体（Sarasa Mono SC）等宽字体栈与 1px 细线外框，消除 VS Code 默认蓝黑主题的跳脱感；
     - **全功能 IDE 交互**：支持 YAML 语法高亮、括号匹配、缩进参考线、代码折叠、`Ctrl+F` 查找与替换、`Ctrl+S` 原生保存拦截、以及显式触发的 YAML 格式化与语法校验提示。
   - **吸底浮动操作栏 (Floating Dirty Action Bar) 与确认语义**：
     - **触发时机**：仅在存在未保存修改（`isDirty === true`）时浮现，平时完全隐藏；右上角操作栏同步呈现【放弃更改】按钮；
     - **视口居中与非侵入**：依托主布局暴露的 `--app-sider-width` 动态居中于内容区，无论用户在“可视化”还是“源码”模式、滚动到页面任何深度，都能随时一键点击保存或放弃修改；外层采用 `pointer-events: none` 穿透，绝不遮挡下层页面交互；
     - **纯粹黑客风质感**：严格遵守终端无大阴影、无入口编舞约束，采用 1px 细线边框、`--surface` 纯色底色与纯粹的琥珀色 dirty 提示点；
     - **操作二次确认准则**：
       - **保存操作（写操作）**：无论是右上角顶栏还是底部浮动栏，点击“保存配置/保存更改”均触发气泡二次确认（Popconfirm），快捷键（`Ctrl+S` / `Cmd+S`）同步触发确认模态框，确保关键系统配置不被意外触碰；
       - **放弃更改（回退操作）**：右上角与底部浮动栏点击“放弃更改”均**无需二次确认**，一键直接无损回滚至服务端配置，Dirty 状态与浮动栏即刻干净退场；
       - **状态保护**：源码存在语法错误或 Payload 规则未填完整时禁用保存并精准悬浮提示原因。
   - **模块化 Payload 规则构建器 (Payload Rules Builder)**：
     - **摆脱通用 TextArea 泥潭**：弃用低效的两行原始 JSON 文本框，依照 CPAMC 官方设计体系打造结构化折叠面板（默认规则、默认 Raw 规则、覆盖规则、覆盖 Raw 规则、过滤规则）；
     - **双向无损 AST 映射**：直接挂接 YAML Document AST，模型、协议、类型化参数（字符串/数字/布尔/null/复杂JSON）、Raw 文本片段与过滤路径独立控件编辑；严格保留 Payload 节点之外的所有配置项、字段顺序与注释，编辑过的 Payload 子树按标准格式回写并保留未知字段（`_extra`）；
     - **表单输入校验时机 (Pristine → Touched → Submitted)**：严禁在用户刚打开页面或点击“添加规则”时就大面积飘红报错；必填项初始保持纯净中性状态，只有在用户失焦离开字段（`onBlur`）或主动尝试提交保存时，才精准展示错误提示，输入有效后错误即刻实时自动消散；
     - **高级匹配条件弹窗**：支持扩展配置来源协议（`from-protocol`）、请求头匹配（`headers`）、路径相等匹配（`match` 单键对象数组）、路径不相等匹配（`not-match`）与路径必须存在/不存在检查规则。
   - **架构评估：为何不引入 @ant-design/pro-layout / pro-components？**：
     - 需求中的浮动操作栏与列表表单在 ProComponents 中为 `FooterToolbar` 和 `ProFormList`，但它们绑定了庞大的 `rc-field-form` 和臃肿的大厂中后台设计范式；
     - 引入将增加数兆体积，与“单一 Go 二进制内嵌零 CDN 离线运行”相悖，且其默认白色大阴影与我们追求的 1px 极细边框黑客风完全冲突；
     - 自研纯原生组件无缝结合 YAML AST 状态流，体积精简 100%、响应灵敏且自由度极高。

### Time range control

One button names the window (`近 1 小时`, or `08-11 – 至今`); the rest lives
in its popover. **最近** lists the quick windows and nothing else — no secondary
column repeating the span each one resolves to. **自定义** is antd's own range
picker: its panel, its two-month calendar, nothing wrapped around it. Wrapping a
date picker in a draft state and a second Apply control means two opinions about
when a date is "chosen", and users feel the disagreement.

The picker stays day-granular on purpose. `showTime` collapses antd's range panel
to one calendar plus time columns — the least legible thing in the component —
and it keeps 确定 disabled until the end field has a value, which makes an empty
end impossible. Without it, `allowEmpty` works the way the antd docs advertise:
**leave the end empty and the range runs 至今**. A picked end means *through*
that day, so `08-09 → 08-21` really includes the 21st.

Three kinds of window, and only the first two move:

| Chosen | Behaviour |
| --- | --- |
| 实时 / 最近 N (preset) | Sliding: re-resolved against `now` on every poll, so the newest bucket keeps appearing. |
| 自定义, end left empty | Growing (至今): fixed start, end tracks `now`. Polled like a preset. |
| 自定义, closed range | Frozen: shown exactly as picked, never polled. |

The choice is stored on the server, not in the browser: a reload, a service
restart and a container rebuild must all bring back the window the operator was
looking at. A date picker that is not in use never sits in the toolbar.

The selected row is marked the way a TUI marks it — a 2px accent inset rule and
the text weight, not a filled block. Polling is paced to the resolution being
served — `bucket / 12`, clamped to 5s–120s — because refreshing faster than the
grid can change costs queries and buys nothing. There is no "live" switch: the
shortest preset **is** live. It is fifteen minutes at one bucket per minute, so
the pacing rule lands on its five-second floor by itself; five minutes was too
narrow to read as a trend and an hour too coarse to feel like it was moving.

## 6. antd theme wiring (themeConfig.ts)

Non-obvious decisions, keep these when editing:

- `colorPrimary: accentHover (#0056b3)` — filled controls use the deeper step;
  `colorInfo/colorLink: accent (#007aff)`. This is why buttons don't glow
  antd-blue while links stay recognizable.
- Menu: `itemSelectedBg = transparent`, `itemSelectedColor = fg`,
  `activeBarBorderWidth: 0` — kills the default blue selected block and avoids
  heavy filled blocks; active position uses the left 2px `--fg` inset rule.
- Switch: `colorPrimary = success (#30d158)` — active toggle switch uses
  semantic success green (enabled/healthy), never decorative blue.
- Modal & Drawer: `1px solid var(--border)`, zero shadow, 4px/6px radii. Simple
  single-task dialogs use a clean uninterrupted body ("Title → Field/Content →
  Right-aligned Actions") without decorative header/footer hairline dividers;
  only complex Drawers retain section dividers.
- Table: uppercase 12px `--muted` headers on `--bg`, `rowHoverBg = surface`.
- All shadow tokens set to `'none'`; every motion token pinned to ≤ 0.1s (§7).
- Components pinned: Button 32/28px, Input active ring `accent22`,
  Select optionSelectedBg = surface, Tag defaultBg = bg.
- Chart tooltips are not antd. G2 renders them as `.g2-tooltip` HTML outside the
  canvas and styles that panel from `interaction.tooltip.css`, so
  `chartTheme.tooltipStyle` supplies it — every declaration reads a CSS variable
  first (`var(--surface, …)`) and keeps the palette as fallback, which is what
  lets an already-open tooltip repaint when the theme flips. The hover rule is
  canvas-drawn and cannot read variables, so it takes `palette.border` for the
  active mode.

## 7. Motion

```text
hover / state colour   none — it paints the frame the pointer arrives
fast    50ms    antd motionDurationFast
base    100ms   antd motionDurationMid and Slow: drawers, modals, route and data transitions
float   60ms    popovers and dropdowns — the click already said "open"
ease    cubic-bezier(0.2, 0, 0, 1)
```

No bounces, no scale-ins. Content appears; it does not "fly".

### Motion is restraint, not decoration

The interface is deliberately raw and terminal-like. Motion exists only to make
state changes feel continuous and **hand-following** (跟手) — never to impress.
When fluidity and flourish compete, keep fluidity; when flourish and
performance compete, drop the flourish.

Hard rules:

1. **Animate compositor-only properties** — `opacity` and `transform`. Never
   `width`, `height`, `top`, `margin` or anything that triggers layout or
   repaint of a large subtree.
2. **Keep the animated area tiny.** A 2px progress bar is acceptable; dimming or
   fading a whole grid is not — it forces the browser to composite the entire
   page on every refresh.
3. **No gradient shimmer.** antd's `Skeleton active` and similar sweeping
   gradients cost frames and clash with the flat aesthetic. Use static skeleton
   blocks.
4. **Suppress spinner flash.** A request that resolves quickly must never paint a
   loading indicator at all (`DataProgress` waits 200ms before showing).
   Background auto-refresh should be invisible.
5. **Charts do not animate.** `animate: false` everywhere: G2 canvas
   re-renders are the most expensive thing on the dashboard, and a line snapping
   to new data reads as honest, not janky.
6. **Feedback must be immediate.** Optimistic affordances (button `loading`,
   the progress bar) appear on the interaction itself, not after a transition.
7. **Hover is not an animation.** A hover is the interface acknowledging the
   pointer, so it paints on the frame the pointer arrives — never a transition
   on a hover colour. The trap: antd hangs menu-item hover, submenu expand and
   the sider collapse off `motionDurationSlow`, whose default is 0.3s, and
   setting only Fast/Mid leaves the nav feeling drags. All three tokens are
   pinned ≤ 0.1s in `themeConfig.ts`.

### Never hard-swap a view

**A painted frame must never go blank between two states.** This applies to
every transition: route changes from the sidebar, dashboard window presets,
custom range changes, manual refresh and background refetch.

| Situation | Required behaviour |
| --- | --- |
| Route change | Content sits in a keyed `.route-transition` that fades in over 100ms with a 3px rise, and the scroll position resets with the new page. |
| Query key change (preset, range, filter) | `placeholderData: keepPreviousData` — the previous result stays on screen while the next one loads. |
| Any request in flight | The app-wide 2px `.data-progress` bar, shown after a 200ms delay. Regions are never dimmed or unmounted. |
| First load with no data yet | Render the real page frame with static `Skeleton` blocks, not a bare full-page spinner swap. |
| Error after data existed | Keep the stale data visible and surface a warning; only replace the page when nothing was ever loaded. |
| Auto-refresh poll | Nothing moves. The poll is not a view change, so it must not reset pagination, remount the list, expand a collapsed header, or relabel the data as "previous results". |

`prefers-reduced-motion` removes the fade and freezes the progress bar, but the
no-blank rule still applies — fall back to a static loading state.

### Live tail: follow at the top, hold when reading

A polling list is a live tail, and a live tail has to answer one question: does
the reader want to be carried along, or are they reading?

- **At the top** (within a few pixels) the reader is following. New records appear
  immediately; the newest is always the first row.
- **Scrolled away** the reader is reading. The rows on screen are held exactly as
  they are, the poll keeps running in the background, and a pill above the footer
  reports `N 条新记录` — clicking it applies the backlog and returns to the top.
  Scrolling back to the top by hand resumes the follow, so the pill is never the
  only way out.

The pill replaces the plain back-to-top button when there is a backlog, because
the two are the same gesture. Jumping the reader to the top on every poll — or
reordering the rows under the cursor — is the failure mode this exists to
prevent: it is what Grafana, Datadog, Sentry and Vercel logs all refuse to do.

Two supporting rules keep the follow honest:

1. **Pagination survives a poll.** The view scope is the filters plus the page
   the reader chose; the auto-refresh counter is deliberately outside it. It used
   to be inside, which silently reset every reader to page one.
2. **The list is ordered by recording order**, not by request time, so whatever
   the collector wrote last is the first row. See `docs/architecture.md` for why
   that needs its own index and what it costs.

### Scroll: a gesture moves, a correction lands

The list itself scrolls, so its scrolls carry two different intentions and they
must not share a behaviour:

| Intent | Scrolls | Behaviour |
| --- | --- | --- |
| Gesture | Back to top, applying the `N 条新记录` backlog | Animated, unless `prefers-reduced-motion` |
| Correction | Pinning row one after the header collapses, resetting on page change | Instant |

A correction is not a weaker gesture, it is a different job. Collapsing the header
and paging both need row one on screen *before* the next statement runs, and the
list re-measures after committing new rows — so a correction that is still gliding
is a correction that has not landed, and the reader sees a position nobody asked
for in between. `web/src/utils/smoothScroll.ts` names the two intents and owns the
schedule.

**The animation is driven in JavaScript, not by CSS.** Setting `scroll-behavior:
smooth` on the list holder looks like the natural implementation and does not
work: the list is virtualized, so the virtualizer owns that element, keeps writing
`scrollTop` on its own schedule, and wins. Measured against the real list the
holder never moved at all. So `animateScrollToTop` interpolates frame by frame and
pushes every frame through Listy's own `scrollTo`, which leaves exactly one
authority over the offset and no fight to lose. The schedule is a pure function of
elapsed time rather than an accumulator, so a dropped or late frame cannot make the
gesture drift or overshoot, and the last frame writes `0` explicitly — a
return-to-top that arrives *approximately* at the top has not returned to the top.

An animated return to the top emits scroll events the whole way up, so the page
holds the collapse state until it arrives (bounded by a deadline, in case the
reader interrupts it and it never does). Without that, the early frames — which
still carry a large `scrollTop` — would re-collapse the header on the first frame
of the very gesture that was expanding it.

## 8. Checklist for new UI
- [ ] Colors only via `palette` / CSS vars; semantic colors carry meaning
- [ ] A continuous scale (cache rate) reads from its own tokens, never a
      per-component hex, and stays ≥ 4.5:1 against its own badge fill
- [ ] No shadows, no gradients, 4px radius
- [ ] Mono font inherited (never set a new font-family)
- [ ] One page title; subtitles only with live data; no zh/en duplication
- [ ] Nav position marked by 2px `--fg` left tick rule, not a filled block or semantic color
- [ ] Settings and management favor open section lists over heavy card wrappers
- [ ] Cards reserved for KPIs, summaries, and peer comparisons
- [ ] Switches use `--success` when active (green = enabled)
- [ ] Status shown with pip + text, never color alone
- [ ] Numbers tabular; empty states say what's missing (no fake data or invented workspace/account placeholders)
- [ ] "Nothing to show" distinguishes its reasons: blocked (cannot serve it),
      loading (no answer yet), empty (a live source with nothing in it). One
      shared message makes a working page look broken.
- [ ] Wheel scrolls only the hovered column; page never scrolls body-wide
