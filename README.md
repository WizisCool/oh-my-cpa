# Oh My CPA

> Make CPA yours.

Oh My CPA 是面向 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的 AI 资源身份与整理中心。

当多个 GPT Plus、OpenCode Go、Command Code GOAT 和中转站被 CPA 统一归入 `Codex` 等技术驱动时，Oh My CPA 在其之上保存用户自己的名称、图标、来源和整理状态。CPA 负责协议适配和请求执行，Oh My CPA 负责业务身份与管理。

## 当前状态

当前版本实现了第一个垂直切片：

- Go 模块化单体后端；
- React + TypeScript + Ant Design 前端；
- SQLite WAL 持久化；
- CPA Management API 资源发现；
- 未认领资源列表；
- 自定义名称、颜色、内置图标和备注；
- `auth-files`、`codex-api-key`、`openai-compatibility` 发现；
- `/omc` 子路径原生支持；
- CPA Management Key 通过 AES-GCM 加密保存，浏览器不会接触该密钥；
- Caddy/Nginx 与 CPA 同栈部署模板。

## 本地开发

环境要求：Go 1.24+、Node.js 22+、pnpm 11。Go 热重载还需安装 [Air](https://github.com/air-verse/air)：

```bash
go install github.com/air-verse/air@latest
pnpm install --frozen-lockfile
```

复制环境变量模板并填写主密钥和 CPA Management Key：

```bash
cp .env.example .env
pnpm dev
```

日常开发只使用一个浏览器入口：**`http://127.0.0.1:5173/omc/`**。

```text
浏览器 → Vite :5173 → Go API :8080 → CLIProxyAPI :8317
```

Vite 负责前端 HMR，并把 `/omc/api/*` 单向代理到 Go；Go 由 Air 监听 `.go`/`.sql` 文件并自动重建。CLIProxyAPI 是可选的外部依赖，未启动时 Oh My CPA 仍可运行并显示降级状态。

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动 Air + Vite，默认开发方式 |
| `pnpm dev:api` | 仅启动 Go/Air，供 API 调试 |
| `pnpm dev:web` | 仅启动 Vite，连接已有的 `:8080` 后端 |
| `pnpm cpa:start` | 从 `cpa/` 启动本地 CLIProxyAPI |
| `pnpm build` | 构建前端并同步到 `internal/web/dist` |
| `pnpm type-check` | 检查前端 TypeScript |
| `pnpm verify:browser` | 对运行中的嵌入式生产构建执行浏览器验收 |

`pnpm cpa:start` 默认寻找 `cpa/cli-proxy-api`（Windows 下也支持 `.exe`）和 `cpa/config.yaml`；可分别用 `CPA_BIN`、`CPA_CONFIG` 覆盖。Air 可通过 `AIR_BIN` 指定，脚本也会从 `PATH`、`GOBIN` 和 `GOPATH/bin` 查找。

生产式本地运行需要先构建嵌入资源：

```bash
pnpm build
go run ./cmd/oh-my-cpa
# 打开 http://127.0.0.1:8080/omc/
```

如只需同步已经生成的前端产物，可运行 `pnpm sync-web-dist`。

## Docker Compose

完整部署模板位于 [`deploy/compose.full.yml`](deploy/compose.full.yml)，包含 CPA、Oh My CPA 和 Caddy：

```powershell
$env:CPA_MANAGEMENT_KEY = 'your-cpa-management-key'
$env:OMCPA_MASTER_KEY = 'at-least-32-random-bytes-for-encryption'
$env:OMCPA_PUBLIC_URL = 'https://xxxx.com/omc'
$env:DOMAIN = 'xxxx.com'
docker compose -f deploy/compose.full.yml up -d --build
```

路由约定：

```text
https://xxxx.com/       → CPA
https://xxxx.com/omc/   → Oh My CPA
```

Caddy 配置会保留 `/omc` 前缀，不使用 `handle_path`。Oh My CPA 通过 Compose 内部网络直接访问 `http://cpa:8317`；RESP 用量采集也应直接使用 `cpa:8317`，不经过公网反向代理。

已有 CPA 时使用 [`deploy/compose.omc.yml`](deploy/compose.omc.yml)，并通过外部反向代理将 `/omc/*` 转发到 Oh My CPA 容器。

## 本地联调（真实 CLIProxyAPI）

仓库不提交 CPA 二进制、配置或凭据。将 CLIProxyAPI 解压到已忽略的 `cpa/` 目录，保留自己的 `config.yaml`、认证目录和 API Keys，然后分别启动依赖和应用：

```bash
pnpm cpa:start
pnpm dev
```

`.env` 由 Go 进程启动时读取，已存在的真实环境变量优先。登录密码就是 `OMCPA_CPA_MANAGEMENT_KEY`，即 CPA `remote-management.secret-key` 的明文。

浏览器验收默认检查 `http://127.0.0.1:8080/omc/` 的嵌入式生产构建，因此需先运行 `pnpm build` 并启动 Go 服务；也可用 `OMCPA_URL=http://127.0.0.1:5173/omc/` 检查当前 Vite 开发入口：

```bash
pnpm verify:browser
OMCPA_URL=http://127.0.0.1:5173/omc/ pnpm verify:browser
# 可选：验证上传、开关、删除等会修改真实 CPA 的路径
OMCPA_WRITE_TEST=1 pnpm verify:browser
```

界面语言选择持久化于 `localStorage('omc-lang')`；品牌样式与主题 Token 的权威定义见 [`docs/design.md`](docs/design.md)。Air 监听规则见 [`.air.toml`](.air.toml)。请勿提交 `cpa/`、`.env` 或真实凭据。

## API

`/omc/api/v1/*` requires an administrator session cookie. The login/session endpoints are:

```text
GET  /omc/api/healthz
POST /omc/api/auth/login     {"password":"..."}
GET  /omc/api/auth/session
POST /omc/api/auth/logout
POST /omc/api/v1/instances/default/discover
GET  /omc/api/v1/resources?status=unclaimed
PATCH /omc/api/v1/resources/{id}/override
```

Login sends the CPA management key (`{"password":"<management-key>"}` at `POST /omc/api/auth/login`); there is no separate Oh My CPA admin password. The session cookie is HttpOnly, SameSite=Strict, expires after 12 hours, and is marked Secure when `OMCPA_PUBLIC_URL` uses HTTPS. The cookie signing secret is derived from the management key, so rotating the key invalidates all sessions.

## 安全边界

- 登录凭据就是 CPA Management Key，不存在第二个管理密码；密钥仅在 Go 后端校验并派生会话签名，浏览器仅持有短期 SameSite=Strict 的 HttpOnly 会话 cookie；
- CPA Management Key 与原始 usage inbox 消息在 SQLite 中采用 AES-GCM 加密存储，主密钥由 `OMCPA_MASTER_KEY` 提供；
- 日常与普通 API 响应（`/resources`、`/management/auth-files`、`/management/config`、`/usage/events`、`/management/dashboard`、`/healthz`）采用严格 DTO allowlist 与字段脱敏，不暴露 API Key、OAuth Token、Account、原始 Auth File 内容或带凭据的 URL；
- 原始 Auth File 下载、原始配置 YAML 查看与编辑、request-log 下载属于显式高意图管理员受限操作，必须具备有效会话与同源校验，响应头标记 `Cache-Control: no-store`，并写入追加写入的 `audit_events` 审计日志；审计写失败时系统 fail-closed，阻止敏感数据导出与破坏性变更；
- 数据库升级至 004 时执行不可逆脱敏与历史数据清理，迁移前自动执行可用磁盘空间检查、AES-GCM 加密备份、SHA-256 校验和及还原 smoke 验证，并按策略保留最近备份；
- 当前版本的 `api-call`、完整配置写回、OAuth 编排和用量订阅尚未开放；
- SQLite 部署必须保持单 Oh My CPA 副本；
- 不应把 CPA Management API 直接暴露到公网；
- `OMCPA_MASTER_KEY` 丢失后无法解密已保存的密文。

术语和领域模型见 [`CONTEXT.md`](CONTEXT.md)，架构决策见 [`docs/adr/0001-go-react-sqlite-modular-monolith.md`](docs/adr/0001-go-react-sqlite-modular-monolith.md)。
