# Phase 23：生产安全、依赖与性能专项加固

> 执行日期：2026-08-09（Asia/Shanghai）
>
> 范围：生产云函数、依赖、写接口攻击面、读查询/索引/分页、ACL、云存储、日志、浏览记录留存与低风险并发性能基线。本文不启动 Phase 24，也不代表已通过微信官方审核或正式发布。

## 1. Git baseline

| 项目 | 启动时结果 |
| --- | --- |
| branch | `main` |
| HEAD | `7d9bd49c0089dfdc3d75dd2115ee37ace55d276b` |
| commit | `fix: finalize phase 22 school data governance` |
| tag at HEAD | `phase-22-complete` |
| origin | `0 ahead / 0 behind` |
| tracked working tree | clean |

Phase 23 以 Phase 22 封板点作为稳定回退基线；未移动 Phase 22 或更早标签。

## 2. 旧 Phase 23 覆盖分析

Phase 18—22 已经完成服务端同校 strict、合法 ID 跨校只读、新关系闸门、7 天换校冷却、历史关系兼容、公开数据 readiness 和无学校商品重新上架 fail-closed。本阶段没有复制这些功能，只补齐过去分散或未完成的生产专项：

- 12 个生产云函数的统一依赖、锁文件、运行时与真实配置矩阵；
- 全写入口统一伪造身份、畸形 ID、未知 action、所有权、学校、状态、重放和并发复核；
- 当前真实读查询、索引、分页和受控并发延迟基线；
- 所有业务集合 ACL、云存储、日志、错误映射、限流必要性和 `productViews` 留存策略；
- 独立 Phase 23 工具、报告、部署守卫与交接路线。

## 3. Dependency security

当前 npm registry 的 stable `wx-server-sdk` 仍为 `4.0.2`，`4.0.3-beta.1` 不是生产稳定版。12 个函数逐目录 `npm audit --omit=dev --json` 的结果一致：0 critical、5 high、1 moderate；风险均来自 `wx-server-sdk` 的传递依赖链。npm 唯一自动修复建议是把直接依赖破坏性降级至 `2.5.3`，因此未执行 `npm audit fix --force`。

| function | runtime | wx-server-sdk | ws | critical | high | moderate | 处理 |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| authUser | Nodejs16.13 | 4.0.2 | 非直接依赖 | 0 | 5 | 1 | SDK 风险接受 |
| createProduct | Nodejs16.13 | 4.0.2 | 8.21.3 | 0 | 5 | 1 | ws 补丁升级，SDK 风险接受 |
| manageProduct | Nodejs16.13 | 4.0.2 | 8.21.3 | 0 | 5 | 1 | ws 补丁升级，SDK 风险接受 |
| productQuery | Nodejs16.13 | 4.0.2 | 8.21.3 | 0 | 5 | 1 | ws 补丁升级，SDK 风险接受 |
| favoriteProduct | Nodejs18.15 | 4.0.2 | 8.21.3 | 0 | 5 | 1 | ws 补丁升级，SDK 风险接受 |
| messageAction | Nodejs18.15 | 4.0.2 | 8.21.3 | 0 | 5 | 1 | ws 补丁升级，SDK 风险接受 |
| messageQuery | Nodejs18.15 | 4.0.2 | 8.21.3 | 0 | 5 | 1 | ws 补丁升级，SDK 风险接受 |
| appointmentAction | Nodejs18.15 | 4.0.2 | 8.21.3 | 0 | 5 | 1 | ws 补丁升级，SDK 风险接受 |
| appointmentQuery | Nodejs18.15 | 4.0.2 | 8.21.3 | 0 | 5 | 1 | ws 补丁升级，SDK 风险接受 |
| productViewAction | Nodejs18.15 | 4.0.2 | 8.21.3 | 0 | 5 | 1 | ws 补丁升级，SDK 风险接受 |
| schoolQuery | Nodejs18.15 | 4.0.2 | 8.21.3 | 0 | 5 | 1 | ws 补丁升级，SDK 风险接受 |
| userQuery | Nodejs18.15 | 4.0.2 | 8.21.3 | 0 | 5 | 1 | ws 补丁升级，SDK 风险接受 |

11 个显式 `ws` 依赖从 `8.21.1` 无破坏性升级并精确固定到 `8.21.3`。所有 12 个函数分别 `npm ci --omit=dev` 后实际加载成功；根项目 `npm audit --omit=dev` 为 0 漏洞。

## 4. Accepted risks

