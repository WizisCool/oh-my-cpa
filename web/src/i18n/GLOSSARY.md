# Terminology glossary

One concept, one word, per language. When a sentence needs the concept, it uses the word below;
when the word reads badly in a particular sentence, rephrase the sentence rather than swap in a
synonym, because a reader who meets two words assumes two things.

The meanings come from the product vocabulary in [`CONTEXT.md`](../../../CONTEXT.md). The status
column says how far each choice has actually been checked, and it never claims more than was done:

- **settled**: the word is the ordinary one in that language for that concept, applied across the
  catalog, and nothing found in published references contradicts it;
- **review**: applied across the catalog, but the choice is the maintainers' reading of regional
  software convention and wants a native speaker working in that region's software industry to
  confirm it. **No entry in this file has been confirmed by such a reviewer yet.** A `review` mark
  means exactly that, whichever half of a cell it sits beside.

### Hong Kong Traditional Chinese (`zh-Hant` / `zh-HK`)

The Traditional Chinese catalog is written in **Hong Kong** usage, to match the shell's Hong Kong
flag (`country: 'HK'`), the BCP 47 locale it reports (`zh-HK`), and the Ant Design locale it takes
(`zhHK`): 軟件, 網絡, 帳戶, 用戶, 項目, 插件, 網關, 按…排序。

It is deliberately not a character conversion of `zh`, and not a mix with Taiwan (`zh-TW`):
軟體, 網路, 帳號, 使用者, 專案, 外掛, 閘道, 依…排序. A reader who wants a Taiwan reading should
contribute it as its own `zh-TW` locale, following [README.md](README.md), rather than shifting
this one.

