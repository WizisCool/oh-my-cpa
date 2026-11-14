<div align="center">

<a href="#gh-light-mode-only">
  <img src="web/src/assets/brand/omc-wordmark-light.svg#gh-light-mode-only" alt="Oh-My-CPA" width="340">
</a>
<a href="#gh-dark-mode-only">
  <img src="web/src/assets/brand/omc-wordmark-dark.svg#gh-dark-mode-only" alt="Oh-My-CPA" width="340">
</a>

### 集中管理 API、OAuth 与路由，可视化观测请求、配额与成本

管理 · 路由 · 可观测性 · Agent & MCP

<br />

[![Release](https://img.shields.io/github/v/release/WizisCool/oh-my-cpa?label=release)](https://github.com/WizisCool/oh-my-cpa/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/WizisCool/oh-my-cpa/ci.yml?branch=main&label=CI)](https://github.com/WizisCool/oh-my-cpa/actions/workflows/ci.yml)
[![Stars](https://img.shields.io/github/stars/WizisCool/oh-my-cpa?style=flat&label=stars)](https://github.com/WizisCool/oh-my-cpa/stargazers)
[![Docker Pulls](https://img.shields.io/docker/pulls/wiziscool/oh-my-cpa?style=flat&logo=docker&logoColor=white)](https://hub.docker.com/r/wiziscool/oh-my-cpa)
[![CLIProxyAPI](https://img.shields.io/badge/CLIProxyAPI-v8+-4f46e5?style=flat)](https://github.com/router-for-me/CLIProxyAPI)
[![License](https://img.shields.io/badge/license-MIT-blue.svg?style=flat)](LICENSE)

<br />

**[Live Demo](https://omc-demo.junze.dev)** ·
**[在线文档](https://omc.junze.dev/docs/zh/)** ·
**[API 参考](https://omc.junze.dev/api-reference/)** ·
[快速开始](#快速开始) ·
[核心特性](#核心特性) ·
[English](README.md)

<br />

<a href="https://omc-demo.junze.dev">
  <img src="docs/images/readme/hero-split.zh.webp" alt="Oh My CPA 仪表盘，左半为浅色主题，右半为深色主题" width="100%">
</a>

</div>

**Oh My CPA**（OMC）是面向 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) **v8+** 的自托管 Web 控制台与用量可观测层，基于 `shadcn/ui` 构建并适配桌面端与移动端。OMC 集中管理提供商、OAuth 账号、可视化路由与插件生态，并提供实时请求记录、基于 OpenRouter 的定价分析、额度窗口预热以及内置 Agent/MCP 工作流；所有敏感数据采用 AES-GCM 静态加密，每次写入配置前自动备份且全程审计。

> [!TIP]
> 立即体验 **[Live Demo](https://omc-demo.junze.dev)**，阅读完整 **[中文文档站](https://omc.junze.dev/docs/zh/)** 或浏览 **[API 接口参考](https://omc.junze.dev/api-reference/)**。

## 界面一览

<table>
<tr>
<td width="50%" valign="top">
<img src="docs/images/readme/usage-events.zh.webp" alt="请求记录：每条请求的耗时、Token 与费用">
<p align="center"><b>请求记录</b><br />按模型、提供商、密钥、状态与费用筛选每条请求</p>
</td>
<td width="50%" valign="top">
<img src="docs/images/readme/pricing.zh.webp" alt="按提供商分组的模型价目表">
<p align="center"><b>费用与用量</b><br />OpenRouter 自动匹配、渠道倍率与自定义阶梯价目表</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/readme/insights.zh.webp" alt="洞察：多维度用量对比与趋势分析">
<p align="center"><b>洞察分析</b><br />多维度对比密钥、模型、提供商用量及流量去向</p>
</td>
<td width="50%" valign="top">
<img src="docs/images/readme/agent.zh.webp" alt="智能体：内置对话助手与交互式管理">
<p align="center"><b>智能体与 MCP</b><br />自然语言查询用量与带人工审批的安全操作</p>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<img src="docs/images/readme/oauth-management.zh.webp" alt="OAuth 凭据及其状态与配额">
<p align="center"><b>OAuth 与窗口预热</b><br />统一管理账号、窗口容量推算与定时预热任务</p>
</td>
<td width="50%" valign="top">
<img src="docs/images/readme/ai-providers.zh.webp" alt="AI 提供商列表、启停开关与流量">
<p align="center"><b>AI 提供商</b><br />端点、模型、优先级与网关级启停开关</p>
</td>
</tr>
</table>

<div align="center">
  <img src="docs/images/readme/mobile.zh.webp" alt="手机上的仪表盘、请求记录与 OAuth 管理" width="88%">
  <p><b>桌面与移动端</b><br />全路由一致的响应式控制台体验</p>
</div>

## 快速开始

### 交给编码 Agent 自动安装

将以下提示词发送给 Claude Code、Codex 或 Cursor：

```text
按照这份指南帮我安装 Oh My CPA：
https://raw.githubusercontent.com/WizisCool/oh-my-cpa/main/docs/install-for-agents.md
```

### Docker Compose 一键部署（含 CPA）

一次性部署 CLIProxyAPI v8+、Oh My CPA（非 root `10001:10001`、只读根文件系统）与独立更新器：

```bash
mkdir -p oh-my-cpa && cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.full.yml -o compose.yml
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/cpa.config.example.yaml -o config.yaml
printf 'CPA_MANAGEMENT_KEY=%s\nOMCPA_MASTER_KEY=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" > .env
chmod 600 .env
docker compose up -d
```

浏览器打开 **`http://127.0.0.1:8080/`**，使用 `.env` 中的 `CPA_MANAGEMENT_KEY` 登录；客户端推理请求发往 `http://127.0.0.1:8317`。

### 接入已有 CLIProxyAPI 或使用原生二进制

如需在现有 CPA 旁独立部署（`compose.omc.yml`）、下载 **macOS / Windows / Linux / FreeBSD 原生可执行文件**，或配置端口、数据目录与 HTTPS 反向代理，请参阅 **[安装指南](docs/zh/install.md)**（[英文版](docs/install.md)）。

> [!IMPORTANT]
> 请务必妥善备份 `.env`。`OMCPA_MASTER_KEY` 负责加密数据库中的凭据与密钥，丢失后数据将无法读取。

## 核心特性

- **网关与路由管理**：统一管理 Codex、Claude、Gemini、Meta Muse、xAI、Vertex AI、DeepSeek 与 OpenAI 兼容渠道、客户端密钥、OAuth 凭据与额度窗口预热、可视化路由泳道、模型操练场，以及默认连接 [OMC Community 插件源](https://github.com/omc-community/omc-plugins) 的插件生态。
- **全链路观测与计费**：SSE 实时请求记录与路由流向图、永久聚合统计、多维度洞察分析、OpenRouter 价格自动匹配（含长上下文/分时段/渠道倍率）、11 种展示货币换算与不可篡改审计日志。
- **配置边界与安全**：结构化表单 / Monaco YAML 双模式配置编辑与改前加密备份、AES-GCM 静态加密、多套主题色板与字体库、内置 Agent 与 MCP 安全审批链路。

## 架构概览

```text
浏览器 ──▶ 直接访问 / HTTPS 反向代理 ──▶ Oh My CPA (:8080)
                                          ├─ 内嵌 React SPA (/)
                                          ├─ SQLite WAL (/data)
                                          └─ 用量采集器 ──▶ CLIProxyAPI (:8317)
```

- **单二进制交付**：React 控制台内嵌于 Go 可执行文件，每个本地 SQLite WAL 目录严格单副本运行。
- **容器权限隔离**：仅独立 `oh-my-cpa-updater` 服务挂载 Docker Socket 并校验 Ed25519 签名清单按摘要更新，主服务保持只读与非 root。

## 文档导航

访问在线双语文档站 **[omc.junze.dev/docs/zh](https://omc.junze.dev/docs/zh/)** 或直接阅读仓库文档（[`docs/zh/README.md`](docs/zh/README.md)）：

| 文档 | 内容 |
| --- | --- |
| [安装指南](docs/zh/install.md) · [Agent 安装规范](docs/zh/install-for-agents.md) | Docker Compose、独立接入 CPA、原生包、反代、升级与排障（[EN](docs/install.md)） |
| [配置与运维指南](docs/zh/operations.md) | 全量环境变量、安全约束、自动更新、Agent/MCP、模型目录与配额预热（[EN](docs/operations.md)） |
| [SQLite 运维与恢复手册](docs/zh/ops/sqlite-operations.md) | `.omcbackup` 与云端容灾备份、主密钥治理、WAL 与数据清理（[EN](docs/ops/sqlite-operations.md)） |
| [定价与费用核算](docs/zh/pricing.md) | 价格匹配优先级、阶梯计费规则、倍率与费用快照（[EN](docs/pricing.md)） |
| [智能体能力与 MCP 接入](docs/zh/agent-capabilities.md) | 能力注册表、只读 SQL、人工审批与 Streamable HTTP / stdio 桥接（[EN](docs/agent-capabilities.md)） |
| [CLIProxyAPI v8 契约](docs/zh/cpa-v8-compat.md) | v8 管理门禁、250ms 写合并、插件页面边界（[EN](docs/cpa-v8-compat.md)） |
| [API 接口参考](https://omc.junze.dev/api-reference/) | 交互式 Swagger 2.0 / OpenAPI 文档 |
| [开发者与贡献指南](CONTRIBUTING.md) | [系统架构](docs/dev/architecture.md) · [界面设计](docs/dev/design.md) · [测试规范](docs/dev/testing.md) · [发布流程](docs/dev/releasing.md) · [Demo 运维](docs/ops/cloudflare-demo.md) |

## 参与贡献

本地开发需要 Go 1.26+、Node.js 22+ 与 pnpm 11+：

```bash
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

提交前验证流程参见 [`CONTRIBUTING.md`](CONTRIBUTING.md)，安全漏洞请遵循 [`SECURITY.md`](SECURITY.md) 私下报告。

## 致谢与开源协议

Oh My CPA 基于 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 构建，感谢 [Linux.do 社区](https://linux.do)。项目采用 [MIT 开源协议](LICENSE)。
