# 面向 Agent 的安装规范

编码 Agent 执行安装时遵循与运维人员相同的[安装指南](install.md)，本文档补充 Agent 必须遵守的预检、授权、校验与交付规则（[英文原版](../install-for-agents.md)）。

## 动手前先检查

执行任何写入或启动动作前，先核实 CPA 与 OMC 是否已存在、启动方式、网络连通性、宿主系统与 CPU 架构、磁盘挂载情况及宿主机端口占用。可检查容器名、镜像引用、挂载卷、端口映射与网络元数据，**严禁在工具输出或对话中打印容器环境变量、`.env` 内容、管理密钥、主密钥、认证文件或 `docker compose config` 的明文结果**。仅针对无法安全自动确认的信息向用户提问。

若目标目录已有 Compose 文件，必须先读取其 `services.oh-my-cpa` 定义，不要想当然认为 `.env` 会自动生效：
- 官方 `compose.full.yml` 与 `compose.omc.yml` 支持读取 `OMCPA_BIND`、`OMCPA_DATA_PATH`、`OMCPA_USER`、`OMCPA_NETWORK_NAME`（及 `compose.omc.yml` 中的 `OMCPA_NETWORK_EXTERNAL`）。
- 早期或手写的 Compose 文件可能把 `"127.0.0.1:8080:8080"` 或 `oh-my-cpa-data:/data` 写死而忽略 `.env`。

禁止通过消费 CPA 用量队列的接口探测连通性。OMC 要求 CPA 提供 v8 管理接口与明文管理密钥。

## 保护现有环境

- 覆写目标目录下的现有文件（`compose.yml`、`config.yaml`、`.env`）前先确认；若已部署 OMC，必须按[升级流程](install.md#升级)处理，不得重新生成密钥覆盖。
- 缺失的密钥应由用户私下提供，不要用占位符伪装已配置。
- **绝不替换现有的 `OMCPA_MASTER_KEY`**。若已有加密数据但主密钥丢失，立即停手并说明恢复边界（见 [SQLite 运维与恢复手册](ops/sqlite-operations.md)）。
- 未经明确授权，不要修改、升级、重启或删除现有的 CPA 或其他管理面板，保持其配置、端口与 `auths` 目录完整。
- 不要擅自搬迁数据、把宿主机绑定挂载改为命名卷（或反向更改）、递归 `chown` 已有目录，或修改 `OMCPA_BASE_PATH`、网络与反向代理规则。替换早期 `../oh-my-cpa-data` 模板时需在 `.env` 中显式保留原路径。
- **禁止在 `oh-my-cpa` 运行期间直接复制正在使用的 SQLite WAL 目录**。
- 涉及提权（`sudo`）、安装系统工具、监听非回环网卡、授予 Docker Socket 权限（`oh-my-cpa-updater`）或发送会产生费用的模型推理请求前，必须先获得用户确认。

## 选择对应路径执行

| 现状 | 对应章节 |
| --- | --- |
| 尚未安装 CPA | [全新安装](install.md#全新安装) |
| 已有可从容器访问的 CPA（宿主机、另一 Docker 网络或远程主机） | [独立部署](install.md#独立部署) |
| 已有可编辑的 CPA Compose 文件且希望合并管理 | [并入现有编排文件](install.md#并入现有编排文件) |
| CPA 仅监听本机回环 `127.0.0.1:8317` 或无法使用 Docker | [原生可执行文件](install.md#原生可执行文件) |
| 用户明确要求源码编译，或无匹配的原生包 | [从源码构建](install.md#从源码构建) |
| 已有 OMC 部署 | [升级](install.md#升级) |

遵循以下核心配置规则：
- **更新器边界**：官方 Docker 方案默认包含 `oh-my-cpa-updater`。需向用户说明 `oh-my-cpa-updater` 会挂载 `/var/run/docker.sock`（即拥有宿主机 Docker 控制权），而主服务 `oh-my-cpa` 保持非 root（`10001:10001`）、只读且不挂载 Socket。若用户拒绝授予 Docker Socket 访问权限，可从 `compose.yml` 移除该服务（并清理已运行容器），改为手动更新。切勿把 Socket 权限直接赋予 `oh-my-cpa` 或以 root 运行主服务。
- **端口冲突**：Docker 桥接模式下若宿主机 `8080` 被占用，仅修改 `.env` 的 `OMCPA_BIND=127.0.0.1:<port>`，保持容器端口 `:8080` 不变；原生模式或自定义 `host` 网络容器则修改 `OMCPA_LISTEN_ADDR`。
- **存储权限**：新部署默认采用 `oh-my-cpa-data` 命名卷（配合默认 `10001:10001`）免去权限调整；仅当用户指定宿主机路径（`OMCPA_DATA_PATH`）时，再将 `OMCPA_USER` 对齐为宿主机 UID/GID 或调整空目录属主。

## 验证与交付

按[安装验证与排障](install.md#安装验证与排障)确认实际监听端口、`OMCPA_BASE_PATH`、`/api/healthz`（`"status":"ok"` 且 `"cpa_connected":true`）、CPA 连通性与用量采集状态。不要宣称导入了历史用量，也不要为填充图表擅自发起计费请求。

向用户汇报：控制台访问地址、部署目录与数据存放位置（命名卷名称或宿主机路径）、启停与更新方式以及遗留注意事项。提示用户使用原有 CPA 管理密钥登录（不要回显密钥内容），并附上[配置与运维指南](operations.md)和[SQLite 备份恢复手册](ops/sqlite-operations.md)链接。