**Where the evidence is thin, it says so here rather than in the catalog.** The one term that
matters most, *key*, is genuinely split in Hong Kong writing: Microsoft's `zh-hk` support pages
write 密鑰 for a passkey ([建立並儲存密鑰](https://support.microsoft.com/zh-hk/accounts-billing/security/create-save-passkey)),
but 安全性金鑰 for a FIDO security key on the same site, while Microsoft's `zh-tw` documentation
uses 金鑰 throughout ([API 金鑰](https://learn.microsoft.com/zh-tw/azure/search/search-security-api-keys)).
This catalog uses **密鑰** so that one word covers the concept, and the choice is marked `review`:
it is an editorial reading of mixed usage, not a published Hong Kong standard. A native reviewer
should settle it, and its rows say so. Published reference points for such a review are the HKSAR
Government's [English-Chinese Glossary of IT Terms](https://www.digitalpolicy.gov.hk/en/our_work/digital_infrastructure/methodology/glossary/doc/IT_Glossary.pdf)
and Microsoft's `zh-hk` documentation.

## Keys, tokens and secrets

"Key" is not one concept in OMC. Name the kind of key whenever the sentence does not already make
it obvious.

| Concept | en | zh | zh-Hant | ms | Status |
| --- | --- | --- | --- | --- | --- |
| A provider's upstream key (OpenAI, Anthropic…) | API key | API 密钥 | API 密鑰 | kunci API | settled (zh, en) · review (zh-Hant is an editorial reading of mixed Hong Kong usage; ms) |
| A key callers present to the gateway (`api-keys` in CPA) | client key | 客户端密钥 | 用戶端密鑰 | kunci klien | settled (zh, en) · review (zh-Hant, ms) |
| CPA's management key | management key | 管理密钥 | 管理密鑰 | kunci pengurusan | settled (zh, en) · review (zh-Hant, ms) |
| Any secret value in general (a key, a password, a token) | secret | 密钥 (a key) / 敏感信息 | 密鑰 / 敏感資料 | rahsia | settled (zh, en) · review (zh-Hant, ms) |
| OAuth access or refresh token | token | 令牌 | 令牌 | token | review (令牌 vs token is itself the open question) |
| Units of model input and output | tokens | Token (no plural) | Token | token | settled (zh, en, ms): the Latin word is what developers say |

Simplified Chinese 密钥 rather than 密鑰 or 金鑰: mainland documentation uses it for a gateway or
cloud API key. Traditional Chinese 金鑰 is the Taiwan word (Microsoft's `zh-tw` Learn pages use it
for API keys), which is exactly why it is not the Hong Kong catalog's word - see the note above for
how mixed the Hong Kong evidence actually is. Keep `API` and `Token` in Latin script in both
Chinese catalogs: developers in every Chinese-speaking region read them as words.

## Access and identity

| Concept | en | zh | zh-Hant | ms | Status |
| --- | --- | --- | --- | --- | --- |
| Credential: authentication material CPA uses (OAuth file, API key, service account) | credential | 凭据 | 憑證 | kelayakan | settled (zh, en) · review (zh-Hant, ms) |
| OAuth auth file | auth file | 认证文件 | 認證檔案 | fail pengesahan | settled (zh, en) · review (zh-Hant, ms) |
| Authentication (proving identity) | authentication | 认证 | 認證 | pengesahan | settled (zh, en) · review (zh-Hant, ms) |
| Authorization (granting a permission) | authorization | 授权 | 授權 | kebenaran | settled (zh, en) · review (zh-Hant, ms) |
| Signing in / out | sign in / sign out | 登录 / 退出登录 | 登入 / 登出 | log masuk / log keluar | settled (zh, en) · review (zh-Hant, ms) |
| Account (upstream identity) | account | 账号 | 帳戶 | akaun | settled (zh, en) · review (zh-Hant, ms) |

凭据 rather than 凭证 in Simplified Chinese: both appear in mainland documentation, but 凭证 is
also a voucher or a certificate, and the console already uses 证书 for TLS certificates.

## Routing and traffic

| Concept | en | zh | zh-Hant | ms | Status |
| --- | --- | --- | --- | --- | --- |
| Provider (who serves models) | provider | 提供商 | 供應商 | penyedia | settled (zh, en) · review (zh-Hant, ms) |
| Model | model | 模型 | 模型 | model | settled (zh, en) · review (zh-Hant, ms) |
| Endpoint (a base URL traffic goes to) | endpoint | 端点 | 端點 | titik akhir | settled (zh, en) · review (zh-Hant, ms) |
| Gateway (CPA) | gateway | 网关 | 網關 | get laluan | review (ms: get laluan is a coinage for a product name) |
| Proxy (an outbound HTTP proxy) | proxy | 代理 | 代理 | proksi | settled (zh, en) · review (zh-Hant, ms) |
| Request | request | 请求 | 請求 | permintaan | settled (zh, en) · review (zh-Hant, ms) |
| Request records (the console's request list) | request records | 请求记录 | 請求記錄 | rekod permintaan | settled (zh, en) · review (zh-Hant, ms) |
| Channel (a provider label a price multiplier applies to) | channel | 渠道 | 渠道 | saluran (multiplier: pengganda) | review (the multiplier reading is not settled in any language here) |
| Agent (the console's assistant) | Agent | 智能体 | AI 代理 | Ejen | review (智能體 / AI 代理 / Ejen: all three want a native reader) |

The Traditional Chinese Agent is always 「AI 代理」 with its prefix, because 代理 alone is a proxy.

## Usage and money

| Concept | en | zh | zh-Hant | ms | Status |
| --- | --- | --- | --- | --- | --- |
| Usage (what was consumed) | usage | 用量 | 用量 | penggunaan | settled (zh, en) · review (zh-Hant, ms) |
| Quota (a subscription's allowance in a window) | quota | 额度 | 額度 | kuota | settled (zh, en) · review (zh-Hant, ms) |
| Quota window (5-hour, weekly) | quota window | 额度窗口 | 額度窗口 | tetingkap kuota | settled (zh, en) · review (zh-Hant, ms) |
| Codex reset credit | reset credit | 重置次数 | 重設次數 | kredit set semula | review (the count reading is the maintainers’) |
| Cost (what a request cost) | cost | 费用 | 費用 | kos | settled (zh, en) · review (zh-Hant, ms) |
| Price / pricing (rates per token) | price / pricing | 价格 / 定价 | 價格 / 定價 | harga | settled (zh, en) · review (zh-Hant, ms) |
| Billing (charging for usage) | billing | 计费 | 計費 | pengebilan | settled (zh, en) · review (zh-Hant, ms) |

额度 rather than 配额: in Chinese the subscription allowance of a coding plan is talked about as
额度; 配额 is the cloud-console word for API rate quotas, which OMC does not manage. A reset credit
is counted (重置次数), not a points balance (积分).

## States and actions

| Concept | en | zh | zh-Hant | ms | Status |
| --- | --- | --- | --- | --- | --- |
| Enable / disable a thing (provider, credential, plugin) | enable / disable | 启用 / 停用 | 啟用 / 停用 | dayakan / lumpuhkan | settled (zh, en) · review (zh-Hant, ms) |
| Turn a feature off (a configuration switch) | disable | 禁用 | 停用 | lumpuhkan | settled (zh, en) · review (zh-Hant, ms) |
| Exclude a model (OAuth model exclusions) | exclude / exclusion | 排除 / 排除规则 | 排除 / 排除規則 | kecualikan / pengecualian | settled (zh, en) · review (zh-Hant, ms) |
| Refresh (read again) | refresh | 刷新 | 重新整理 | muat semula | settled (zh, en) · review (zh-Hant, ms) |
| Reset (return to a starting state) | reset | 重置 | 重設 | set semula | settled (zh, en) · review (zh-Hant, ms) |
| Save | save | 保存 | 儲存 | simpan | settled (zh, en) · review (zh-Hant, ms) |
| Settings / configuration (CPA's YAML) | settings / configuration | 设置 / 配置 | 設定 | tetapan / konfigurasi | settled (zh, en) · review (zh-Hant, ms) |
| Plugin | plugin | 插件 | 插件 | pemalam | settled (zh, en) · review (zh-Hant, ms) |

A disabled credential and an excluded model are different facts, so they never share a word:
Simplified Chinese 停用 for the first and 排除 for the second.

## Never translated

Product and protocol names stay as their owners spell them: Oh My CPA, OMC, CPA, CLIProxyAPI,
OAuth, OpenAI, Anthropic, Claude, Codex, Gemini, Vertex, Antigravity, OpenRouter, models.dev, MCP,
OpenUI, YAML, JSON, TLS, HTTP(S), SQLite, WAL, Base64, User-Agent. So do configuration keys,
HTTP headers, paths, environment variables and model IDs (`access.api-keys`, `x-client-request-id`,
`OMCPA_CPA_MANAGEMENT_KEY`, `gpt-5-*`): a reader copies them into a file, so they must match it.
