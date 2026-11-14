# 快速开始

用 Docker Compose 在一台机器上同时运行 CLIProxyAPI（CPA）、Oh My CPA 与控制台更新器，约三分钟、四条命令。已经在运行 CPA？请改用[独立部署](install/standalone.md)，现有网关保持原样。

## 准备

- 安装了 Compose 插件的 Docker Engine，运行在 Linux 或 macOS 上（Windows 可使用 WSL）。
- Shell 中可用 `curl` 与 `openssl`。
- 本机 `127.0.0.1` 上的 `8080`（控制台）与 `8317`（网关）端口空闲；如被占用，见[修改端口](operate/ports-storage.md#修改端口)。

## 1. 下载编排文件

```bash
mkdir -p oh-my-cpa && cd oh-my-cpa
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/compose.full.yml -o compose.yml
curl -fsSL https://github.com/WizisCool/oh-my-cpa/releases/latest/download/cpa.config.example.yaml -o config.yaml
```

`config.yaml` 是 CPA 的初始配置，必须在首次启动前存在：缺失的挂载文件会被 Docker 创建成目录。它已开启 OMC 所需的远程管理与用量统计，不含任何客户端密钥。

## 2. 生成两把密钥

```bash
test ! -e .env || { echo ".env 已存在，请勿覆盖以免丢失 OMCPA_MASTER_KEY" >&2; exit 1; }
cat > .env <<EOF
CPA_MANAGEMENT_KEY=$(openssl rand -hex 24)
OMCPA_MASTER_KEY=$(openssl rand -hex 32)
EOF
chmod 600 .env
```

`CPA_MANAGEMENT_KEY` 是 CPA 的管理密钥，也是控制台的登录密码。`OMCPA_MASTER_KEY` 加密 OMC 的数据库：请立即备份 `.env` 且不要覆盖已有文件，丢失原主密钥将无法读取已存数据。

## 3. 启动

```bash
docker compose up -d
```

## 4. 登录

打开 **`http://127.0.0.1:8080/`**，使用 `.env` 中的 `CPA_MANAGEMENT_KEY` 登录。确认控制台已连上网关：

```bash
curl -fsS http://127.0.0.1:8080/api/healthz
```

正常时返回 `"status":"ok"` 与 `"cpa_connected":true`，其他情况见[排障](install/troubleshooting.md)。

## 现在你拥有

新的 CPA 还没有提供商和客户端密钥。在控制台中添加两者（AI 提供商或 OAuth 管理，再到密钥管理），然后让客户端请求 `http://127.0.0.1:8317` 上的 CPA。之后每个请求都会连同延迟、Token 与费用出现在控制台中。

目录中包含：

- `compose.yml` 与 `.env`：编排文件与密钥。
- `config.yaml`、`auths/`、`logs/` 与 `plugins/`：CPA 的文件，后三个目录由 Docker 在首次启动时创建。
- OMC 的数据库，位于 Docker 命名卷 `oh-my-cpa-data`。如需改存宿主机目录，见[存储与目录权限](operate/ports-storage.md#存储与目录权限)。

`oh-my-cpa-updater` 负责执行从控制台发起的更新，是唯一挂载 Docker Socket 的容器；如需手动更新，可从 `compose.yml` 删除该服务（已启动时再执行 `docker rm -f oh-my-cpa-updater`）。

## 下一步

- 从其他机器或通过 HTTPS 访问：[远程访问](install/remote-access.md)。
- 保持最新：[升级](install/upgrade.md)。
- 保护数据：[备份与恢复](ops/sqlite-operations.md)。
- 调整配置：[环境变量](reference/environment.md)。
