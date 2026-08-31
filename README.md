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

环境要求：Go 1.24+、Node.js 22+、pnpm 9+。

```powershell
pnpm install --frozen-lockfile
pnpm --dir web type-check
pnpm --dir web build

go test ./...
go vet ./...
```

开发后端前，需要先构建前端；生产构建会把 `web/dist` 复制到 `internal/web/dist` 后嵌入 Go 二进制：

```powershell
pnpm --dir web build
Remove-Item internal/web/dist -Recurse -Force -ErrorAction SilentlyContinue
New-Item internal/web/dist -ItemType Directory -Force | Out-Null
Copy-Item web/dist/* internal/web/dist/ -Recurse

go run ./cmd/oh-my-cpa
```

最小环境变量：

```powershell
$env:OMCPA_MASTER_KEY = 'change-this-to-at-least-32-random-bytes'
$env:OMCPA_CPA_BASE_URL = 'http://127.0.0.1:8317'
$env:OMCPA_CPA_MANAGEMENT_KEY = 'your-cpa-management-key'
$env:OMCPA_SESSION_SECRET = 'at-least-32-random-bytes-for-sessions'
$env:OMCPA_ADMIN_PASSWORD = 'change-this-admin-password'
$env:OMCPA_PUBLIC_URL = 'http://127.0.0.1:8080/omc'
$env:OMCPA_BASE_PATH = '/omc'
```

打开 `http://127.0.0.1:8080/omc/`。

## Docker Compose

完整部署模板位于 [`deploy/compose.full.yml`](deploy/compose.full.yml)，包含 CPA、Oh My CPA 和 Caddy：

```powershell
$env:CPA_MANAGEMENT_KEY = 'your-cpa-management-key'
$env:OMCPA_MASTER_KEY = 'at-least-32-random-bytes-for-encryption'
$env:OMCPA_SESSION_SECRET = 'at-least-32-random-bytes-for-sessions'
$env:OMCPA_ADMIN_PASSWORD = 'change-this-admin-password'
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

Set both `OMCPA_SESSION_SECRET` (at least 32 bytes) and `OMCPA_ADMIN_PASSWORD` before starting. The session cookie is HttpOnly, SameSite=Strict, expires after 12 hours, and is marked Secure when `OMCPA_PUBLIC_URL` uses HTTPS.

## 安全边界

- 管理员密码和会话签名密钥只在 Go 后端使用；浏览器仅持有短期 HttpOnly 会话 cookie；
- CPA Management Key 只保存在 Go 后端并以 AES-GCM 密文落库；
- 资源响应不会包含 API Key、OAuth Token 或 Auth File 原文；
- 当前版本的 `api-call`、完整配置写回、OAuth 编排和用量订阅尚未开放；
- SQLite 部署必须保持单 Oh My CPA 副本；
- 不应把 CPA Management API 直接暴露到公网；
- `OMCPA_MASTER_KEY` 丢失后无法解密已保存的 CPA 密钥。

术语和领域模型见 [`CONTEXT.md`](CONTEXT.md)，架构决策见 [`docs/adr/0001-go-react-sqlite-modular-monolith.md`](docs/adr/0001-go-react-sqlite-modular-monolith.md)。
