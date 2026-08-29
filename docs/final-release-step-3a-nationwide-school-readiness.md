# Final Release Step 3A — Nationwide School Readiness

日期：2026-08-25
范围：全国学校选择器完善、staging 全国数据验证、production 只读复核
最终结论：**READY FOR STEP 3A MANUAL ACCEPTANCE**

## A. Baseline

- production 与 staging 环境 ID 经私有目标注册表确认不同，所有日志只输出掩码。
- 客户端活动目标在本轮结束时仍为 production；staging 写操作通过专用的显式 staging gate、目标掩码确认和只允许 staging 的工具执行。
- production 最新只读学校状态：total 2952、active 2、pending 2950；官方字段 drift 0、identity conflict 0、missing 0、extra 0。
- production 最新只读商品状态：total 72、offline 57、sold 12、deleted 3；available 0、reserved 0。
- production `PUBLIC MARKET ZERO=true`：全局公开、首页、分类、搜索、卖家公开商品均为 0；关系读取失败均为 0。
- 本轮 production school/product 写入 0，production deploy 0，商品创建 0；未 commit、push、tag 或微信发布。

## B. School data checksum

- 不可变 XLS：`list of universities.xls`
- XLS SHA-256：`a0ceb41a15f335c0adfb2d0239137b879b1c58d1b57a322d3e1794866de7d09c`
- normalized JSON：`data/schools/generated/schools.normalized.json`
- normalized SHA-256：`cf69adbecbeda6d7de3150a8fc19616bd09c2d9cdc2d0fac5e90d55ae2a2fcd3`
- XLS 重新解析、规范化输出与磁盘 JSON 逐条完全相等。
- records 2952；duplicate ID 0；duplicate officialCode 0；duplicate normalized name 0；P0 0；P1 0；必填缺失 0。
- normalized JSON 未被手工修改。

## C. Client blocker

原 `pages/school-select` 每次只请求 20 条，并丢弃 `nextCursor` 与 `hasMore`，全国开放后只能默认浏览首 20 所。服务层和后端已具备基础游标/省份参数，因此本轮阻塞点主要位于页面状态管理与发现 UX。

## D. Client implementation

- 默认和搜索均固定 `pageSize=20`，保存并消费 `nextCursor`/`hasMore`。
- 支持“加载更多”和 `onReachBottom`，同时有 loading-more lock。
- 使用 ID Map 合并，重复学校不会进入列表。
- 使用 request version 与 query scope 双校验；旧关键词、旧省份和卸载后的响应不能覆盖新结果。
- 浏览、搜索和省份切换都会重置游标集合，普通浏览与搜索游标不混用。
- 重复游标、空游标但 `hasMore=true`、游标不前进均失败关闭。
- 客户端最多保留最近 100 条学校 DTO；继续浏览时释放更早窗口，并提示使用搜索/省份快速定位。
- 错误分为首屏 error 与追加页 error；追加失败不清空已加载结果。

## E. Pagination

- 后端为 seek cursor：`nameNormalized ASC, _id ASC`，未使用 skip 深分页。
- 页大小默认 20、上限 20，查询取 `pageSize+1` 判断末页。
- 远端 staging 全国实际遍历：2952 条、148 页、首屏 20 条。
- 全链路重复 ID 0；游标重复 0；最后一页 `hasMore=false` 且 `nextCursor=''`。
- 同一合法游标重复请求返回确定性相同页；客户端阻止同一游标重复追加。

## F. Search

- 语义明确为 `nameNormalized` 前缀，或 10 位 `officialCode` 精确匹配；不是 substring。
- debounce 为 350ms；空关键词恢复普通分页；stale response 被 version/scope 丢弃。
- staging 远端结果：北京 61、上海 64、浙江 57、财经 0、工程 0、清华大学 1、officialCode `4111010003` 1、不存在关键词 0。
- “财经”和“工程”为 0 是符合当前 prefix 语义的正确结果，不声明 substring PASS。

## G. Province filter

- 页面提供简单 selector，包含“全部地区”和 31 个省级地区。
- province、province+cursor、province+search 均传给服务端查询，不在前端过滤全国数组。
- staging 远端完整分页：北京市 92/5 页、上海市 69/4 页、浙江省 111/6 页、广东省 167/9 页、四川省 146/8 页。
- 北京市 + “北京”组合查询为 58/3 页。
- city 字段存在，但当前后端没有 city query/index。省份 + 前缀搜索已满足全国发现的最小必要能力；city 筛选列为 future enhancement，本轮不扩 production schema/index。

