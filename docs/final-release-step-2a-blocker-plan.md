# FINAL RELEASE STEP 2A — Blocker Closure Plan

审计时间：2026-08-25（Asia/Shanghai）
模式：`ANALYZE / PREPARE / DRY-RUN ONLY`
生产写入：**0**；依赖变更：**0**；部署：**0**；runtime 变更：**0**。

## 1. Product cleanup scope

生产只读快照确认 `products = 72`：`available 32 / offline 25 / sold 12 / deleted 3`，没有 `reserved`。

| 精确范围 | total | available | offline | sold | deleted |
|---|---:|---:|---:|---:|---:|
| 上海财经大学浙江学院 `s_2639dd0d2bb01fb6a317e43e771a6f30` | 10 | 2 | 8 | 0 | 0 |
| 上海工程技术大学 `s_e5ca127017371b84bec8b1a67137b898` | 46 | 30 | 14 | 1 | 1 |
| 无 `schoolId` legacy | 16 | 0 | 3 | 11 | 2 |

未来 Step 2B 的唯一业务目标是上述两所学校的 **32 条**当前 `available` product。精确 product ID 仅保存于 ignored 私有文件 `tmp/final-release-product-cleanup-manifest.json`，报告不输出 seller 身份和 product ID。16 条 no-school legacy 不在 mutation 范围内。

## 2. Public-market-zero definition

**PUBLIC MARKET ZERO 完整满足“现在两所学校上线前恢复到 0 件公开商品”。** 不要求物理 `products count = 0`。

公开首页、搜索、分类使用 school-scoped `productQuery`，公开状态集合为 `available + reserved`；卖家公开主页及“件在售”计数使用相同集合。当前 `reserved = 0`，将 32 条 `available` 全部转为 `offline` 后，所有公开入口均返回 0。Step 2B 必须同时 post-audit `available = 0` 和 `reserved = 0`，防止清理期间出现新的公开商品。

`offline/sold/deleted` 不进入公开查询，客户端没有把这些状态计入公开商品数量。历史详情、会话、消息、预约仍可读取 live product 或 snapshot/tombstone；no-school legacy 当前无公开状态且 school scope 无法命中。

## 3. 13 invalid seller products

32 个目标中，19 个 seller 可解析到 active user，13 个无法解析。13 个异常项逐条与 `mock/products.js` 比较后，product ID、title、description、category、price、mock seller ID 全部精确匹配：

- 来源分类：`seed/mock = 13`；真实用户商品 = 0；deleted-user/migrated/other = 0。
- 数据特征：legacy mock `sellerId`，缺少可解析 `sellerOpenid`；13 条均没有生产 user。
- 其余 19 条均有有效 seller；其中 17 条 title 有明确历史测试标记，2 条只能归类为普通 `published-record`，不能仅凭 publish request ID 断言为 fixture。没有第二组 available seller-integrity 异常。此分类不用于扩大删除范围，32 条均按负责人定义的 PUBLIC MARKET ZERO 只做 offline。
- 这 13 条一旦由 `available → offline`，公开详情/建会话入口会先按状态拒绝，不再触发公开市场中的 `PRODUCT_SELLER_UNAVAILABLE`；预期 `PUBLIC AVAILABLE PRODUCTS WITH INVALID SELLER = 0`。
- 13 条没有 version 字段是已知 seed schema，不是未知状态；现有 `manageProduct.getProductVersion` 同样按 0 归一化。未来受控 mutation 的 next version 为 1。

结论：13 条全部是上线前应清理的 mock seed，不存在真实用户商品误清理风险。

## 4. Relationship impact

32 条目标的关系只读统计：

| 关系 | 数量 |
|---|---:|
| favorites | 6 |
| active conversations | 3 |
| merged conversations | 0 |
| direct product messages | 19 |
| product context/card messages | 81 |
| unique messages with any product reference | 81 |
| appointments | 8 |
| productViews | 19 |

分类结果：17 条 `safe-to-offline`，15 条 `requires-snapshot-preservation`，0 条 `unexpected relationship blocker`。后者仅表示存在历史关系，要求 product 文档保留并继续使用 snapshot fallback；并不要求新增 tombstone，也不允许删除关系。

