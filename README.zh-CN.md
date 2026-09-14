<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="web/src/assets/brand/omc-wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="web/src/assets/brand/omc-wordmark-light.svg">
  <img src="web/src/assets/brand/omc-wordmark-dark.svg" alt="Oh-My-CPA Logo" width="360">
</picture>

# Oh-My-CPA

### 面向 CLIProxyAPI 的 Web 管理控制台与用量观测中心

<br />

[![License](https://img.shields.io/badge/License-MIT-blue.svg?style=flat)](LICENSE)
[![Stars](https://img.shields.io/github/stars/WizisCool/oh-my-cpa?style=flat&label=stars)](https://github.com/WizisCool/oh-my-cpa/stargazers)
[![CI](https://github.com/WizisCool/oh-my-cpa/actions/workflows/ci.yml/badge.svg)](https://github.com/WizisCool/oh-my-cpa/actions/workflows/ci.yml)
[![Go](https://img.shields.io/badge/Go-1.24+-00ADD8?style=flat&logo=go&logoColor=white)](https://go.dev)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?style=flat&logo=sqlite&logoColor=white)](https://www.sqlite.org)

<br />

[English](README.md) · **简体中文**

</div>

---

> [!IMPORTANT]
> **Oh My CPA 处于活跃开发阶段。** 核心功能已可用于日常代理管理与用量观测，多实例支持、容器镜像与部分高级管理功能仍在持续完善中。

Oh My CPA 是面向 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) 的自托管控制面。本项目提供 Web 仪表盘、请求浏览器、凭据管理、模型定价与配置编辑，采用 Go 模块化单体架构，内嵌 React 前端产物，并使用本地 SQLite 存储，单二进制开箱即用，零外部 CDN 依赖。

## 功能特性

### 网关与 Provider 管理
- **AI 提供商管理**：配置与管理 Codex、Claude、Gemini、DeepSeek 及 OpenAI 兼容服务凭据与端点。
- **协议级启停控制**：通过 `excluded-models: ['*']` 实现网关协议层有效阻断，防止流量误路由至已停用凭据。
- **模型目录自动拉取**：直连上游提供商获取最新可用模型列表。
- **客户端 Key 别名管理**：创建、查看与删除代理客户端 API Key。支持为 Key 设置可读别名，别名自动呈现在请求记录、详情抽屉与筛选标签中。
- **OAuth 凭据文件治理**：上传、下载、删除与查看 OAuth 认证文件。编辑 priority 与 weight 字段，查看关联模型，并支持一键清除频率限制冷却。

### 用量观测与请求浏览器
- **用量趋势仪表盘**：按相对预设窗口（15m / 1h / 6h / 24h / 7d / 30d / 90d）或自定义日历区间展示请求量、Token 吞吐、缓存命中率与估算费用，并提供全年贡献图式 Token 热力图，按天展示 Token 用量，点击单元格可查看当天的请求记录。
- **多维分面请求浏览器**：按模型、Provider、客户端 Key 别名、状态、费用及延迟进行多选分面筛选与全文搜索。
- **单请求详情与延迟分析**：展示总耗时、首字生成延迟（TTFT）、分项 Token 计数，并支持下载单请求原始日志。
- **流式采集与后台拉取**：基于 RESP 订阅或 HTTP 轮询采集用量事件，队列空闲时自动指数退避。
- **实时日志流**：增量尾随网关运行日志，支持导出错误日志文件。

### 模型定价与成本核算
- **请求时价格快照**：每条请求在完成写入时通过不可变价格版本锁定费用（ADR 0003），后续调整单价绝不篡改历史成本数据。
- **models.dev 定价同步**：自动从 `models.dev` 同步官方价格目录，采用确定性候选链排序匹配模型。
- **本地行级定价覆盖**：支持手动自定义输入、输出、缓存读取与缓存写入费率。

### 配置编辑与系统安全
- **双模式配置编辑**：提供结构化表单配置面板与内嵌 Monaco YAML 源码编辑器（保留原始注释与未知字段，本地加载零 CDN）。
- **插件管理**：支持从插件市场浏览、安装、配置与卸载扩展插件。
- **静态加密存储**：CPA 管理密钥与原始用量消息在 SQLite 中采用 AES-GCM 加密存储。
- **安全审计日志**：下载认证文件、导出请求日志、查看或修改 YAML 源码等敏感操作强制写入追加式审计日志。
- **完全离线运行**：前端产物完整内嵌进 Go 二进制，生产环境无需 Node.js 运行时或外部网络 CDN。

## 架构一览

```text
浏览器 ──▶ 反向代理 (Caddy / Nginx) ──▶ Oh My CPA (:8080)
                                           ├─ 内嵌 React SPA (/omc/)
                                           ├─ 本地 SQLite WAL (/data)
                                           └─ 采集循环 ──▶ CLIProxyAPI (:8317)
```

- **单二进制运行**：React SPA 构建产物直接内嵌进 Go 可执行文件（`internal/web/dist`）。
- **单副本持久化**：采用 SQLite WAL 模式，固定单连接池，数据目录仅允许单一实例挂载写入。
- **子路径原生支持**：默认挂载于 `/omc`（可通过 `OMCPA_BASE_PATH` 自定义）。

## 快速上手

### 前置条件

- 已启动的 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 实例及其明文管理密钥（`remote-management.secret-key`）
- Go 1.24+（构建工具链锁定 `1.24.13`）
- Node.js 22+ & pnpm 11+

### 从源码运行

1. **克隆仓库并安装依赖**：
   ```bash
   git clone https://github.com/WizisCool/oh-my-cpa.git
   cd oh-my-cpa
   pnpm install --frozen-lockfile
   ```

2. **配置环境变量**：
   ```bash
   cp .env.example .env
   ```
   编辑 `.env`，设置 `OMCPA_MASTER_KEY`（32 字节十六进制随机密钥，如 `openssl rand -hex 32`）与 `OMCPA_CPA_MANAGEMENT_KEY`（CPA 密钥明文）。若 CPA 运行在另一台主机，请同时修改 `OMCPA_CPA_BASE_URL` 与 `OMCPA_CPA_USAGE_ADDR`。

3. **构建前端并启动**：
   ```bash
   pnpm build
   go run ./cmd/oh-my-cpa
   ```

4. **访问控制台**：
   在浏览器中打开 **`http://127.0.0.1:8080/omc/`**，输入 CPA 管理密钥即可登录。

<details>
<summary><strong>开发模式（热重载）</strong></summary>

<br />

安装 [Air](https://github.com/air-verse/air) 实现 Go 热重载：
```bash
go install github.com/air-verse/air@latest
pnpm dev
```
打开 **`http://127.0.0.1:5173/omc/`**。Vite 提供前端 HMR 并将 `/omc/api/*` 请求代理至 Go 后端（`:8080`）。

</details>

## 部署说明

### Docker（筹备中）

> 容器镜像打包与自动化发布（`ghcr.io` / Docker Hub）目前正在筹备中。
>
> 现阶段推荐通过源码或编译后的二进制运行。仓库中提供了早期预览 Compose 模板：
> - [`deploy/compose.full.yml`](deploy/compose.full.yml)：协同部署 CPA、Oh My CPA 与 Caddy 的完整栈。
> - [`deploy/compose.omc.yml`](deploy/compose.omc.yml)：连接已有 CPA 实例的独立 Oh My CPA 容器。

## 运维须知

- **单采集器约束**：CPA 用量队列为破坏性消费，同一 CPA 实例只能有一个采集器读取。若已有外部服务采集用量，请设为 `OMCPA_USAGE_INGEST_MODE=off`。
- **单副本约束**：SQLite WAL 要求独占写入，仅允许单一实例挂载数据目录，严禁挂载于 NFS/CIFS 等网络分布式文件系统上并发运行。
- **主密钥备份**：`OMCPA_MASTER_KEY` 用于解密已存储的凭据与用量载荷。请务必离线安全备份；若遗失，数据库加密内容将永久不可恢复。
- **网络安全边界**：切勿将 CPA 管理端口暴露到公网。保持 CPA 在内网或本地回环中运行，并通过 HTTPS 反向代理访问 Oh My CPA。

## 开发者常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动 Air + Vite 本地开发环境 |
| `pnpm build` | 构建前端 SPA 并同步到 `internal/web/dist` |
| `pnpm test:fast` | 根据当前工作树改动快速运行受影响测试 |
| `pnpm check:ui` | 基于 Vite 开发服务器与 mock API 的界面场景快测 |
| `pnpm verify` | 静态门禁：工具链检查、静态代码分析与密钥扫描 |
| `pnpm verify:full` | 全量发布门禁：构建、Bundle 预算、浏览器端到端验收与几何探针 |

## 贡献与安全

- **参与贡献**：请参阅 [`CONTRIBUTING.md`](CONTRIBUTING.md) 了解本地开发环境搭建、分层验证门禁与代码规范。
- **安全政策**：关于安全漏洞披露流程与系统安全边界，请参阅 [`SECURITY.md`](SECURITY.md)。

## 文档索引

- [`CONTEXT.md`](CONTEXT.md) — 核心领域术语、时间窗口与价格快照规则
- [`docs/architecture.md`](docs/architecture.md) — 模块架构图、数据流与系统不变量
- [`docs/design.md`](docs/design.md) — 视觉设计系统与主题 Token
- [`docs/ops/sqlite-operations.md`](docs/ops/sqlite-operations.md) — SQLite 运维、备份演练与恢复手册
- [`docs/cpamc-parity.md`](docs/cpamc-parity.md) — 与官方 CPAMC 的功能对位矩阵
- [`AGENTS.md`](AGENTS.md) — 开发者与 AI Agent 协作契约与文档同步规范

## 开源协议

本项目采用 [MIT License](LICENSE)。
