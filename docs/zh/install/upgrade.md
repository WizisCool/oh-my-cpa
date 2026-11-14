# 升级

版本升级会自动执行只增不改（forward-only）的数据库迁移，不支持直接降级，回退必须依赖数据备份。每次迁移前 OMC 都会自动制作一份加密快照；手动与定时备份/恢复步骤详见 [SQLite 运维与恢复手册](../ops/sqlite-operations.md)。`.env` 文件需单独备份。


## 在控制台中一键更新

发现新版本时，**系统信息**页会在 Oh My CPA 或 CLIProxyAPI 旁显示**立即更新**。确认后 `oh-my-cpa-updater` 会依次：

1. 拉取新镜像（OMC 强制拉取经签名清单校验的不可变镜像摘要，CPA 拉取当前容器所用的镜像标签）；
2. 停止旧容器并沿用原环境变量、数据卷、端口、网络与 Compose 标签重建新容器；
3. 等待新容器健康检查通过后移除旧容器；若新容器异常退出或不健康，则清理新容器并重启旧容器完成自动回滚。

在以下三种情形中页面不提供自动更新按钮并给出说明：镜像固定了版本号或摘要（如 `wiziscool/oh-my-cpa:vX.Y.Z`）、CPA 未以同机容器方式运行、或从源码编译的构建未内置发布签名公钥。


## 手动升级

在 `compose.yml` 所在目录执行：

```bash
docker compose pull oh-my-cpa oh-my-cpa-updater
docker compose up -d --no-deps oh-my-cpa oh-my-cpa-updater
```

如未启用 `oh-my-cpa-updater`，从两条命令中去掉该服务名即可。若要切换至指定版本，可在 `.env` 中设置 `OMCPA_IMAGE=wiziscool/oh-my-cpa:vX.Y.Z`。

## 为已有部署启用控制台自动更新

如果旧版部署最初未包含 `oh-my-cpa-updater`，在 Docker 宿主机执行一条命令即可启用（无需修改 `compose.yml`）：

```bash
docker run --rm --pull always -u 0 -v /var/run/docker.sock:/var/run/docker.sock wiziscool/oh-my-cpa:latest updater install
```

该命令会自动定位正在运行的 OMC 与 CPA 容器（多实例时可用 `--container` / `--cpa-container` 指定），创建 `oh-my-cpa-updater` 容器并把当前 OMC 升级至最新版本。如需移除，运行 `docker rm -f oh-my-cpa-updater`。请注意 `oh-my-cpa-updater` 挂载了宿主机 Docker Socket，而主服务 `oh-my-cpa` 始终保持非 root（`10001:10001`）、只读与无 Socket 权限隔离（详见[更新](../operate/updates.md#控制台自动更新oh-my-cpa-updater)）。


## 现有部署升级兼容性说明

常规升级（在控制台点击**立即更新**，或沿用原有 `compose.yml` 与 `.env` 执行 `docker compose pull && docker compose up -d`）会完整保留原有数据挂载、用户权限、端口、网络与 `OMCPA_BASE_PATH`。

仅当你**用最新版模板替换了旧版 Compose 文件**时，需注意以下两项变更：

- **早期 `deploy/compose.*.yml` 宿主机挂载路径**：旧版子目录下的模板曾默认使用 `../oh-my-cpa-data` 与 `../cpa/...`；新版默认改为命名卷 `oh-my-cpa-data` 与 `./config.yaml` 等。替换模板前请在 `.env` 中显式固定旧路径：
  ```dotenv
  OMCPA_DATA_PATH=../oh-my-cpa-data
  # 全家桶模板还需保留：
  CPA_CONFIG_PATH=../cpa/config.yaml
  CPA_AUTH_PATH=../cpa/auths
  CPA_LOG_PATH=../cpa/logs
  CPA_PLUGIN_PATH=../cpa/plugins
  ```
- **早期默认 `/omc` 子路径部署**：旧部署如未显式配置 `OMCPA_BASE_PATH` 但反代仍期望 `/omc`，升级前请在 `.env` 补上 `OMCPA_BASE_PATH=/omc`。


原生可执行文件通过替换程序升级，见[升级原生安装](native.md#升级原生安装)。