全库另有 20 个历史 conversation context 的 live product 已不存在，但每条均有 `lastProductSnapshot/productSnapshot`；`messageQuery.safeProduct` 已按 live-record → snapshot → deleted-safe DTO 回退。本次不删除 32 个 product，因此不会新增 conversation/message/appointment orphan。messages、conversations、appointments、favorites、productViews 的未来删除数均为 0。

## 5. Proposed archive/offline strategy

现有 `manageProduct.takeOffline` 已实现正确状态模型：transaction 内校验 owner，`available → offline`，设置 `offlineAt/updatedAt = serverDate()`，`version + 1`，并支持已完成状态的幂等返回。它适用于普通 owner 操作，但不能完整复用为本次管理员批处理：13 个 mock seller 不存在，管理员也不能冒充 owner。

Step 2B 应新增一次性、明确授权的 admin maintenance runner，并复用相同 transition data 语义，而不是绕过范围锁或调用 owner 身份。要求：

1. `--env production`、`--write`、授权短语三重显式门；默认 `--dry-run` 且 `write=false`。
2. 只接受本次 manifest 的 32 个批准 ID；锁定两所 exact schoolId、target count 32、target-ID hash 与 before-snapshot hash。
3. mutation 前重新 QUERY 每条：ID、schoolId、status、version/字段缺失、seller 和关系计数；任何 drift 全批停止。
4. 每条只允许 `status: available → offline`、server `offlineAt/updatedAt`、`version: normalizedVersion + 1`；不 remove、不改 seller/school/media/关系。
5. batch cap 20，计划为 20 + 12；每条独立结果日志、确定性 operation ID、已 offline 且 marker 正确时幂等跳过，失败可安全 resume。
6. 执行后重新做全量只读 inventory、公开状态、seller integrity 和关系完整性审计；任何 post-state 不符即停止后续发布。

不采用 soft-delete：PUBLIC MARKET ZERO 不需要 deleted 状态，offline 更小、更可逆，并完整保留 Phase 24/25 关系链。

## 6. Dry-run manifest

新增永久零业务写入生成器 `scripts/final-release-product-cleanup-dry-run.js` 和 fail-closed 校验 `scripts/verify-final-release-product-cleanup-dry-run.js`。

最新 manifest：

- 路径：`tmp/final-release-product-cleanup-manifest.json`（已由 `.gitignore` 的 `tmp/` 隔离）
- `generatedAt = 2026-08-25T12:37:49.285Z`
- environment：production，preflight `action=audit`，`write=false`，production/staging distinct
- products total：72；target count：32；invalid seller：13
- target IDs SHA-256：`0f2fced4111aa70f3254ba951a8a348d132cbbc9d8e6154b2d89b3e00627fb38`
- before snapshot SHA-256：`e0f4319a2a2c9c4acb370a90abe9ce05168afe1ecc7d9882ad71d762a9435630`
- `safeToApply = true`；`issues = []`

工具只构造 `CommandType: QUERY`，分页上限 1,000、全 collection 上限 10,000；`--write/--apply/--execute/--allow-production-write` 均立即 fail closed。它的本地 manifest 文件写入不等于生产业务写入。

## 7. Expected post-state

Step 2B 精确执行 32 次 product document update 后：

```text
products total = 72
available total = 0
reserved total = 0
offline total = 57
sold total = 12
deleted total = 3
上海财经大学浙江学院 available = 0
上海工程技术大学 available = 0
invalid-seller available = 0
legacy no-school available = 0
public market visible products = 0
conversation orphan introduced by cleanup = 0
message product-context failure introduced by cleanup = 0
appointment product relation failure introduced by cleanup = 0
```

物理 product 数量保持 72；32 个目标文档仍存在，全部历史关系保持原数量。

## 8. Dependency advisories