## H. Staging 2952 activation

- 初始 staging：total 2、active 2。
- import dry-run：精确计划 insert pending 2950，product writes 0，production writes 0。
- 受控导入完成：insert 2950；全量读回 total 2952、active 2、pending 2950，官方字段完全一致。
- activation dry-run：精确计划 2950。
- 受控激活完成：每批最多 20 个锁定 ID，条件要求 `officialStatus=valid && platformStatus=pending`，无 upsert。
- 最终 staging：total 2952、active 2952、pending 0；would insert 0、would activate 0；官方字段完全一致。
- 两个所需复合索引已在 staging 创建并读回：
  - `idx_school_active_name_id`：platformStatus、officialStatus、nameNormalized、_id
  - `idx_school_active_province_name_id`：platformStatus、officialStatus、province、nameNormalized、_id
- `idx_officialCode_unique` 保持有效。
- import/activation 工具锁定 staging、2952、双 checksum、batch cap、dry-run、幂等重算、最终审计，并明确拒绝 production。

## I. School selection tests

- `verify-school-selection.js`：128 checks PASS，覆盖选择入口、active-only、确认、错误、AuthStore 绑定、服务端权威状态与 school-required 路由。
- 新增页面运行时专项：5 groups PASS，覆盖追加去重、末页、100 条窗口、stale reset、loading lock、重复游标和 province 服务端参数。
- 非首 20 所的可发现性已由真实 148 页遍历、搜索和省份分页验证。
- staging 真机/开发者工具中的首次选择、搜索后选择、省份后选择、冷启动恢复、profile 与首页市场切换保留为 owner 手工验收项；未在当前 production 目标的开发者工具会话中伪装成已通过。

## J. School change/cooldown

- Phase 18 school change：79 checks PASS。
- Phase 20 cooldown：78 checks PASS，覆盖 A→B、服务端权威更新、`7×24h`、服务端时间、同校、非法/不存在/非 active 学校、冷却期绕过拒绝与冷却后恢复。
- Phase 24 auth flow：71 checks PASS；login transaction：35 checks PASS。
- staging 真机的倒计时展示、重启后提示与真实测试账号切换保留为人工验收，不据静态代码宣称真机 PASS。

## K. Cross-school regression

- Phase 19：49 checks PASS（跨校详情与关系）。
- Phase 21：64 checks PASS（历史 favorites、conversation、messages、appointments、seller profile、product detail 与新关系当前学校边界）。
- Phase 24 pair conversation：52 assertions/scenarios PASS。
- Step 2B production 只读审计再次确认 favorite/conversation/message/appointment/productView 关系读取失败全部为 0。

## L. Performance

- staging 真实 `schoolQuery`：208 次调用；远端执行时间 min 1ms、p50 55ms、p95 68ms、max 129ms。
- 真实最大响应体 4498 bytes，p95 4214 bytes；云函数最大内存采样 36,651,008 bytes。
- 估算学校 DTO：20 条 3846 bytes、100 条 19,055 bytes；2952 条约 567,698 bytes，但客户端不会构造或 setData 该全量数组。
- 合并每页最多扫描 100 retained + 20 incoming，Map 去重，单次成本 O(window + page)，没有随 2952 增长的 O(n²) 路径。
- debounce 350ms；首屏一次 setData、每页一次主要 setData；快速关键词/省份切换依靠 version + scope 防竞态。
- 低端真机尚未自动执行；报告只给出 payload、retained count、setData 上界和 staging 延迟，不宣称“低端机一定不卡”。

## M. Backend query validation

- `schoolQuery` 只返回 `platformStatus=active && officialStatus=valid`，公开 DTO 不暴露 officialCode/sourceRow/authority 等内部字段。
- cursor payload 含版本、排序键、ID、province、keyword，并使用 `SCHOOL_QUERY_CURSOR_HMAC_SECRET` 做 HMAC-SHA256 签名。
- 使用 timing-safe signature compare；篡改游标和跨 province/scope 游标均在 staging 真实调用中被拒绝。
- staging secret 由私有 staging secret 做 domain-separated derivation，部署日志仅输出 fingerprint；远端环境变量、源码 hash、依赖包均与本地一致。
- pageSize 21、非法 province、空 keyword、41 字符 keyword、损坏 cursor 均被拒绝。
- officialCode 精确查询、前缀转义、province+prefix、末页和重复游标确定性均 PASS。
- production 未部署该后端变更；未来 Step 3B 部署前必须先配置 production 专用 school cursor secret。

