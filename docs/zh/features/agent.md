# Agent 与 MCP

内置 Agent 以对话方式操作控制台：读取用量、解释费用，并准备由你批准的变更。外部编码 Agent 可通过 MCP 使用同一套能力。

## 对话

内置 `/agent` 工作区将对话与授权能力结果发送给用户选择的 CPA 模型：单条消息支持最多 4 张 ≤5 MiB 图片（PNG/JPEG/WebP）与 4 个文本附件（合计 ≤40 KiB），任务在服务端持久运行且支持断线续接重连，可通过停止按钮中断或新建会话释放附件与上下文。

## 接入外部 Agent

外部编码 Agent 可以通过以下两种方式接入同一套能力注册表（详见 [Agent 能力与 MCP 指南](../agent-capabilities.md)）：

| 传输方式 | 连接地址 | 凭据 |
| --- | --- | --- |
| Streamable HTTP（控制台直接提供，远程接入必须使用 HTTPS） | `<控制台 URL>/api/mcp`，如 `https://omc.example.com/api/mcp` | `Authorization: Bearer <CPA 管理密钥>` |
| stdio 桥接（`oh-my-cpa mcp`） | 环境变量 `OMCPA_SERVER_URL` | 环境变量 `OMCPA_CPA_MANAGEMENT_KEY` |

远程通过 Streamable HTTP 接入时必须在控制台前配置反向代理或控制台自身终止 TLS 并全程使用 **HTTPS**，避免管理密钥在网络上明文传输。

## 审批

MCP 的人工审批门槛仅约束通过 MCP 发起的状态变更操作；由于 CPA 管理密钥同时也是控制台管理员登录凭据，持有该密钥的 Agent 等同具备管理员权限（可直接用于登录控制台，绕过 MCP 审批流），请仅向受信任的 Agent 提供管理密钥。

在 MCP 流程内，外部 Agent 提交涉及状态变更的高风险操作时不会直接执行，而是生成 `pending` 审批单，结果中的 `approval_url` 即 `<控制台 URL>/authorize/<id>` 链接（Streamable HTTP 下设置了 `OMCPA_PUBLIC_URL` 时使用该地址；stdio 桥接使用 `OMCPA_SERVER_URL`，该地址需能在操作员浏览器中打开），Agent 会把它交给操作员点击，由已登录管理员在浏览器完成确认、密码/密钥录入或 OAuth 登录授权后才执行。只读 SQL 查询工具仅对内置 Agent 开放。
