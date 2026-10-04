<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="web/src/assets/brand/omc-wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="web/src/assets/brand/omc-wordmark-light.svg">
  <img src="web/src/assets/brand/omc-wordmark-dark.svg" alt="Oh-My-CPA" width="340">
</picture>

### 集中管理 API 与 OAuth，可视化观测请求、成本、用量

MCP · 可视化 · 管理

<br />

[![Release](https://img.shields.io/github/v/release/WizisCool/oh-my-cpa?label=release)](https://github.com/WizisCool/oh-my-cpa/releases)
[![CI](https://github.com/WizisCool/oh-my-cpa/actions/workflows/ci.yml/badge.svg)](https://github.com/WizisCool/oh-my-cpa/actions/workflows/ci.yml)
[![Stars](https://img.shields.io/github/stars/WizisCool/oh-my-cpa?style=flat&label=stars)](https://github.com/WizisCool/oh-my-cpa/stargazers)
[![Go](https://img.shields.io/badge/Go-1.25+-00ADD8?style=flat&logo=go&logoColor=white)](https://go.dev)
[![CLIProxyAPI](https://img.shields.io/badge/CLIProxyAPI-v8+-4f46e5?style=flat)](https://github.com/router-for-me/CLIProxyAPI)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)

<br />

**[在线演示](https://omc-demo.junze.dev)** ·
[安装](#安装) ·
[交给 Agent](#让-agent-帮你安装) ·
[文档](#文档) ·
[English](README.md)

<br />

<a href="https://omc-demo.junze.dev">
  <img src="docs/images/readme/hero-split.zh.webp" alt="Oh My CPA 仪表盘，左半为浅色主题，右半为深色主题" width="100%">
</a>

</div>

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（CPA）负责协议适配、凭据执行与请求代理。
**Oh My CPA** 是它旁边的控制面：一个用来运营网关的 Web 控制台，以及网关自身并不保存的用量记录。
它以单个 Go 二进制交付，内嵌 React 控制台，数据存放在本地 SQLite，无需 CDN、无需外部数据库，也没有第二套密码。

<table>
<tr>
<td width="25%" valign="top">

### 观测

实时仪表盘、全年 Token 热力图，以及可多维筛选的请求记录：耗时、首字延迟、Token 与费用一目了然。

</td>
<td width="25%" valign="top">

### 管理

提供商、OAuth 登录、客户端密钥、配额、插件，以及 CPA 的 `config.yaml`，表单或 YAML 两种方式均可编辑。

</td>
<td width="25%" valign="top">

### 计费

每条请求在完成时锁定费用。价格来自 OpenRouter 或由你自定义，历史账目不会随调价漂移。

</td>
<td width="25%" valign="top">

### 自动化

内置智能体与 MCP 服务通过声明式能力操作控制台，所有变更都需经你批准。

</td>
</tr>
</table>

## 在线演示

> [!TIP]
> **[体验 Oh My CPA →](https://omc-demo.junze.dev)**
> 用示例数据体验控制台。

## 界面截图

<table>
<tr>
<td width="50%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/usage-events-dark.zh.webp">
  <img src="docs/images/readme/usage-events-light.zh.webp" alt="请求记录：每条请求的耗时、Token 与费用">
</picture>
<p align="center"><b>请求记录</b><br />按模型、提供商、密钥、状态与费用筛选每一条请求</p>
</td>
<td width="50%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/pricing-dark.zh.webp">
  <img src="docs/images/readme/pricing-light.zh.webp" alt="按提供商分组的模型价目表">
</picture>
<p align="center"><b>费用与用量</b><br />自动匹配 OpenRouter 价格，也可自定义覆盖</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/oauth-management-dark.zh.webp">
  <img src="docs/images/readme/oauth-management-light.zh.webp" alt="OAuth 凭据及其状态与配额">
</picture>
<p align="center"><b>OAuth 管理</b><br />登录、查看配额、配置凭据，集中在一处完成</p>
</td>
<td width="50%" valign="top">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/readme/ai-providers-dark.zh.webp">
  <img src="docs/images/readme/ai-providers-light.zh.webp" alt="AI 提供商列表、启停开关与流量">
</picture>
<p align="center"><b>AI 提供商</b><br />端点、模型、优先级，以及在网关层真正生效的启停开关</p>
</td>
</tr>
</table>

以上截图会跟随你的 GitHub 主题切换。控制台本身也一样：浅色、深色或跟随系统，每种模式各有三套内置配色，还可以自定义一套。

<div align="center">
  <img src="docs/images/readme/mobile.zh.webp" alt="手机上的仪表盘、请求记录与 OAuth 管理" width="88%">
  <p><b>手机上同样好用。</b>每个页面都为窄屏重新排版。</p>
</div>

## 安装

OMC 连接 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) **v8.0.0 及以上**。
可以使用已有网关，也可以用 Compose 启动新的 CPA。CPA 管理密钥同时是 OMC 的登录密码。

### Docker Compose（推荐）

直接拉取 Docker Hub 镜像 **`wiziscool/oh-my-cpa:v0.1.0`**（`amd64` / `arm64`），
无需源码构建或安装开发工具链。在**新目录**中启动 CPA 和 OMC，默认只绑定本机端口：

```bash
mkdir -p oh-my-cpa/deploy oh-my-cpa/cpa/{auths,logs,plugins} oh-my-cpa/oh-my-cpa-data
cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/download/v0.1.0/compose.full.yml -o deploy/compose.full.yml
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/download/v0.1.0/cpa.config.example.yaml -o cpa/config.yaml
sudo chown 10001:10001 oh-my-cpa-data
sudo chmod 700 oh-my-cpa-data

umask 077
cat > deploy/.env <<EOF
CPA_MANAGEMENT_KEY=$(openssl rand -hex 24)
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
OMCPA_PUBLIC_URL=http://127.0.0.1:8080
TZ=UTC
EOF

docker compose --env-file deploy/.env -f deploy/compose.full.yml pull
docker compose --env-file deploy/.env -f deploy/compose.full.yml up -d
```

打开 **`http://127.0.0.1:8080/omc/`**，使用 `deploy/.env` 中的
`CPA_MANAGEMENT_KEY` 登录。调用模型前，在控制台配置提供商凭据与客户端密钥。
部署在远程服务器时，使用 SSH 隧道或你已有的 HTTPS 入口访问。

**已经有 CPA 或其他管理面板？** 使用
[`deploy/compose.omc.yml`](deploy/compose.omc.yml) 只安装 OMC，保留已有服务，
并确认由谁采集用量。详见[安装指南](docs/install.md#docker-compose-beside-an-existing-cpa)。

### Let your agent install it

把下面的提示交给 Claude Code、Codex、Cursor 或其他编码 Agent：

```text
按照以下指南安装和配置 Oh My CPA：
https://raw.githubusercontent.com/WizisCool/oh-my-cpa/master/docs/install-for-agents.md
先检查我已有的 CPA、OMC、管理面板、网络和用量采集器。
选择适合现有环境的安装方式，保留已有服务、配置和密钥。
```

[Agent 安装指南](docs/install-for-agents.md) 覆盖全新部署、已有 CPA、其他管理面板、
直接访问、已有 HTTPS 入口、原生构建与升级；要求验证成功后才能报告完成。

### 从源码构建

需要 Go 1.25+、Node.js 22+、pnpm 11+，以及已运行的 CPA：

```bash
git clone https://github.com/WizisCool/oh-my-cpa.git
cd oh-my-cpa
pnpm install --frozen-lockfile
cp .env.example .env
# Configure the master key and the existing CPA management key privately in .env.
pnpm build
go build -trimpath -o bin/oh-my-cpa ./cmd/oh-my-cpa
./bin/oh-my-cpa
```

打开 **`http://127.0.0.1:8080/omc/`**。

> [!IMPORTANT]
> 备份 `OMCPA_MASTER_KEY`，它用于解密数据库中的数据。每个本地磁盘数据目录只运行一个副本，
> 每个 CPA 用量队列只允许一个采集器。若已有其他服务采集用量，设置
> `OMCPA_USAGE_INGEST_MODE=off`。验证与升级见[安装指南](docs/install.md)，
> 标签驱动的发布流程见[发行指南](docs/releasing.md)。

## 智能体与 MCP

**在控制台里。** `/agent` 页面让一个已经通过 CPA 路由的模型回答问题并操作控制台：
用量与请求分析、提供商、OAuth、配额、客户端密钥、配置与定价。读操作直接执行；
变更在服务端预备好之后，等你点一次「允许」或「拒绝」。密钥、令牌与 OAuth 授权不会进入模型上下文。

**在你自己的 Agent 里。** 同一套能力也通过二进制自带的 MCP 服务提供：

```json
{
  "mcpServers": {
    "oh-my-cpa": {
      "command": "/path/to/oh-my-cpa",
      "args": ["mcp"],
      "env": {
        "OMCPA_SERVER_URL": "https://cpa.example.com/omc",
        "OMCPA_CPA_MANAGEMENT_KEY": "<你的 CPA 管理密钥>"
      }
    }
  }
}
```

外部 Agent 可以读取状态、预备一项操作，但不能批准它、提交密钥或完成 OAuth 登录。
管理密钥等同于管理员权限，请只接入你愿意把控制台交给它的 Agent。
契约见 [`docs/agent-capabilities.md`](docs/agent-capabilities.md)。

## 功能特性

<details open>
<summary><b>网关与提供商</b></summary>

- **AI 提供商**：Codex、Claude、Gemini、Meta Muse、xAI、Vertex AI、Gemini Interactions、DeepSeek 及 OpenAI 兼容服务，统一管理凭据、模型、优先级、权重、代理，以及在网关层真正生效的启停开关。
- **OAuth 管理**：在控制台直接登录 Codex、Claude、Antigravity、xAI、Kimi、Devin 与 Meta Muse；按凭据管理认证文件、模型列表、别名与配额。
- **客户端密钥**：创建、命名与吊销网关 API Key，名称会出现在请求记录与筛选项中。
- **模型目录**：直接从上游提供商拉取模型列表。
- **操练场**：用文本与图片调试任意已路由的模型，支持流式多轮对话与请求诊断。
- **插件**：已安装插件、插件商店与类型化配置表单集中在一个页面。

</details>

<details>
<summary><b>用量观测</b></summary>

- **仪表盘**：请求量、Token 吞吐、缓存命中率与费用，支持 15 分钟到 90 天的预设窗口或任意自定义区间，并提供全年 Token 热力图。
- **模型面板**：Token 趋势与用量环形图，可按调用点或上游模型统计，并展示费用占比。
- **请求记录**：多选分面筛选与全文搜索；详情抽屉展示耗时、首字延迟、Token 明细与单请求原始日志。
- **后台采集**：无论是否打开浏览器，用量都会通过流式订阅或轮询持续入库。
- **日志与审计**：尾随网关日志、查看控制台自身的服务日志，并浏览带筛选与 JSON 导出的追加式操作审计。

</details>

<details>
<summary><b>定价与成本</b></summary>

- **请求时价格快照**：请求完成时通过不可变价格版本锁定费用。
- **OpenRouter 价目表**：依据 OpenRouter 公开列表为网关提供的每个模型定价，支持长上下文分档与分时段价格。
- **关联与自定义价格**：把模型关联到指定的 OpenRouter 条目，或自行设置费率，附带分档预设与试算器。
- **渠道倍率**：按提供商缩放其应答的全部请求，例如按 3 折计费的中转站。

</details>

<details>
<summary><b>配置与安全</b></summary>

- **双模式配置编辑**：结构化表单，或保留注释的 Monaco YAML 编辑器。
- **配置自动备份**：每次改写 `config.yaml` 之前自动保存一份加密副本，可在控制台恢复。
- **静态加密**：已存储的凭据与原始用量消息采用 AES-GCM 加密。
- **敏感操作审计**：查看密钥、下载认证文件、导出日志等操作都会写入审计日志，写入失败则拒绝执行。
- **为离线而设计**：所有资源都在二进制内，无需访问任何 CDN。
- **按你的习惯来**：四种界面语言、可自定义配色的浅色与深色主题、部署时区，以及 K/M/B 或 万/亿 数字单位。

</details>

## 架构

```text
浏览器 ──▶ 直接访问 / 已有 HTTPS 入口 ──▶ Oh My CPA (:8080)
                                           ├─ 内嵌 React SPA (/omc/)
                                           ├─ SQLite WAL (/data)
                                           └─ 用量采集器 ──▶ CLIProxyAPI (:8317)
```

- **单二进制**：React 控制台内嵌在 Go 可执行文件中。
- **单副本**：SQLite WAL 模式，每个数据目录只允许一个进程。
- **原生支持子路径**：默认挂载在 `/omc`（`OMCPA_BASE_PATH`），可与 CPA 共用同一个主机名。
- **白名单门面**：控制台从不透传 CPA 的原始响应，也不代理任意 URL。

模块划分、数据流与不变量见 [`docs/architecture.md`](docs/architecture.md)。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `OMCPA_CPA_BASE_URL` | 必填 | CPA 的地址 |
| `OMCPA_CPA_MANAGEMENT_KEY` | 必填 | CPA 管理密钥，同时是控制台登录密码 |
| `OMCPA_MASTER_KEY` | 必填 | 静态加密密钥（`openssl rand -hex 32`） |
| `OMCPA_BASE_PATH` | `/omc` | 控制台挂载的子路径 |
| `OMCPA_DATA_DIR` | `./data` | SQLite 数据库所在目录 |
| `OMCPA_PUBLIC_URL` | 未设置 | 浏览器访问的地址；为 `https://` 时会话 Cookie 带 `Secure` 标记 |
| `OMCPA_USAGE_INGEST_MODE` | `auto` | 已有其他服务采集该 CPA 的用量时设为 `off` |
| `TZ` | 系统时区 | 服务器日历；请与 CPA 保持一致 |

完整的配置参考、部署约束与运维须知见 [`docs/operations.md`](docs/operations.md)。

## 文档

除本页外，技术文档均以英文撰写。

| | |
| --- | --- |
| [`docs/install.md`](docs/install.md) | 安装、验证、升级与排障 |
| [`docs/install-for-agents.md`](docs/install-for-agents.md) | 写给编码 Agent 执行的安装指南 |
| [`docs/releasing.md`](docs/releasing.md) | Docker Hub 镜像与 GitHub 标签发布流程 |
| [`docs/operations.md`](docs/operations.md) | 配置参考与运维须知 |
| [`docs/ops/sqlite-operations.md`](docs/ops/sqlite-operations.md) | 备份、恢复与主密钥管理手册 |
| [`docs/agent-capabilities.md`](docs/agent-capabilities.md) | 智能体能力契约与 MCP 桥接 |
| [`docs/architecture.md`](docs/architecture.md) | 模块边界、数据流与不变量 |
| [`docs/cpa-v8-compat.md`](docs/cpa-v8-compat.md) | CPA v8 基线与配置字段迁移对照 |
| [`docs/cpamc-parity.md`](docs/cpamc-parity.md) | 与官方 CPA 管理中心的功能对位 |
| [`CONTEXT.md`](CONTEXT.md) · [`docs/design.md`](docs/design.md) | 领域术语 · 视觉系统 |
| [`docs/ops/cloudflare-demo.md`](docs/ops/cloudflare-demo.md) | 在线演示的部署方式 |

## 开发

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev          # Air + Vite 热重载，地址 http://127.0.0.1:5173/omc/
```

| 命令 | 用途 |
| --- | --- |
| `pnpm test:fast` | 只运行工作区改动影响到的检查 |
| `pnpm check:ui` | 只运行改动能触及的浏览器场景 |
| `pnpm verify` | 推送前运行的静态门禁 |
| `pnpm verify:full` | 在本地运行 CI 的全部内容 |
| `pnpm readme:screenshots` | 用演示模式重新生成本页截图 |

环境搭建与验证流程见 [`CONTRIBUTING.md`](CONTRIBUTING.md)；
[`AGENTS.md`](AGENTS.md) 是编码 Agent 在本仓库中遵循的契约。

## 贡献与安全

欢迎提交 Issue 与 Pull Request，请先阅读 [`CONTRIBUTING.md`](CONTRIBUTING.md)。
安全漏洞请按 [`SECURITY.md`](SECURITY.md) 的说明私下报告，不要公开提 Issue。

## 致谢

Oh My CPA 的存在离不开 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)，最难的部分由它完成。

也感谢 [Linux.do 社区](https://linux.do)。

## 开源协议

[MIT](LICENSE)
