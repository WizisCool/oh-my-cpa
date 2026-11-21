# 更新

控制台会在 Oh My CPA 或网关发布新版本时提醒你；在带有更新器的容器部署中，还能替你完成更新。操作步骤见[升级](../install/upgrade.md)，本页说明检查与更新器的工作方式。

## 更新检查机制

“系统信息”页定时向 `api.github.com` 查询 OMC 与 CPA 最新稳定版信息（遵循 OMC 出站网络策略），每款产品默认享有 15 分钟请求节流保护以避免耗尽 GitHub API 匿名配额（每小时 60 次；可在 **OMC 设置 → GitHub 令牌** 直接配置、测试配额或清除，也可在配置面板或 `config.yaml` 中写入 `server.github-token`，OMC 与 CPA 共用该令牌并将配额提升至 5,000 次且不返回明文）。发现新版本时左侧导航栏会亮起提示圆点，也支持单版本忽略。OMC/CPA 版本检查与插件商店更新检查可在 **OMC 设置 → 自动刷新与更新** 各自独立调整周期或关闭。

关闭后台与开屏请求可分别设置 `OMCPA_UPDATE_CHECK_ENABLED=false` 与 `OMCPA_UPDATE_CHECK_ON_PAGE_LOAD=false`（手动点击**检查更新**仍可触发）。

## 控制台自动更新（`oh-my-cpa-updater`）

更新器使用同一镜像以 `oh-my-cpa updater serve` 模式运行在 Docker 内网 `:8090`，不对外发布端口，配置项见[更新器](../reference/environment.md#更新器)。

安全与网络机制要点：
- **最小职责隔离**：主服务 `oh-my-cpa` 无 Socket 权限、只读且非 root；更新器仅响应两类已鉴权请求（查状态、按产品名升级），校验来自 `OMCPA_MASTER_KEY` 派生的 HMAC Token，不接受外部传入任意镜像名或命令，也不会升级已被版本标签或摘要固定（pin）的容器。
- **签名与防回滚**：OMC 自身更新严格校验证书公钥与 GitHub Release 的 `release-manifest.json.sig` Ed25519 签名后按摘要拉取；新容器健康检查失败时先停止并移除失败容器，再恢复旧容器并重绑关联网络命名空间依赖容器。若残留的 `<name>-omc-previous` 已停止、当前目标容器健康且清理不涉及更新器自身命名空间切换，更新器会在升级前自动清理该历史备份。
- **统一出站代理策略**：在 **OMC 设置 → 网络代理** 中切换系统环境、直连或显式代理后，OMC 的外部请求（版本检查、价格同步、汇率、字体与测活）、CPA 全局 `requests.proxy-url` 及更新器流式拉取镜像都会遵循该路由（支持在控制台、CPA 与更新器容器均支持对应路由时协同生效；配置明文密码与密钥仍全程加密存储）。
