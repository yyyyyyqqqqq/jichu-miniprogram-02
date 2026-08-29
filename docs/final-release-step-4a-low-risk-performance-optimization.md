# Final Release Step 4A — Low-Risk Performance Optimization

## 1. Scope

本轮对当前 production release 做 evidence-first 的低风险性能审计：先静态审计和 READ-ONLY / ZERO-WRITE 基线，再分级候选，只实施一个有前后测量证据且可单文件回滚的 LOW 项。范围覆盖主要小程序页面、公共 services/utils/store、production 云函数矩阵和数据库查询形态。

本轮没有部署 production，没有创建 benchmark fixture，没有业务数据写入，没有 schema/index/permission/runtime/dependency 变化，也没有 commit、push 或 tag。

## 2. Safety Constraints

- 只读审计优先，小样本、单并发、顺序 production probes；不做 load test。
- production runtime 脚本使用显式 read-action allowlist；不包含创建、更新、删除、已读、浏览量或其他 mutation action。
- 不修改 authorization、ownership、visibility、学校 identity/状态/切换、跨校历史关系、conversation pair、appointment 状态机、登录语义或 PUBLIC MARKET ZERO。
- 不删除服务端校验，不引入 cache/prefetch，不迁移 Node/runtime，不升级依赖。
- 每次只做一个逻辑优化；收益不明确、语义存在疑问或风险为 MEDIUM/HIGH 的候选不修改。
- source 优化只做本地验证；因为未部署，不把未变化的 production spot-check 冒充“优化后线上数据”。

## 3. Production Baseline

执行前仓库状态：

- branch：`main`
- HEAD / `origin/main`：`e47329bde21756cbbbadc2637db5169209e01e1b`
- ahead / behind：`0 / 0`
- 已有 release tag `phase-25-complete` 指向 `4967995d1ca20f0fef8050b91864721dddafbab5`
- 工作区最初 clean。

Step 4A before invariant（2026-08-29 06:47:13Z）：

| Collection | Count | SHA-256 captured |
|---|---:|---|
| users | 8 | yes |
| products | 72 | yes |
| favorites | 7 | yes |
| conversations | 26 | yes |
| messages | 209 | yes |
| appointments | 25 | yes |
| schools | 2952 | yes |
| productViews | 28 | yes |

其他基线：schools active 2952 / pending 0 / official drift 0 / identity conflict 0；products offline 57 / sold 12 / deleted 3；public visible 0，`PUBLIC MARKET ZERO = true`。production 主要云函数全部 Active / Available，before snapshot 保存了源码 hash 与环境 fingerprint。

## 4. Static Audit

### Mini Program

- 首页商品列表：请求有 version/scope stale guard；分页有界，跨页合并使用 `Map`，未发现 O(n²) 热路径或无界数组。
- 商品详情：有 request version；进入页面会触发浏览量 mutation，因此没有用 UI 详情路径做 production benchmark。
- 收藏：页面分页为 6；客户端云调用通过 service；云函数 list 存在明确的串行商品 hydration N+1。
- 发布/编辑：timer 有 cleanup；上传和 mutation 流程不纳入性能 probe。
- 消息/聊天：query 与 action 分离；消息和预约首读已安全并行；轮询有 `pollInFlight`、可见性 gate、timer/listener/audio/recorder cleanup 与 stale protection。
- 预约：列表与详情有 request version；状态 mutation 未被 benchmark 调用。
- 登录/bootstrap：`bootstrapPromise` 提供 in-flight dedup，`onLaunch`/`onShow` 未形成并发重复 bootstrap。
- 学校选择：350ms debounce、page ≤20、retained window ≤100、`Map` 去重、cursor、version/scope stale guard、timer cleanup 均保持批准状态。
- custom-tab-bar 与公共 services/utils/store：业务云调用集中在 service 层；未发现页面直接数据库访问、泄漏 listener 或需要 speculative cache 的证据。