| 风险 | 原因 | 缓解措施 | 未来触发条件 |
| --- | --- | --- | --- |
| wx-server-sdk 传递依赖 5 high / 1 moderate | stable 最高仍是 4.0.2；自动修复要求破坏性降级 2.5.3 | 所有客户端输入限长/白名单；不把任意 URL、代理配置或身份字段传给 SDK；数据库客户端直写关闭；持续 audit | stable 新版发布、官方补丁、critical 出现或发现可达利用链时立即升级/替换 |
| Nodejs16.13 / 18.15 上游版本较旧 | CloudBase 当前仍正式支持；Node20.19 是推荐稳定运行时，Node22/24 仍为公测；本阶段没有运行时缺陷证据 | 真实函数配置与回归持续核对，不为统一而全量部署 | CloudBase 下线通知、Node22/24 转稳定、SDK 完成兼容验证或出现运行时安全公告 |
| 云存储 READONLY 允许所有用户读 | 商品/头像必须跨用户展示；聊天媒体接收方不是文件创建者，直接切 PRIVATE 会破坏既有聊天 | 上传路径含不可枚举 token；聊天记录与 fileID 只经 participant 云函数返回；客户端仅创建者可写 | 支持按业务路径/参与者授权的可靠规则落地，或发现 fileID/路径枚举与泄露证据 |
| 未新增业务级通用限流集合 | 当前规模低，新增计数集合会制造额外生产写、事务热点和错误拒绝；关键写入口已有幂等/版本/事务 | CloudBase 平台限额 + action 白名单 + 参数上限 + 幂等键 + 事务；监控错误/耗时 | 单用户异常突发、持续 >20 RPS、成本/错误率异常或明确滥用事件 |

## 5. Runtime matrix