所有 12 个云函数均为 `wx-server-sdk@4.0.2 → @cloudbase/node-sdk@3.17.2 → axios@0.27.2 + @cloudbase/database@1.4.3 → lodash.set@4.3.2/lodash.unset@4.5.2`。代表性生产 lockfile 的 `npm audit --omit=dev` 为 5 high + 1 moderate aggregate。下表逐项覆盖本次 npm audit 返回的每个 advisory/CVE；“受影响”均指已安装版本落在 advisory range。

| Advisory / CVE | package | 类型与攻击前提 | 本项目 reachability |
|---|---|---|---|
| [GHSA-wf5p-g6vw-rhxx](https://github.com/advisories/GHSA-wf5p-g6vw-rhxx) / CVE-2023-45857 | axios 0.27.2 | browser XSRF credential leakage | Node cloud runtime；browser-only path 不可达 |
| [GHSA-jr5f-v2jv-69x6](https://github.com/advisories/GHSA-jr5f-v2jv-69x6) / CVE-2025-27152 | axios 0.27.2 | absolute-URL SSRF/credential leak；需 attacker URL | SDK endpoint 内部生成；业务输入不接受 URL |
| [GHSA-3p68-rc4w-qgx5](https://github.com/advisories/GHSA-3p68-rc4w-qgx5) / CVE-2025-62718 | axios 0.27.2 | `NO_PROXY` hostname bypass；需 proxy + attacker host | 未配置业务 proxy/动态 host |
| [GHSA-w9j2-pvgh-6h63](https://github.com/advisories/GHSA-w9j2-pvgh-6h63) / CVE-2026-42041 | axios 0.27.2 | polluted prototype alters `validateStatus` | 无已知 global prototype pollution；config 由 SDK 构造 |
| [GHSA-pmwg-cvhr-8vh7](https://github.com/advisories/GHSA-pmwg-cvhr-8vh7) / CVE-2026-42043 | axios 0.27.2 | loopback `NO_PROXY` bypass；需 proxy + attacker URL | 前提不可由业务输入建立 |
| [GHSA-xhjh-pmcv-23jw](https://github.com/advisories/GHSA-xhjh-pmcv-23jw) / CVE-2026-42040 | axios 0.27.2 | URLSearchParams null-byte；需 attacker key/value | 没有业务 URLSearchParams 流入 SDK |
| [GHSA-m7pr-hjqh-92cm](https://github.com/advisories/GHSA-m7pr-hjqh-92cm) / CVE-2026-42038 | axios 0.27.2 | IP-alias `no_proxy` SSRF | 无 attacker host/proxy 控制 |
| [GHSA-5c9x-8gcm-mpgx](https://github.com/advisories/GHSA-5c9x-8gcm-mpgx) / CVE-2026-42034 | axios 0.27.2 | streamed upload bypasses `maxBodyLength` | 云函数不把用户 stream 交给 Axios |
| [GHSA-vf2m-468p-8v99](https://github.com/advisories/GHSA-vf2m-468p-8v99) / CVE-2026-42036 | axios 0.27.2 | streamed response bypasses `maxContentLength` | 远端为 CloudBase vendor endpoint；用户不控 response host |
| [GHSA-pf86-5x62-jrwf](https://github.com/advisories/GHSA-pf86-5x62-jrwf) / CVE-2026-42033 | axios 0.27.2 | prototype gadget：response/request hijack | 需预先污染 Object prototype；未发现业务可达 polluter |
| [GHSA-6chq-wfr3-2hj9](https://github.com/advisories/GHSA-6chq-wfr3-2hj9) / CVE-2026-42035 | axios 0.27.2 | prototype gadget header injection | 同上；headers 为 SDK 内部生成 |
| [GHSA-xx6v-rp6x-q39c](https://github.com/advisories/GHSA-xx6v-rp6x-q39c) / CVE-2026-42042 | axios 0.27.2 | polluted `withXSRFToken` | browser XSRF + prototype 前提均不成立 |
| [GHSA-43fc-jf86-j433](https://github.com/advisories/GHSA-43fc-jf86-j433) / CVE-2026-25639 | axios 0.27.2 | `mergeConfig` `__proto__` DoS | 业务对象不作为 Axios config；SDK config 固定 |
| [GHSA-fvcv-3m26-pcqx](https://github.com/advisories/GHSA-fvcv-3m26-pcqx) / CVE-2026-40175 | axios 0.27.2 | header chain → cloud metadata exfiltration | 需 attacker URL/header/prototype chain；业务无该入口 |
| [GHSA-62hf-57xw-28j9](https://github.com/advisories/GHSA-62hf-57xw-28j9) / CVE-2026-42039 | axios 0.27.2 | deeply nested `toFormData` recursion DoS | event 字段逐项 normalize/限长；不传任意深层 form object |
| [GHSA-hfxv-24rg-xrqf](https://github.com/advisories/GHSA-hfxv-24rg-xrqf) / CVE-2026-44496 | axios 0.27.2 | cookie-name ReDoS | Node SDK 路径无 attacker cookie name |
| [GHSA-p92q-9vqr-4j8v](https://github.com/advisories/GHSA-p92q-9vqr-4j8v) / CVE-2026-44487 | axios 0.27.2 | proxy auth leak on HTTP→HTTPS redirect | 需配置 credential proxy + redirect；业务不控 endpoint |
| [GHSA-j5f8-grm9-p9fc](https://github.com/advisories/GHSA-j5f8-grm9-p9fc) / CVE-2026-44486 | axios 0.27.2 | proxy auth leak on redirect-to-direct | 同上 |
| [GHSA-3g43-6gmg-66jw](https://github.com/advisories/GHSA-3g43-6gmg-66jw) / CVE-2026-44495 | axios 0.27.2 | prototype config gadget credential theft/hijack | 无业务可达 global polluter/config injection |
| [GHSA-898c-q2cr-xwhg](https://github.com/advisories/GHSA-898c-q2cr-xwhg) / CVE-2026-44490 | axios 0.27.2 | prototype read gadget DoS/header injection | 同上 |
| [GHSA-pjwm-pj3p-43mv](https://github.com/advisories/GHSA-pjwm-pj3p-43mv) / CVE-2026-44492 | axios 0.27.2 | IPv4-mapped IPv6 `NO_PROXY` bypass | 无 attacker URL/proxy 控制 |
| [GHSA-mmx7-hfxf-jppx](https://github.com/advisories/GHSA-mmx7-hfxf-jppx) / CVE pending | axios 0.27.2 | polluted prototype alters request construction | 无已知业务 polluter；SDK internal use remains residual risk |
| [GHSA-7q8q-rj6j-mhjq](https://github.com/advisories/GHSA-7q8q-rj6j-mhjq) / CVE pending | axios 0.27.2 | nested Axios options consume inherited values | 业务不传 Axios option object；SDK internal use remains residual risk |
| [GHSA-p6mc-m468-83gw](https://github.com/advisories/GHSA-p6mc-m468-83gw) / CVE-2020-8203 | lodash.set 4.3.2 | prototype pollution via attacker path | 仅 database realtime virtual client 的 server event fieldPath；项目无 `.watch()` |
| [GHSA-f23m-r3pf-42rh](https://github.com/advisories/GHSA-f23m-r3pf-42rh) / CVE-2026-2950 | lodash.unset 4.5.2 | array-path prototype pollution | 同一 realtime-only 路径；未调用 |
| [GHSA-xxjr-mmjv-4gpg](https://github.com/advisories/GHSA-xxjr-mmjv-4gpg) / CVE-2025-13465 | lodash.unset 4.5.2 | path prototype pollution | 同一 realtime-only 路径；未调用 |

## 9. Exploitability analysis

不能以“没有直接 require Axios”判安全：`@cloudbase/node-sdk` 的 metadata/request client 确实加载并使用 Axios，因此 vulnerable code 随每个函数部署。实际业务调用主要是 CloudBase database、storage、identity API，endpoint、签名 headers、proxy/config 均由 SDK/运行环境控制。

源码审查结果：

- 云函数 action 使用 allowlist；identity 来自 `getWXContext`；product/message/appointment/profile 字段逐项 normalize、长度/格式/枚举校验，未把完整 event 作为 Axios URL、headers、proxy 或 config。
- `messageAction`/`appointmentAction` 的 `Object.assign({}, nestedData, request)` 只形成局部 action data；下游仍逐项取值，不传给 Axios config，也没有写入 `Object.prototype` 的路径。
- `lodash.set/unset` 在 `@cloudbase/database` 仅被 realtime `VirtualWebSocketClient` 用于 server event `fieldPath`；全项目没有 `.watch()`，常规 get/where/update/transaction 不进入该路径。
- 没有用户控制 URL、proxy、cookie name、stream、Axios options 或任意深层 form-data 的业务 API；SSRF、credential leak、stream limit、ReDoS 和 prototype gadget 的必要前提均未在当前调用图中满足。

因此没有证据表明当前公开 cloud-function 输入可稳定利用这些 advisories。但 SDK 内 Axios 路径真实可达，且 vendor 环境、未来 SDK feature、环境 proxy 或尚未识别的 prototype polluter 会改变结论，所以不能标记为“无风险”。

## 10. Vendor/upstream status

- npm/GitHub 上 `wx-server-sdk` stable latest 为 4.0.2，并精确锁定 `@cloudbase/node-sdk@3.17.2`；[官方仓库 changelog](https://github.com/wechat-miniprogram/wx-server-sdk) 也记录该升级链。
- `wx-server-sdk@4.0.3-beta.1` 改为 `@cloudbase/node-sdk@3.18.5`，但 3.18.5 仍精确依赖 `axios@0.27.2` 和 `@cloudbase/database@1.4.3`，不是安全修复。
- `@cloudbase/node-sdk` stable tag 为 3.18.3、release-v3 为 3.18.5；两者依赖未修。next 4.0.3 仍精确依赖 Axios 0.27.2，只移除了旧 database 包，且不是 wx-server-sdk 支持的稳定链。
- `@cloudbase/database@1.5.0` 已不依赖 lodash.set/unset，但 node-sdk 3.x 精确锁定 1.4.3；override 跨 SDK 锁定/内部 API，兼容性无 vendor 保证。
- Axios v0 修复线已有 0.33.0，lodash.unset 有 4.18.0；直接 override 会违反 vendor exact dependency，且 Axios 0.27→0.33/1.x 的 proxy、adapter、merge 行为变化未经过 CloudBase SDK compatibility suite。
- `npm audit fix --force` 建议降级 `wx-server-sdk@2.5.3`，属于破坏性错误方向，明确禁止。

未发现腾讯/CloudBase 针对这条完整 dependency chain 发布的兼容安全版本或正式风险声明。

## 11. Dependency recommendation

### NO SAFE UPGRADE — RISK ACCEPTANCE CANDIDATE

理由：当前业务输入未满足 advisory 利用前提，lodash 路径 dormant，现有严格字段/identity/status/school allowlist 提供有效缓解；但 Axios 是 SDK 内部真实依赖，稳定 vendor 链没有 patched release，未经测试的 override 不能称为安全升级。

残余风险与控制：

- 在 release risk register 记录 26 个 GHSA、锁定版本、当前 reachability 和 owner 签字；风险接受只覆盖现有 API surface，不覆盖新 URL/proxy/watch/custom-request 功能。
- CI/发布前对 12 个函数重新 `npm audit --omit=dev`，每周检查 `wx-server-sdk`、`@cloudbase/node-sdk` dist-tags/changelog；新 stable patched chain 出现后 staging-first。
- 监控 cloud function 异常外连、metadata/proxy/header 异常、DoS/timeout、SDK request error rate；禁止新增 `.watch()`、任意 URL fetch、用户 headers/proxy/Axios config，除非重新 threat-model。
- vendor stable 修复出现后：在 staging 更新 lockfile → 12 函数完整回归 → CloudBase database/storage/auth canary → dependency diff/audit → 分批生产；本轮不改依赖。

该分类不阻止 Step 2B 的受控数据清理授权；正式全国发布仍需项目负责人明确接受 residual dependency risk，或等待 vendor 修复。

## 12. Node16 recommendation

`authUser/createProduct/manageProduct/productQuery` 仍为 Nodejs16.13；其余 8 个生产函数为 Nodejs18.15。Node 官方已将 [Node 16](https://nodejs.org/en/about/eol) 和 Node 18 都列为 EOL。CloudBase [官方 runtime 配置文档](https://docs.cloudbase.net/cli-v1/functions/configs) 当前仍支持 16.13、18.15、20.19、22.21、24.11，并推荐 Nodejs20.19。

四函数源码只使用 CommonJS、Promise/async、crypto、Buffer、URL、标准 timers 和 CloudBase SDK；无 native addon、无 Node16 私有/已移除 API。`@cloudbase/node-sdk` engine 为 `node >=12`，本轮完整测试在当前 Node 24 工具环境通过；生产已有 8 个同 SDK 函数运行 Node18，未见源级兼容 blocker。

结论：**NON-BLOCKING HARDENING**（对 Step 2B）。不要在数据清理前扩大 change surface；后续应以 Nodejs20.19 而非已经 EOL 的 Node18 为目标，在 staging 对 12 个函数统一做 runtime canary、database/storage/auth/message/appointment 回归、冷启动和 rollback 演练，再单独授权生产 runtime 变更。

## 13. Automated verification

2026-08-25 全部通过：

| Gate | 结果 |
|---|---|
| Phase 25 lifecycle | PASS，67 assertions |
| hide/send race | PASS，899 assertions（含 120 repeated interleavings） |
| attempt diagnostics | PASS，69 assertions |
| rollback compatibility | PASS，35 assertions |
| project verify | PASS，81 checks |
| Phase 24 pair | PASS，52 assertions/scenarios |
| Phase 24 | PASS，88 checks |
| school verification | PASS，5 groups |
| school selection | PASS，128 checks |
| Phase 23 security/production hardening | PASS，133 checks |
| Phase 22 integrity/finalization | PASS，42 checks |
| Phase 22A school-data gate | PASS，6 groups |
| Phase 18 preflight safety | PASS，10 groups |
| cleanup dry-run fail-closed verifier | PASS，28 checks |
| fresh production manifest | PASS，`safeToApply=true`, `issues=[]` |
| `git diff --check` | PASS |

新增 verifier 明确测试 production-only、四种 write flag 拒绝、count/school/origin/orphan drift fail closed、只允许 QUERY、无 database mutation/transaction。

## 14. Remaining blockers

Step 2A 已关闭“清理对象未知”“13 条是否真实用户商品”“关系是否会被破坏”“清理后精确状态未知”和“dry-run 不可验证”这些规划 blocker。

仍存在但不阻止请求 Step 2B 授权的事项：

- production 目前仍有 32 条公开商品；这是 Step 2B 待授权 mutation 本身。
- dependency 为 `NO SAFE UPGRADE — RISK ACCEPTANCE CANDIDATE`；正式全国发布前需要 owner 风险接受或 vendor patched stable chain。
- Node16/18 EOL 为 `NON-BLOCKING HARDENING`；单独 staging-first runtime 变更，不与 Step 2B 混合。
- 尚未创建可写 Step 2B runner；它只能在负责人明确授权后按第 5/15 节实现和复核。

## 15. Step 2B authorization requirements

授权范围必须逐字明确为：

> 在 production，仅对 manifest hash `0f2fced4111aa70f3254ba951a8a348d132cbbc9d8e6154b2d89b3e00627fb38` 所列、属于两所 exact schoolId、执行前仍为 available 且 before snapshot 验证一致的 32 个 product，执行 32 次 `available → offline` controlled update；不 delete product，不修改任何 user/school/dependency/runtime，不删除或修改 favorites/conversations/messages/appointments/productViews。

执行前必须重新生成 manifest 并仍满足：target count 32、reserved 0、invalid seller 13 且全部 seed/mock、`safeToApply=true`、`issues=[]`、ID hash 与授权一致。任何一项漂移都使授权失效，重新回到 Step 2A。

精确未来 production mutations：**32 次 product document update，范围为上海财经大学浙江学院 2 条 + 上海工程技术大学 30 条；字段语义仅 status/offlineAt/updatedAt/version。其他 collection mutation = 0，product remove = 0。**
