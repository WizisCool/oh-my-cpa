# 原生可执行文件

[GitHub Releases](https://github.com/WizisCool/oh-my-cpa/releases) 为 Darwin（macOS）、Windows、Linux 与 FreeBSD 提供 **amd64** 与 **arm64** 预编译包（Unix 为 `.tar.gz`，Windows 为 `.zip`）。可执行文件已内嵌前端控制台与 IANA 时区库，无需安装 Node、Go 或 Docker，HTTPS 使用系统证书库；CPA 仍需独立安装（v8.0.0+）。Darwin 与 Windows 二进制未签名，请务必先核对 SHA-256 校验和。

以 Linux amd64 为例：

```bash
VERSION=MAJOR.MINOR.PATCH
OS=linux
ARCH=amd64
ASSET="oh-my-cpa_${VERSION}_${OS}_${ARCH}.tar.gz"
mkdir -p oh-my-cpa && cd oh-my-cpa &&
curl -fLO "https://github.com/WizisCool/oh-my-cpa/releases/download/v${VERSION}/${ASSET}" &&
curl -fLO "https://github.com/WizisCool/oh-my-cpa/releases/download/v${VERSION}/checksums.txt" &&
grep -F "  $ASSET" checksums.txt | sha256sum -c - &&
tar -xzf "$ASSET" &&
cp -n .env.example .env &&
chmod 600 .env
```

Windows 可从同一发布页下载 `.zip` 与 `checksums.txt`，用 PowerShell `Get-FileHash -Algorithm SHA256` 比对后执行 `Expand-Archive`，复制 `.env.example` 为 `.env` 并用文件系统 ACL 限制目录与 `.env` 访问权限。

编辑 `.env` 设置 `OMCPA_MASTER_KEY`（64 位十六进制随机串）、`OMCPA_CPA_BASE_URL`、`OMCPA_CPA_MANAGEMENT_KEY` 与一致的 `TZ`；保持 `OMCPA_VERSION` 留空以保留构建内嵌版本号。模板默认监听 `127.0.0.1:8080` 并把 SQLite 存在工作目录下的 `./data`。然后运行 `./oh-my-cpa`（Windows 为 `.\oh-my-cpa.exe`），验证[安装与连通性](troubleshooting.md) 后打开 `http://127.0.0.1:8080/`。

原生部署升级步骤：先停止 `oh-my-cpa` 进程，备份 `.env` 与数据目录，校验并解压新版本包后替换可执行文件，保持原工作目录、`.env` 与数据目录不变再次启动。

## 作为服务运行

请使用专用运行账号托管进程、保持其工作目录不变，并用 Unix 权限或 Windows ACL 收紧 `.env` 与数据目录的访问。原生安装不要求容器使用的 `10001:10001` 用户。保持 `OMCPA_VERSION` 为空，以显示可执行文件内嵌的发布版本号。

## 升级原生安装

单独停止 OMC，备份 `.env` 与数据目录，另行校验并解压新版压缩包，只替换可执行文件后在原工作目录启动。保留主密钥与数据，确认健康状态与新版本号。迁移只能向前：回到旧版可执行文件需要恢复对应的数据备份。
