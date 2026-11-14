# 中文文档索引

本目录存放与英文文档保持同步的简体中文用户与运维文档，供仓库阅读和 `https://omc.junze.dev/docs/zh/` 文档站单源构建使用。

| 文档 | 内容 |
| --- | --- |
| [`install.md`](install.md) | Docker Compose、原生可执行文件与源码安装、端口/存储设置、反向代理、升级与排障 |
| [`install-for-agents.md`](install-for-agents.md) | 供编码 Agent 执行的检查、授权与安装规范 |
| [`operations.md`](operations.md) | 环境变量全量参考、安全与运行约束、自动更新器、Agent/MCP、模型目录与配额预热 |
| [`ops/sqlite-operations.md`](ops/sqlite-operations.md) | SQLite WAL 备份、云端恢复、主密钥治理与数据库维护 |
| [`pricing.md`](pricing.md) | 模型价目表、阶梯计费规则与不可变费用快照 |
| [`agent-capabilities.md`](agent-capabilities.md) | 智能体能力注册表、只读 SQL、人工审批与 MCP 接入 |
| [`cpa-v8-compat.md`](cpa-v8-compat.md) | CLIProxyAPI v8 管理接口契约与配置写回边界 |

- 仓库英文原版文档位于 [`../README.md`](../README.md)（文档总览）。
- 面向贡献者的架构、设计系统、测试与发布流程文档（英文）位于 [`../dev/`](../dev/architecture.md)。
