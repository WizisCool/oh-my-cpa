# 安装

Oh My CPA（OMC）需配合 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（CPA）**v8.0.0 及以上版本**运行。控制台的登录密码即 CPA 的管理密钥。官方镜像为 Docker Hub 上的 **`wiziscool/oh-my-cpa`**，支持 `linux/amd64` 与 `linux/arm64`。按 CPA 当前的运行位置选择路径：

| 当前情况 | 指南 |
| --- | --- |
| 尚未部署 CPA | [快速开始](quickstart.md) |
| CPA 运行在宿主机、另一个 Docker 项目或其他机器上 | [独立部署](install/standalone.md) |
| CPA 使用 Docker Compose 部署，希望合并到同一个编排文件 | [并入现有编排文件](install/compose.md) |
| 不使用 Docker：macOS、Windows、Linux 或 FreeBSD（amd64/arm64） | [原生可执行文件](install/native.md) |
| 没有对应平台的发布包，或希望自行编译 | [从源码构建](install/source.md) |
| 已安装 OMC | [升级](install/upgrade.md) |

编码 Agent 也能按相同路径完成安装：把 [Agent 安装规范](install-for-agents.md)交给它即可。

<a id="release-compose-files"></a>

## 发布的 Compose 模板

Docker 路径需要安装了 Compose 插件的 Docker Engine，命令以包含 `curl` 与 `openssl` 的 Linux / macOS Shell 为准。每次发布都会在 `deploy/` 目录与 Release 附件中提供两份模板：

- **`compose.full.yml`**：CPA、OMC 与更新器（[快速开始](quickstart.md)）。
- **`compose.omc.yml`**：在现有 CPA 旁运行 OMC 与更新器（[独立部署](install/standalone.md)）。

两份模板都以非 root 用户 `10001:10001`、只读根文件系统、丢弃全部 Linux Capabilities 与 `no-new-privileges:true` 运行 OMC，把 SQLite 数据库放在命名卷 `oh-my-cpa-data` 中（无需 `mkdir` 或 `chown`），内置用于控制台一键更新的 `oh-my-cpa-updater`，并读取同目录 `.env` 中的覆盖项。

## 全新安装

逐步说明见[快速开始](quickstart.md)。

## 独立部署

见[独立部署](install/standalone.md)，其中包括如何让容器连上 CPA。

## 并入现有编排文件

见[并入现有编排文件](install/compose.md)。

## 原生可执行文件

见[原生可执行文件](install/native.md)。

## 从源码构建

见[从源码构建](install/source.md)。

## 安装验证与排障

见[排障](install/troubleshooting.md)。

## 升级

见[升级](install/upgrade.md)。