静态 `setData` 调用数最高的页面为 chat 35、publish 20、product-detail 18、school-select 17、home 16。调用数本身不是问题证据；DevTools 无 error/exception，且缺少低端真机 warning/freeze/payload 数据，因此未修改。

### Cloud Functions / Query Shape

- 审计了 authUser、productQuery、createProduct、manageProduct、favoriteProduct、userQuery、productViewAction、messageQuery、messageAction、appointmentQuery、appointmentAction、schoolQuery。
- production public product cursor path 使用 page+1 的有界读取且不做多余 count；where/orderBy/cursor 形态保持现有索引契约。
- schoolQuery 使用字段 projection、page+1 与 page limit；不做 index 变更。
- message/appointment 的 buyer/seller 独立分支已经使用 `Promise.all`；enrichment 也已有有界并行。
- message list 的最多 8 轮 scan 与 server filtering 保护 delete-for-me/hide visibility，不能为性能删除。
- favorite list 的 relation page 后逐条 `await products.doc(...).get()` 是唯一同时具备清晰证据、LOW 风险和可隔离前后测量的浪费。
- appointment list payload 较大、chat 轮询会刷新 appointment、部分 count/page 顺序读取均已记录，但不满足本轮自动变更门槛。

## 5. Runtime Baseline

### DevTools → production 小样本（变更前）

以下为 5 个顺序 samples；延迟包含 DevTools/automator/网络/云函数整体路径，不是纯数据库 timing。response bytes 是安全响应 envelope 的 UTF-8 JSON 大小。未控制 cold start；另行记录的 first observed 仅作观察。

| Endpoint | Samples | Errors | p50 ms | p95 ms | max ms | Payload p95 B | Payload max B |
|---|---:|---:|---:|---:|---:|---:|---:|
| auth.current | 5 | 0 | 427 | 494 | 494 | 896 | 896 |
| products.homeFirstPage | 5 | 0 | 441 | 589 | 589 | 256 | 256 |
| products.ownerFirstPage | 5 | 0 | 442 | 491 | 491 | 6624 | 6624 |
| products.ownerSecondPage | 5 | 0 | 429 | 453 | 453 | 6840 | 6840 |
| favorites.list | 5 | 0 | 644 | 747 | 747 | n/a | n/a |
| messages.conversations | 5 | 0 | 510 | 583 | 583 | 5125 | 5125 |
| messages.history | 5 | 0 | 518 | 591 | 591 | 6946 | 6946 |
| appointments.list | 5 | 0 | 595 | 715 | 715 | 15063 | 15063 |
| appointments.detail | 5 | 0 | 463 | 607 | 607 | 1586 | 1586 |
| schools.firstPage | 5 | 0 | 394 | 429 | 429 | 4085 | 4085 |
| product detail | 0 | 0 | n/a | n/a | n/a | n/a | n/a |

说明：PUBLIC MARKET ZERO 下没有可用于此账户的安全可读详情样本；最初发现的 offline owner product 被服务端正确拒绝后立即停止该 sample，没有放宽校验，也没有制造商品。公开首页 cursor 同样因结果为 0 不可测；owner second page 用于覆盖安全分页读取。

更宽的 production read-only suite 还覆盖 16 cases / 80 warm samples：aggregate errors 0、console errors 0、exceptions 0；其中 favorite list p50 644ms / p95 747ms，是相邻只读路径中最清晰的候选。after source edit 又做了 3-sample production stability spot-check，仍为 0 error / 0 console error / 0 exception；因云函数没有部署，该 spot-check只用于确认环境稳定与零写，不作为优化收益证据。

### schoolQuery 独立 raw cloud baseline

全国审计严格顺序调用，覆盖 2952 条 / 148 页、8 个搜索范围、5 个省份、cursor deterministic/tamper/cross-scope 和 invalid input。Step 4A 同轮结果为 204 calls、errors 0、duplicate 0、cursor duplicate 0；raw cloud latency p50 51ms、p95 61ms、max 85ms；payload p95 4214B、max 4498B。相较批准基线 53/66/105ms 处于正常波动且无退化。

