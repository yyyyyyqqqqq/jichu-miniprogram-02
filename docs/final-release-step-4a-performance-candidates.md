# Final Release Step 4A — Performance Candidates

## 审计口径

- 审计基线：`main` / `e47329bde21756cbbbadc2637db5169209e01e1b` 对应的 production release。
- 审计顺序：静态只读审计 → production 小样本零写基线 → 候选分级 → 单项 LOW 变更 → 前后测量 → 回归。
- 自动实施边界：只实施 LOW；MEDIUM 只报告；HIGH 明确 OUT OF SCOPE。
- 本轮未部署任何源码变更。production 运行时结果只代表现有已部署版本；本地确定性微基准用于隔离测量候选代码本身。

## Candidate Table

| ID | Location | Current behavior | Evidence | Risk | Expected gain | Verification method | Rollback method | Decision |
|---|---|---|---|---|---|---|---|---|
| P4A-01 | `cloudfunctions/favoriteProduct/index.js` / `listMyFavorites` | 收藏关系分页后，逐条串行读取商品文档；每页默认 6、最大 20，形成有界但明确的 N+1 read latency chain。 | production DevTools 零写基线 `favorites.list`：5 个 warm samples，p50 644ms、p95/max 747ms，且 first observed 2103ms；本地 10 条、每条 20ms 延迟的确定性 mock：before p50 257.93ms、p95 266.23ms。 | LOW | 将独立商品读取的等待链从约 O(n × read latency) 降为约 O(max read latency)，不改变查询数、字段、状态过滤、顺序和 API envelope。 | `Promise.all` 保序 mock 前后基准；`verify-project.js` 收藏事务/幂等/状态/分页/隐私回归；语法检查；完整跨阶段回归。 | 恢复原串行 `for...of` 读取块；单文件单逻辑 diff。 | **KEEP**。改为最大 20 个的有界并行读取；after p50 23.58ms（-90.86%）、p95 44.67ms（-83.22%），数量/顺序/零写不变。尚未部署 production。 |
| P4A-02 | `cloudfunctions/productQuery/index.js` / `myProducts` | owner list 的 count 与 page query 串行执行。 | production 小样本 owner page p50 429–442ms（首轮 5 samples），payload 6.6–6.8KB；没有证明 count 是主耗时。 | LOW | 理论上可隐藏一次独立 read latency。 | 需要云端可分离的 count/page timing 与等价错误语义测试。 | 恢复两个顺序 await。 | **REJECT / DEFER**。收益未被量化，且本轮坚持一次只做一个优化。 |
| P4A-03 | `cloudfunctions/userQuery/index.js` / public products | public seller products 同时需要 count 与 page data，当前存在顺序读取。 | production `seller.products` 5 warm samples：p50 589ms、p95 623ms；PUBLIC MARKET ZERO 下无法形成有代表性的公开列表分页样本。 | LOW | 理论上减少一次串行等待。 | 需要有合法公开市场样本后做只读 before/after。 | 恢复原顺序读取。 | **REJECT / DEFER**。当前数据状态不能可靠验证语义等价和收益，不制造 production fixture。 |
| P4A-04 | `cloudfunctions/appointmentQuery/index.js` / list projection | appointment list 返回的历史关系和参与方字段较多。 | production 5-sample baseline payload p95/max 15063B，为本轮核心只读接口最大 payload。 | MEDIUM | 缩小网络传输和客户端解析成本。 | 需逐页核对预约列表、聊天入口、历史跨校关系与所有客户端字段消费者。 | 恢复原 DTO projection。 | **REPORT ONLY**。字段裁剪可能改变历史关系/API contract，不在 LOW 范围。 |
| P4A-05 | `pages/chat/index.js` + appointment service | 活跃聊天轮询消息时也刷新预约状态，以保证状态及时一致。 | 静态审计确认轮询有 `pollInFlight`、页面可见性和 timer cleanup，但每轮包含预约读取。 | MEDIUM | 降低活跃聊天期间的 read 次数。 | 需真机长时聊天与预约状态实时性/状态机回归。 | 恢复当前每轮预约刷新。 | **REPORT ONLY**。降低频率会引入 freshness 语义取舍。 |
| P4A-06 | `cloudfunctions/messageQuery/index.js` / conversation visibility scan | 为 delete-for-me / hide 语义，列表可能分轮扫描并在服务端过滤；轮数已有上限。 | 静态审计确认最多 8 轮，属于有界查询；安全与隐私语义依赖该过滤。 | HIGH | 数据分布极端时可能减少数据库读取。 | 需要重新设计查询模型、索引或迁移，并完整验证参与者隐私。 | 不适用；任何方案都需独立迁移/回滚设计。 | **OUT OF SCOPE**。不可为性能削弱 visibility 规则，也不做 schema/index 变更。 |
| P4A-07 | 跨页面/跨用户/跨学校业务读取 | 当前没有全局业务 response cache。 | 没有重复请求数据证明需要缓存；身份、学校、登出和切校均是 cache invalidation 边界。 | HIGH | 仅理论收益。 | 需 scope/user/school aware 的隔离与失效证明。 | 删除缓存层并清理所有持久键。 | **OUT OF SCOPE**。禁止 speculative/global cache。 |
| P4A-08 | `cloudfunctions/schoolQuery/index.js` + `pages/school-select/index.js` | 已使用 cursor、page ≤20、retained window ≤100、约 O(window + page) 去重、350ms debounce、version/scope stale protection 与 timer cleanup。 | Step 4A production 复核 204 calls：0 error，p50 51ms、p95 61ms、max 85ms，payload p95 4214B、max 4498B；2952/148 页 duplicate/cursor duplicate 均为 0，无退化证据。 | LOW | 微小且无法可靠区分网络波动。 | 全国 2952/148 页、重复检测、搜索、五省分页、tamper/cross-scope/invalid input 零写复核。 | 不适用。 | **REJECT / NO CHANGE**。当前机制足够高效，不为数毫秒增加复杂度。 |
| P4A-09 | Mini Program pages 的 `setData` 与生命周期请求 | chat/publish/detail 等页面 `setData` 调用较多，但均分散于用户事件、异步状态或分页阶段；关键列表已合并主更新并有 stale guard。 | 静态计数最高为 chat 35、publish 20、detail 18；DevTools baseline 无 console error/exception，尚无低端真机 warning、freeze 或大 payload 证据。 | LOW | 未量化。 | 低端/普通真机 performance panel、setData/memory warning、快速切页和滚动观察。 | 恢复任何局部合并。 | **REJECT / DEFER**。不能因“看到 setData”就认定为热点；等待真机证据。 |

## 已实施 LOW 项的语义边界

P4A-01 只并行化同一页内彼此独立的商品文档读取：

- 关系查询、排序、offset、limit、total 与 `hasMore` 算法不变；
- `Promise.all` 的结果顺序与输入关系顺序一致；
- 缺失商品和非允许状态的过滤规则不变；
- `toFavoriteProduct` 白名单 projection 不变；
- 身份来源、authorization、school、ownership、mutation transaction 均未触碰；
- 最大并行数仍受 `MAX_PAGE_SIZE = 20` 约束；
- 没有缓存、prefetch、schema、index、permission、runtime 或 dependency 变化。
