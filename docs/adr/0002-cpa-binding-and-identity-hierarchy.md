# 0002. CPA Binding 与资源身份层级策略 (CPA Binding and Identity Hierarchy)

- **状态**：Accepted
- **日期**：2026-09-04
- **适用范围**：发现模型 (Discovery)、实体映射 (Domain Entities)、用量归属 (Usage Attribution)、数据库迁移

---

## 1. 背景与问题

Oh My CPA 是构建在 CLIProxyAPI (CPA) 之上的用户管理与业务身份层：
- CPA 负责底层的凭据轮询、出站代理与执行平面协议转换；
- Oh My CPA 负责发现 CPA 运行资源、赋予业务语义（Source、Connection、名称、图标、用途分类）并聚合统计用量。

在现有实现中，存在以下关键问题：
1. **身份易碎性与数组位置依赖**：对于缺乏稳定 `auth_index` 的配置项（例如部分 Codex API Key 或 OpenAI Compatibility 提供商），历史代码曾将配置数组下标注入标识，导致用户调整上游配置顺序时，名称与个性化配置发生错位串号；
2. **凭据秘密不可作为明文标识**：根据阶段 1 P0 秘密治理原则，明文 API Key、OAuth Token 或包含用户凭据的代理 URL 严禁进入主键、数据库外键、普通日志或日常浏览器响应；
3. **CPA 运行时索引的多义性**：同一 `auth_index` 可能在不同的技术资源族（Resource Family）中重名，直接跨族匹配会导致多对多扇出与事件重复；
4. **历史用量归属连续性**：当上游凭据轮换（Rotation）或上游条目被临时移除（变为 Missing）时，历史发生的用量事实必须永久保留其归属语义，不可因关联记录不存在而丢失或级联删除。

---

## 2. 决策

### 2.1 实体模型边界

基于 `CONTEXT.md`，明确领域实体的分层关系：

```text
Source (提供商业务源，如 DeepSeek、OpenAI、Command Code GOAT)
  └─ Connection (用户可调用的业务线路，持有名称、图标、颜色、状态与备注)
       ├─ Credential Metadata (凭据元数据描述，不存明文秘密)
       ├─ Endpoint (网络目标 URL，去敏除 userinfo)
       └─ CPA Binding (与具体 CPA 实例的物理绑定映射)
            ├─ Instance ID (所属 CPA 实例)
            ├─ Resource Family / Type (如 codex-api-key, auth-file, openai-compatibility)
            ├─ Auth Index (CPA 运行时稳定凭据索引，若有)
            └─ Binding Fingerprint (不可逆安全指纹)
```

### 2.2 发现身份解析层级 (Discovery Identity Hierarchy)

当发现引擎对 CPA 实例执行资源扫描时，严格按以下五级优先级决策唯一 Resource Key 与 Binding Fingerprint，严禁使用数组物理位置：

1. **第 1 级：经验证稳定的 CPA 不可变 ID (Immutable Upstream ID)**：
   - 上游明确提供全局稳定唯一 ID 时优先采用。
2. **第 2 级：分族作用域的稳定认证索引 (Family-Scoped Auth Index)**：
   - 格式：`auth-index:<family>:<auth_index>`；
   - 隔离不同 Resource Family 之间的同名索引。
3. **第 3 级：规范化凭据材料的加盐 Keyed HMAC (Versioned Keyed HMAC)**：
   - 当缺乏 `auth_index` 且存在非空客户端 API Key 时；
   - 由服务端主密钥 `OMCPA_MASTER_KEY` 计算 `hmac:v1:<family>:<sha256-hmac>`；
   - 绝不保存明文，防范离线彩虹表探测。
4. **第 4 级：唯一的非敏感元数据组合 (Non-Sensitive Metadata Fingerprint)**：
   - 基于规整后的 `(family, base_url, prefix, provider_name)` 派生不可逆指纹；
   - URL 强制去除 userinfo 鉴权信息、query 参数与 fragment。
5. **第 5 级：冲突显式上报与待人工绑定 (Explicit Identity Collision)**：
   - 若在同一扫描周期内出现两条非敏感元数据与凭据均相同或无法区分的条目，系统标记 `identity_collision=true`；
   - 不进行静默自动归并，阻断不可靠的自动覆盖，提示管理员介入。

### 2.3 密钥轮换与重绑定策略 (Key Rotation & Rebinding)

- 加盐 HMAC 属于伪匿名标识（Pseudonymous Identifier）。当真实密钥轮换时，其 HMAC 随之发生改变；
- 系统接受“密钥轮换改变 HMAC”的客观事实，依靠稳定 `auth_index` 或关联的业务 Connection 保持用户层身份；对于仅依赖 Keyed HMAC 的资源，提供显式的重新绑定（Rebinding）能力，不强行将易碎推断封装为虚假的一致性。

### 2.4 历史用量与生命周期连续性

- 采集与用量事件入库时，优先绑定当前唯一的 `cpa_bindings` 记录；
- 若资源由于上游配置删除而变为 `missing`，`cpa_bindings` 标记 `missing_at_ms` 时间戳，外键关联设置为 `ON DELETE SET NULL`；
- 历史用量记录保留发生时刻的快照信息，任何当前资源的修改、停用或删除操作均不可篡改或清空历史真实请求事件。

---

## 3. 影响与后果

- **优势**：
  - 上游配置重排或前插配置项不再导致 Oh My CPA 的自定义名称和图标发生错乱；
  - 彻底规避明文密钥进入任何索引、主键或数据关联中；
  - 多资源同名 `auth_index` 不再产生重复事件与分页混乱；
  - 实体模型更清晰，符合渐进式单体（Modular Monolith）架构演进。
- **限制与代价**：
  - 缺乏 `auth_index` 且无 API Key 的空白条目需要管理员手动介入绑定；
  - 数据库引入 `cpa_bindings` 新表维护与发现状态的投影同步。