## 6. Frontend Audit

DevTools read-only baseline 观察到：console errors 0、exceptions 0、unhandled rejection 0。静态审计确认关键 timer/listener 在 hide/unload 释放，列表和搜索有 stale response 防护，bootstrap 有 in-flight dedup，核心分页数组有界。

本环境不是低端真机，不能将 DevTools 结果标记为低端/普通真机 PASS。真机 checklist 见第 12 节。

## 7. Candidate Table

完整字段、证据、验证和回滚方法见 `docs/final-release-step-4a-performance-candidates.md`。

| ID | Candidate | Risk | Evidence | Decision |
|---|---|---|---|---|
| P4A-01 | favorite list 串行 N+1 商品 hydration | LOW | production p50 644ms/p95 747ms；确定性 before benchmark p50 257.93ms | **KEEP** |
| P4A-02 | product owner count/page 并行 | LOW | 无可分离 timing，当前路径无明确异常 | REJECT / DEFER |
| P4A-03 | public seller count/page 并行 | LOW | PUBLIC MARKET ZERO，无法可靠验证 | REJECT / DEFER |
| P4A-04 | appointment list projection 缩减 | MEDIUM | payload 15063B，但涉及 API/历史关系字段 | REPORT ONLY |
| P4A-05 | chat appointment refresh 降频 | MEDIUM | 有 read 成本，但改变 freshness 语义 | REPORT ONLY |
| P4A-06 | message visibility multi-scan 重构 | HIGH | 与隐私过滤/schema/index 强相关 | OUT OF SCOPE |
| P4A-07 | 全局业务 cache | HIGH | 无重复证据且有 user/school 泄漏风险 | OUT OF SCOPE |
| P4A-08 | schoolQuery/selector 再优化 | LOW | 当前 204-call 基线优秀，无 regression 证据 | REJECT / NO CHANGE |
| P4A-09 | 仅按 `setData` 次数合并 | LOW | 无高频大 payload/真机 warning 证据 | REJECT / DEFER |

## 8. Changes Applied

### P4A-01 — favoriteProduct 有界并行 hydration

**Before**

`listMyFavorites` 先读取已排序的关系页，再在 `for...of` 中串行等待每个商品 document read。最大页为 20，语义正确但把独立读延迟累加。

确定性 read-only mock（7 iterations、10 relations、每个 document 20ms delay）：p50 257.93ms、p95/max 266.23ms。

**Change**

只将 relation 对应的独立商品读取改为一个受 `MAX_PAGE_SIZE = 20` 约束的 `Promise.all`，然后按输入顺序执行原状态过滤和原 DTO mapping。查询数量、排序、字段、total/hasMore、错误 envelope 和所有安全检查不变。

**After**

同一 benchmark：p50 23.58ms、p95/max 44.67ms；p50 降低 90.86%，p95 降低 83.22%。result count 10、stable order true、business writes 0。语法检查、收藏定向回归、81 项项目回归与额外 19 个跨阶段脚本均 PASS。

**Decision**

KEEP。收益显著、复杂度增量小、并发有硬上限、单文件可回滚，且没有 semantic/security drift。该变更尚未部署 production。

## 9. Changes Rejected

- 没有并行化 product/user 的 count + page：理论可行不等于有证据；当前样本不能隔离 count 开销，public data 又受 PUBLIC MARKET ZERO 限制。
- 没有裁剪 appointment DTO：15KB 值得后续调查，但字段影响预约列表、聊天入口和历史跨校展示，属于 MEDIUM API-contract 风险。
- 没有降低 chat 中 appointment refresh 频率：会改变状态 freshness，不是纯性能重排。
- 没有触碰 message visibility scan：其有界多轮读取服务于 delete-for-me/hide 隐私语义，优化可能需要 schema/index 设计。
- 没有重新设计 schoolQuery 或 school selector：cursor、limit、retained window、去重、debounce 和 stale guard 已足够；无 regression 就不增加复杂度。
- 没有因 `setData` 静态次数而重写页面：缺少低端真机 warning、freeze、大 payload 或重复渲染证据。
- 没有新增任何 cache、prefetch、index、依赖或 runtime。

