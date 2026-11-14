# 路由与模型规则

## 模型规则

在 OAuth 管理中可编辑提供商级的模型别名或 `oauth.excluded-models`。凭据自己的 `excluded_models` 非空时会替换提供商默认值（需 CPA v8.0.33+），清空后恢复继承。排除规则先于别名映射生效。

## 路由

`/routing` 看板把 API Key、OpenAI 兼容渠道与 OAuth 凭据编排为多级优先级。应用路由方案时会记录审计、先保存加密配置备份（`routing_plan`），再按看板版本更新提供商优先级与权重并修补受影响的 OAuth 凭据；并发修改时返回 `routing_conflict`。
