# 用量采集与界面性能审计

## 已确认根因

本机 CPA 的非消耗式协议检查返回 `AUTH +OK`，但 `PING` 返回 `unknown command`。
原自动模式把 PING 失败误判为 RESP 不可用，回退每秒 HTTP `/usage-queue?count=1000`，产生访问日志。
修复后探测只认证，不订阅、不弹出；真实 TCP 回归测试验证自动订阅且没有 HTTP/PING/LPOP 探测。

HTTP/RESP 拉取采用 1/2/4/8/10 秒空闲退避；有记录恢复基础间隔，满批立即排空。
不含请求耗时的 1 小时空队列调度：3600 次降至 363 次。真正订阅模式没有 HTTP 队列轮询。
握手、SUBSCRIBE 握手及批量 LPOP 受请求超时约束；单次请求超时不再永久停止采集。

## 可重复基准

Windows / AMD Ryzen 7 5800H，独立 SQLite 数据库，10 万事件和 10 万 inbox。
每组重复两次；数字是本机合成数据基准，不是生产延迟或 CPU 使用率承诺。

| 路径 | 修改前 | 修改后 |
| --- | --- | --- |
| 用量状态 | 39.28–39.55 ms | 13.67–14.64 ms |
| 实例历史时间边界 | 29.65–29.83 ms | 0.038–0.045 ms |
| 10 万事件窗口总计与分桶 | 270.59–315.80 ms | 167.62–171.71 ms |
| 100 配额卡 / 300 进度条倒计时 | 400 个定时器 | 1 个；隐藏时 0 个 |

另：管理客户端使用按 TLS 策略隔离的共享连接池，测试验证两次独立客户端请求复用一个 TCP 连接，管理凭据不串用。
SQL 将 MIN/MAX 改为独立索引端点查询，增加实例/时间复合索引，并由同一组 buckets 合计总量，避免扫描两遍窗口。
配额浏览器夹具保持 8170 个 DOM 节点，外观不变；本次只减少重复调度，不宣称解决了大列表 DOM 规模。

## 验证

- `go test ./...`、`go vet ./...`
- `go test -race ./internal/cpa/management ./internal/usage/... ./internal/repository`
- `go test ./internal/repository -run '^$' -bench 'BenchmarkUsage(Status|Span|EventWindow)' -benchmem -benchtime=20x -count=2`
- `pnpm type-check`、`pnpm test:visible-clock`、`pnpm check-i18n`、`pnpm lint:antd`、`pnpm build`
- `pnpm verify:performance`（隔离夹具，不使用真实 CPA 队列）
- `pnpm verify:events`；全站 `pnpm verify:browser` 的 113 个检查通过
- `pnpm verify:secrets:worktree`、`git diff --check`

环境 Node 24.16.0 与声明的 22.23.2 存在版本警告；Ant Design lint 报告 5 项现有弃用提示。

## 尚未落地

1. LobeIcon 命名空间动态索引阻止按需 tree-shaking：构建块约 5.60 MB，gzip 1.11 MB。
   后续应保留完整选图器能力，常用图标静态导入，其余图标延迟加载；不要直接砍掉图标目录。
2. Monaco/YAML 编辑器块约 2.96 MB，图表 vendor 约 1.47 MB；已按路由/编辑器拆分，仍值得冷启动 profiling。
3. 配额大列表仍全量渲染；100 卡已约 8170 个 DOM，进一步优化需分页或虚拟化并测试筛选与键盘操作。
4. 状态计数虽已减少开销，仍随 inbox 规模增长；若百万级生产 profiling 证明必要，再考虑事务维护计数器。

真实 CPA 仅执行了 AUTH/PING 诊断，未订阅、未弹出队列、未重启服务。