## N. Full regression

PASS：

- Phase 18 school scoped 91；school change 79；auth market 16；data migration 26；explicit logout 28；final cutover 48。
- Phase 19 49；Phase 20 78；Phase 21 64；Phase 22 42；Phase 22A 6 groups；Phase 22B 19；Phase 23 133。
- Phase 24 first round 88；auth flow 71；login transaction 35；pair conversation 52。
- Phase 25 lifecycle 67；hide/send race 899；attempt diagnostics 69；rollback compatibility 35。
- School data 5 groups；school selection 128；Step 3A static/gate verification；selector pagination 5 groups。
- Project verification 81 checks；JSON/WXML/JS、依赖、隐私、安全、cloud boundary 均 PASS。
- `git diff --check` PASS。

Phase 18 final-cutover 的历史断言已按已批准的 Step 2B 基线更新：产品索引从旧硬编码 19 改为当前 20，并要求 `idx_seller_school_status_createdAt_id`；旧的“A/B 必须有公开商品”改为 `PUBLIC MARKET ZERO`。更新后 48 checks PASS。

## O. Production activation dry-run plan

当前 production：

```text
schools total = 2952
active = 2
pending = 2950
```

未来 Step 3B 目标：

```text
schools total = 2952
active = 2952
pending = 0
```

Step 3B 必须另行获得 owner 授权，并按以下顺序执行：

1. 只读 snapshot：2952 个 ID、official fields、platform status、引用计数、索引和函数版本，生成私有 checksum。
2. 重新从不可变 XLS 构建 normalized，锁定 count 2952、两个 SHA-256、官方字段 diff 0、extra/missing/conflict 0。
3. 先部署并验证 production 专用签名游标 secret、schoolQuery 与所需索引；不得复用 staging secret。
4. activation dry-run 必须精确得到 pending→active 2950、其他 mutation 0、product mutation 0。
5. 每批最多 20 个显式锁定 ID，前置条件为 official valid + pending；无 upsert；操作 ID、服务端时间与已完成批次可恢复。
6. 每批失败即停止；重新读取数据库状态计算剩余项，禁止盲目重放。
7. post-audit：total 2952、active 2952、pending 0、官方字段 checksum 一致、selector 全分页/search/province smoke PASS、public visible products 0。
8. rollback：保留 activation 前 ID/status snapshot。若尚无新增学校用户引用，可用相同 ID 集合和条件将本轮 active 恢复 pending；若已有用户/关系引用，禁止盲目停用，应先关闭新增选择入口并保留历史读取，再由 owner 审批逐校处置。

本轮没有执行上述 production activation。

## P. Remaining blockers

- 自动化/数据/后端 staging 阻塞项：无。
- production rollout：按计划未授权、未执行，属于未来 Step 3B，不是 Step 3A 手工验收阻塞。
- owner 手工验收尚未完成：staging 开发者工具/真机首次选择、搜索选择、省份选择、冷启动恢复、真实 A→B/cooldown、跨校历史页面和低端设备体验。
- city filter 为 future enhancement，不阻塞当前 province + prefix discovery。

## Q. Manual acceptance checklist

1. 明确切换微信开发者工具到 staging，并确认界面显示/日志目标掩码与 production 不同；验收后恢复 production。
2. 新账号默认浏览首屏 20 条，连续加载 5 页，确认无重复、无明显跳帧、按钮/触底锁有效。
3. 连续浏览到非首 20 所并选择；冷启动后 profile 和首页学校一致。
4. 搜索“北京”“上海”“浙江”“财经”“工程”“清华大学”、`4111010003` 和不存在关键词；确认 prefix 语义及空搜索恢复浏览。
5. 切换北京、上海、浙江、广东、四川和全部地区；验证 province 分页、切换中快速输入不会回写旧结果。
6. 分别通过搜索和省份列表选择学校，确认服务端返回的权威 name/id 被保存。
7. 使用 staging 测试账号执行 A→B；确认服务端时间、7×24h 冷却、重启后仍锁定、提示/倒计时正确，客户端不能绕过。
8. A→B 后检查旧 favorites、conversation、messages、appointments、seller profile、历史 product detail；新关系必须遵守当前 B 学校边界。
9. 在低端真机快速输入、快速切省、重复进出页面、连续加载；观察内存、setData warning、页面冻结、控制台 error/exception。
10. 确认 staging 和 production 都没有因学校开放而新增商品；production 公开商品仍为 0。

**READY FOR STEP 3A MANUAL ACCEPTANCE**