生产实时反查：12/12 均为 `Active / Available / index.main / 10s / 256MB / installDependency=TRUE`；4 个 Nodejs16.13、8 个 Nodejs18.15。CloudBase 当前文档仍列出两者为受支持环境，并把 Nodejs20.19 标为推荐、Nodejs22.21/24.11 标为公测，因此本阶段维持现状，不执行无业务收益的全函数运行时迁移。[CloudBase 运行时配置](https://docs.cloudbase.net/cli-v1/functions/configs)、[腾讯云运行环境说明](https://cloud.tencent.com/document/product/583/11060)。

## 6. Attack surface matrix

| function / actions | auth | ownership / participant | school | state | idempotency / concurrency | result |
| --- | --- | --- | --- | --- | --- | --- |
| authUser: login/current/updateProfile/selectSchool/updateSchool | WXContext | 本人确定性 user | active+valid 权威学校 | 资料/7 天冷却 | 事务、同校 no-op、schoolVersion | PASS |
| createProduct: create | WXContext | seller=本人 | 服务端用户学校 | 资料完整、字段/媒体限长 | requestId 确定性创建 | PASS |
| manageProduct: get/update/offline/relist/sold/delete/retryCleanup | WXContext | owner | 商品学校不可变；relist 权威复核 | 状态机/字段白名单 | mutationId + version + 事务 | PASS |
| favoriteProduct: status/add/remove/list | WXContext | user relation | 新建同校；历史先识别 | 公开状态 | 确定性 ID + 事务 | PASS |
| messageAction: createConversation/sendText/sendMessage/markRead | WXContext | participant | 新会话同校；历史复用 | 商品/消息类型状态 | 确定性会话、clientMessageId、事务 | PASS |
| appointmentAction: create/accept/reject/cancel/complete/retryCleanup | WXContext | buyer/seller participant | 新建同校；历史状态流保留 | 预约+商品双状态机 | request/appointment ID、事务、补偿 | PASS |
| productViewAction: recordView | WXContext | 排除 seller | 商品固定学校不作授权输入 | 仅公开计数状态 | user-product 确定性 ID、24h 事务去重 | PASS |
| product/message/appointment/user/favorite/school queries | 需要时 WXContext | owner/relation/participant/viewer | strict / viewer 权威 scope | 公开或关系状态 | 有界分页、scope cursor | PASS |

真实登录态执行 18 个生产负向探针：7 个畸形写请求携带伪造 openid/userId/schoolId，另对 11 个 action-dispatch 函数传未知 action；全部返回预期错误。前后 8 集合数量和受控投影摘要逐项一致，console error/exception 为 0/0。

## 7. Security findings

| 发现 | 严重级别 | 修复/决定 | 验证 |
| --- | --- | --- | --- |
| 11 个函数锁定的 ws 落后两个 patch | low | 升至并固定 8.21.3 | 干净安装、实际 require、线上包复核 |
| wx-server-sdk 传递漏洞且无安全 stable 修复 | high（依赖扫描） | 风险接受，禁止破坏性降级 | 12/12 audit、攻击面可达性复核 |
| 运行时混合且版本较旧 | medium | 维持平台支持版本，记录迁移触发器 | 12/12 实时配置与回归 |
| 云存储桶 READONLY | medium（隐私面） | 当前兼容性风险接受，不改 ACL | 官方语义复核、上传路径与消息权限审计 |
| 原始请求/身份/精确对象写日志 | 未发现 | 保持安全摘要日志 | 全函数 `console.*` 源码扫描 |
| auth bypass / IDOR / 跨校新增关系绕过 | 未发现 | 无业务逻辑改动 | 自动攻击回归 + 18 个生产零写入探针 |

critical 为 0；没有未处理的 high auth bypass。依赖 high 已按上节作明确风险接受。

## 8. Query / index matrix

| 查询 | scope / pagination | 生产索引 | 结论 |
| --- | --- | --- | --- |
| product list/search/category/4 sorts | school+status；HMAC scope cursor；pageSize≤20 | products 20，总计 8 个 strict 组合索引 | 命中真实查询；不新增 |
| product detail / myProducts | 合法 ID / owner+状态；有界 offset | `_id_`、seller/status | 当前规模正常 |
| seller public products | viewer school + seller + public status | `idx_seller_school_status_createdAt_id` | Phase 21 索引有效 |
| favorites | user relation；page≤100/pageSize≤20 | 4 个索引，含 user+product unique / user+time | 正常 |
| conversations/messages | participant 双路合并 / conversation cursor | conversations 5、messages 4 | 正常；无参与者泄露 |
| appointments | buyer/seller 双路合并 / cursor | 10 个索引，8 个业务索引 | 正常 |
| schools list/search | active scope / signed cursor / pageSize≤20 | 5 个索引，3 个业务索引 | 正常 |
| productViews cleanup | cleanupAfter seek | 3 个索引，含 `idx_cleanupAfter` | 清理条件已具备 |

所有查询均有 pageSize 上限；商品 strict cursor 绑定学校、action、分类、关键词摘要、排序、状态、pageSize 与快照时间，签名或 scope 错配 fail-fast。关键词正则是当前最需要持续观察的查询，但 29 件公开商品和本轮延迟下无需新增全文索引或搜索服务。

## 9. Performance

生产 DevTools 登录态只读基线参数：18 个 endpoint/action 场景，每场景 5 个 warm 样本，并发 2，共 90 个 warm 样本；0 错误、0 超时、0 console error、0 exception。`firstObservedMs` 只是观测首样本，不冒充强制冷启动。

| endpoint group | iterations | concurrency | representative p50 | p95 | max | error rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| product list：4 sorts/category/keyword/cursor | 每项 5 | 2 | 452–529ms | 467–2031ms | 2031ms | 0% |
| product detail | 5 | 2 | 409ms | 439ms | 439ms | 0% |
| auth current | 5 | 2 | 433ms | 1835ms | 1835ms | 0% |
| favorite list | 5 | 2 | 613ms | 2064ms | 2064ms | 0% |
| conversation list / message history | 每项 5 | 2 | 437–548ms | 445–2222ms | 2222ms | 0% |
| appointment list / detail | 每项 5 | 2 | 407–686ms | 543–2330ms | 2330ms | 0% |
| school list/search | 每项 5 | 2 | 349–377ms | 383–1819ms | 1819ms | 0% |
| seller profile/products | 每项 5 | 2 | 486–553ms | 563–2094ms | 2094ms | 0% |

部署后各场景 p50 的中位数为 456ms，全量最大观测 2330ms；部署前同参数基线分别为 464ms、1933ms。少量场景出现约 1.8–2.33s 的离散慢样本，但无超时、错误或索引报错，且典型 p50 保持在 349–686ms。小样本不足以证明冷启动或容量瓶颈，当前先监控，不以离散观测新增缓存或预置并发成本。

## 10. productViews cleanup decision

**deferred**。实时数据为 24 条，24/24 有 `cleanupAfter`，到期 0；确定性 user-product 单记录与 24 小时覆盖机制限制增长，`idx_cleanupAfter` 已存在，`productViewAction` 当前无触发器。

触发复核条件：出现首条到期记录、总量达到 10,000、月增长超过 10%、进入 Phase 25 RC，或存储/查询成本异常，以最先发生者为准。届时使用独立清理函数、默认 dry-run、显式环境确认、单批上限、`cleanupAfter <= now` 精确条件与前后审计；本阶段不为了 0 条到期数据增加定时生产写任务。

## 11. Cloud deployment

本阶段仅部署 package/lock 发生变化的 11 个函数：`appointmentAction`、`appointmentQuery`、`createProduct`、`favoriteProduct`、`manageProduct`、`messageAction`、`messageQuery`、`productQuery`、`productViewAction`、`schoolQuery`、`userQuery`；`authUser` 未变更且未部署。

部署后 11/11 均恢复 `Active / Available`。逐函数下载线上包复核：本地 `package.json`、`package-lock.json` 与线上包一致，实际安装 `ws 8.21.3`、`wx-server-sdk 4.0.2`；业务入口源码 hash 与本地一致。12 个函数的 runtime、handler、timeout、memory、环境变量指纹和触发器均未变化，没有全量无差别部署。

## 12. Database / ACL / index impact

- 8 个业务集合实时反查均为 `ADMINONLY`；
- 云存储为 `READONLY` 且没有 custom rule；官方语义是所有用户可读、仅创建者和管理员可写；
- 索引数量：users 2、products 20、favorites 4、conversations 5、messages 4、appointments 10、productViews 3、schools 5；
- 本阶段没有集合文档写入、迁移、fixture、删除、ACL 修改或索引增删；
- 安全探针前后 users 8、products 68、favorites 6、conversations 20、messages 144、appointments 19、productViews 24、schools 2952，受控投影一致。

## 13. Regression

部署后完整回归通过：Phase 23 133/133、Phase 22 42/42、Phase 21 64/64、Phase 20 78/78、Phase 19 49/49、Phase 18 strict market 91/91、Phase 18 school change 79/79、Phase 18 auth market 16/16、school selection 128/128、product school binding 51/51、综合项目 81/81。覆盖 Phase 18 strict/cursor、Phase 19 跨校只读与新关系拒绝、Phase 20 冷却/版本失效、Phase 21 历史关系和 viewer scope、Phase 22 未归属商品 relist fail-closed。

旧 `phase-18-final-cutover:verify` 不属于 `98.md` 的当前回归命令；其历史快照把 `products` 索引数硬编码为 19，而 Phase 22 的当前合法生产基线为 20，因此不作为 Phase 23 失败信号，也不篡改历史脚本。最终门禁另包含全部项目 JavaScript 语法、JSON 解析、依赖安装、audit、`git diff --check` 与公开文件隐私扫描。

## 14. Preview / DevTools

开发者工具已在真实登录态完成生产零写入攻击探针、性能基线和关键页面 smoke。首页/搜索/分类 strict scope 均生效，“我的发布”与 owner detail 历史学校标签兼容通过；`writesRequested=false`、`fixturesCreated=false`、console error/exception 为 0/0。

部署后真实 CLI preview 成功，主包 `487168 Byte / 475.8 KB`，无分包；二维码和 info 仅写入被忽略的本地 `tmp/`，未加入 Git 或公开报告。

## 15. Manual verification

Phase 18—22 已保留真实双账号/多账号的跨校只读、新关系拒绝、历史关系与换校边界证据。本阶段改动仅为依赖补丁与审计工具，没有改变 UI 或业务语义，因此没有再次制造双账号写入 fixture。当前真实账号完成登录态生产只读、拒绝型攻击探针与关键页面 smoke；没有创建、修改或删除测试商品、收藏、消息、预约、浏览记录或用户学校。

## 16. Total handoff document update

本地唯一总交接已在实施前改为 Phase 23 进行中，并将正式路线更新为：

```text
Phase 23 生产安全、依赖与性能专项加固
→ Phase 24 上线前 UX、兼容性与真机全量巡检
→ Phase 25 Release Candidate 与正式发布准备
```

该路线替代 `66.md` 中旧 Phase 23—25 的执行定义；旧文档只保留为历史规划。`00-项目总交接文档.md` 继续被 Git ignore，不强制加入公开仓库。

## 17. Git final

全部门禁通过后，Phase 23 以提交信息 `chore: complete phase 23 production hardening` 封板，推送 `main`，并创建、推送 annotated tag `phase-23-complete`。标签指向同一封板提交；Phase 22 及更早标签均不移动。精确提交 ID 以 Git 和本地忽略的总交接文档终态为准。

## 18. Conclusion

Phase 23 complete
