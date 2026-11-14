# 智能体能力与 MCP 接入

OMC 内置的 `/agent` 对话工作区与外部 MCP 客户端共用同一套声明式能力注册表与执行器（[英文原版](../agent-capabilities.md)）。

```text
内置 Agent 模型循环 ──┐
                     ├─ 能力执行器（校验 / 鉴权 / 预处理 / 审批 / 审计）→ 共享业务操作 → 数据库 / CPA
外部 MCP 适配器 ───────┘
```

## 权限与安全边界

接入 Agent/MCP 的每个能力均经过显式安全声明与边界控制：

- **严禁暴露高危面**：不提供原始密钥明文读取、认证文件下载、任意外部 HTTP/CPA 透传、文件系统/Shell 执行、宿主机数据库维护或 Docker 容器更新接口；也不开放整份 YAML 配置文件覆盖与插件安装权限。
- **敏感录入私有交接（Human-in-the-loop）**：需要提供密码、API Key 等机密参数或发起 OAuth 登录的变更，模型仅能准备非机密参数并生成待审批预览；管理员需在已登录的控制台或独立的 `<控制台 URL>/authorize/<id>` 审批页亲手输入密钥或完成授权，模型与外部 Agent 永远接触不到机密字段。
- **预审批绑定防篡改**：审批单绑定规范化参数、发起身份、适配器类型、声明版本号与配置基线修订号；审批通过后不可替换参数，且写入审计日志失败会直接阻止执行（fail-closed）。
- **只读 SQL 隔离（仅限内置 Agent）**：`database_schema` 与 `database_query` 仅对控制台内置 Agent 开放，外部 MCP 不可调用。查询在独立只读连接上运行，经 SQLite 编译字节码检查确保仅含单条受控 `SELECT`/`WITH` 查询，按白名单表分类访问并从列级别脱敏受保护字段（禁止查询覆盖脱敏列的索引）；查询原始结果仅留在服务端模型上下文中供分析或映射至前端 `data_rows` 展示，不暴露在普通会话列表 DTO 中。

## 配额窗口容量与可视化

控制台、内置 Agent 与 MCP 共用同一套订阅配额与窗口容量投影（如 `quota_list`、`quota_refresh`、`quota_get_capacity`）。当窗口已有足够计价请求样本时，按已记录流量与上游已用比例线性推算 100% 满窗容量（`basis: "current_window"`）；若新窗口刚重置尚未产生流量，则沿用同一方案上一完整周期的容量基准（`basis: "previous_window"`）。

内置 Agent 还支持通过 `present_openui` 渲染结构化交互界面，或通过 `present_html` 在隔离的沙盒 iframe 中按需绘制图表与单页文档（沙盒采用不透明源且禁止外联加载资源）。

## 接入外部 MCP 客户端

OMC 提供两种接入方式，暴露完全一致的能力目录与人工审批流：

1. **Streamable HTTP（推荐，无需本地安装进程）**：
   - 地址：`<控制台 URL>/api/mcp`（含 `OMCPA_BASE_PATH`，例如 `https://omc.example.com/api/mcp`）；
   - 鉴权：请求头携带 `Authorization: Bearer <CPA 管理密钥>`（拒绝浏览器会话 Cookie，演示模式下禁用）；
   - 在控制台 `/agent` 页顶部点击 **连接（Connect）** 即可复制包含当前实例地址的现成客户端配置片段。
2. **stdio 桥接（`oh-my-cpa mcp`）**：
   - 适用于仅支持标准输入输出 MCP 传输的客户端；
   - 环境变量：`OMCPA_SERVER_URL`（控制台完整地址）与 `OMCPA_CPA_MANAGEMENT_KEY`；
   - 安全策略：不直接打开本地数据库文件，非回环地址强制要求 HTTPS 且拒绝 HTTP 重定向。