## 10. Regression Results

| Gate | Result |
|---|---|
| JavaScript syntax（changed/new files） | PASS |
| favorite deterministic before/after benchmark | PASS |
| `verify-project.js` | PASS — 81 checks |
| Final Release Step 3A / 3B / 3C-1 / 3C-2 UX | PASS |
| Phase 19 / 20 / 21 / 23 / 24 | PASS |
| Phase 24 auth-flow / login-transaction / pair-conversation | PASS |
| Phase 25 lifecycle / hide-send race / diagnostics / rollback compatibility | PASS |
| school selection / selector pagination / school source | PASS |
| production nationwide pagination/search/cursor/invalid-input audit | PASS — 2952 records / 148 pages / 204 calls / 0 errors / 0 duplicates |
| production zero-write security probes | PASS — 18/18，counts/digests unchanged |
| production before/after invariant | PASS — 8 collection counts/hashes exact match，businessDataMutation 0 |

关键覆盖包括 canonical conversation、alias resolution、authorization、unread/visibility、appointment relationship/state、历史跨校行为、current-school product scope、filters/sorting/pagination、school cursor tamper/cross-scope/invalid input、全国重复检测与五省分页。

## 11. Production Data Integrity

所有 production 性能调用均为 allowlist 中的 read action；安全 probes 的 mutation-shaped 请求在参数/action 校验阶段被预期拒绝，并由前后 snapshot 证明零写。2026-08-29 07:08:28Z 最终 after invariant 与 06:47:13Z before snapshot 的 collection count 和 SHA-256 全等：users 8、products 72、favorites 7、conversations 26、messages 209、appointments 25、schools 2952、productViews 28 均无漂移；`businessDataMutation = 0`；PUBLIC MARKET ZERO 保持 true；schools active 2952 / pending 0 / official drift 0 / identity conflict 0；云函数远端 hash/fingerprint 不变。

本地 benchmark 使用 wx-server-sdk deterministic mock，不连接 production，`businessWrites = 0`。

## 12. Remaining Manual Tests

低端/普通真机尚未执行，以下项目明确为 **NOT EXECUTED / MANUAL**，不伪造 PASS：

- 冷启动、首页首次渲染、快速上下滑动、连续翻页；
- 学校选择连续翻页、快速输入、350ms debounce、关键词快速切换；
- 页面快速进入/退出、tab 快速切换、page stack；
- 消息列表、聊天历史翻页、收藏列表、商品详情、图片加载；
- 观察 setData warning、memory warning、console error、unhandled rejection、exception、freeze；
- 观察 duplicated request、stale UI、request race、spinner stuck；
- 特别核对收藏页第一页/下一页顺序、已下架/已售但允许展示的收藏、缺失/已删除商品过滤及取消收藏（测试环境执行，避免 production mutation）。

建议至少覆盖一台普通 Android、一台低内存 Android 和一台 iOS 真机；使用微信真机调试 performance/network 面板记录机型、基础库、网络和录屏。

## 13. Git Status

- source baseline 仍是 `main` / `e47329bde21756cbbbadc2637db5169209e01e1b`，远端 ahead/behind 为 0/0。
- 本轮工作区包含一个 production source 修改：`cloudfunctions/favoriteProduct/index.js`；以及 Step 4A benchmark/runtime scripts 和两份报告。
- 未 commit、未 push、未 tag、未部署；不自动创建 Step 4A release tag。
- production `favoriteProduct` 仍是 before snapshot 中的远端源码 hash，因此线上行为未被本轮 source diff 改变。

## 14. Final Decision

**PASS — STEP 4A COMPLETE**
