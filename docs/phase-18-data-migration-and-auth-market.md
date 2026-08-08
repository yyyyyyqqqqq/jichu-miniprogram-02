# 第十八阶段第五轮修复：数据迁移与强制登录市场

执行日期：2026-08-07。项目所有者已明确授权采用“校园市场强制登录”，并将 4 个缺学校 active 用户及 20 件缺学校公开历史业务商品统一归入“上海工程技术大学”。完整对象 ID 和迁移前后证据仅保存在受 `.gitignore` 保护的 `tmp/phase-18-data-migration-private.json`；公开文档不记录 OPENID、HMAC 或完整内部 ID。

## 1. 结论

- 4 个缺学校 active 用户迁移成功，4/4 变更、0 失败；幂等重跑 0 写入。
- 20 件公开历史业务商品迁移成功，20/20 变更、0 失败；幂等重跑 0 写入。
- 迁移后 active 用户有效学校为 7/7，公开业务商品 strict-ready 为 28/28，两个数据硬阻断均已解除。
- 方案 A 已落实：客户端匿名、资料未完成、未选校或学校不可用时不请求商品列表；服务端主动校验认证、资料和权威学校，不依赖匿名偶然进入 strict 后报错。
- 非 allowlist 且状态完整的登录用户在当前迁移期仍走 legacy；allowlist 1 人继续 strict。strict-for-all 未开启、allowlist 未扩大、legacy 未删除。
- 跨当前学校的 offline 历史商品禁止直接重新上架，服务端返回 `PRODUCT_SCHOOL_MISMATCH`；查看、编辑非学校字段、保持下架和删除不受影响。
- 换校冷却本轮未实现。现有多次测试换校历史不适合直接套用 30 天冷却，留待设置明确策略生效时间后独立实施。

## 2. 迁移前审计与权威学校

开始前 readiness 双快照：users 7、active 7、资料有效 7、有效学校 3、缺学校 4；排除 20 件 Phase 18 夹具后，业务商品 44、公开 28、strict-ready 8、not-ready 20。查询前后集合计数和投影哈希一致，写 API 调用为 0。

目标学校从真实 `schools` 集合按完整名称唯一解析：

| 字段 | 结果 |
|---|---|
| 名称 | 上海工程技术大学 |
| schoolId | `s_e5ca12***b898` |
| platformStatus | active |
| officialStatus | valid |
| 匹配记录 | 1 |

学校 ID 未手写或根据用户当前学校推导。

## 3. 安全工具与 dry-run

新增 `migrate-phase-18-missing-user-schools.js`、`migrate-phase-22b-public-product-schools.js` 和共享核心。两个工具默认 dry-run，必须显式传入脱敏环境确认值；正式写入还必须增加 `--apply`，并复用 dry-run 写入私密文件的精确 ID 清单。

用户 dry-run 为 expected 4 / actual 4。商品 dry-run 最终为 expected 20 / actual 20；期间详细快照查询两次被门禁提前拦截，分别暴露 CloudBase `$in` 结果重复和历史 legacy 商品 ID 格式差异，均未发生数据库写入。最终使用只读全量投影后在本地按精确清单取交集，正式写入仍使用逐对象精确条件。

所有 UPDATE 均为 `multi=false / upsert=false`，每批最多 4 项。数量、目标学校、对象状态、原学校或受保护字段任一变化都会停止。

## 4. 用户迁移

仅处理 4 个 `status=active` 且学校状态为 missing 的精确用户。写入字段：权威 `schoolId/schoolName`、`schoolVersion=1`、服务端 `schoolUpdatedAt/updatedAt`。未生成 `schoolSelectedAt`，也未写迁移审计业务字段。

昵称、头像、资料完成状态、账户状态、创建时间和已有 `schoolSelectedAt` 纳入受保护指纹；OPENID 不读取到报告、不写入私密文件。写后 4 个用户逐条回读，学校和版本正确，受保护指纹一致；第二次 apply 为 changed 0 / skipped 4 / failed 0。

## 5. 商品迁移

仅处理 `available/reserved`、非 Phase 18 前缀、公开业务商品且学校状态 missing 的 20 个精确对象。写入字段只有权威 `schoolId/schoolName` 和服务端 `updatedAt`。

正式条件同时锁定 `_id`、标题、卖家、状态、价格和原空学校。状态、卖家、价格、标题和创建时间纳入受保护指纹；写后逐条一致。第二次 apply 为 changed 0 / skipped 20 / failed 0。

20 件 Phase 18 灰度夹具继续全部 offline，没有恢复、删除或迁校；其无学校 N-01 仍保持原状。sold、offline、deleted 和其余非授权商品均未进入本轮迁移。

## 6. 方案 A 与当前灰度语义

首页的 `AuthGuard.requireMarketAccess` 现在对匿名、资料未完成、学校缺失和学校不可用均返回禁止，首页显示对应 guide 且不调用商品 list；登录引导文案为“登录后查看你的校园二手市场”。按钮再进入登录、完善资料或选校流程。

`productQuery/list` 新增独立的 `MARKET_ACCESS_REQUIRES_AUTH=true` 策略层。该层在模式决策前解析真实微信身份、用户资料和权威学校：匿名返回 `AUTH_REQUIRED`，资料不完整、缺学校或学校不可用分别 fail-closed。身份完整后再进入当前灰度决策：allowlist 用户 strict，非 allowlist 登录用户迁移期 legacy。客户端提交模式、学校或身份字段仍无效。

回滚 dry-run 已扩展为目标 `enabled=false / strictForAll=false / accessRequiresAuth=false / allowlist=[]`，仍不删除索引、HMAC、学校字段或 `authUser/updateSchool`。

## 7. 跨校旧商品重新上架

`manageProduct/relist` 在事务内读取商品卖家对应的权威当前用户。商品学校无效、用户无效、身份不匹配或当前用户学校与商品学校不同时返回 `PRODUCT_SCHOOL_MISMATCH`，不更新状态、版本或学校。

DevTools 使用当前 A 校真实账号选择本人 B 校 offline 商品调用 relist，云端真实返回该错误；随后 `myProducts` 反查商品仍为 offline 且学校不变。同校重上架由自动测试通过。

## 8. 迁移后 readiness 与真实验证

迁移后独立 readiness 双快照：users total/active/valid school 为 7/7/7，missing 0；业务公开商品 28，strict-ready 28，not-ready 0，就绪率 100%。全部商品仍为 64，状态为 available 28、reserved 0、offline 22、sold 11、deleted 3。全量商品仍有 16 件非公开历史记录缺学校，但它们不属于本轮授权的公开市场集合，也不构成当前 strict 市场阻断。

真实 DevTools 当前账号位于目标学校。目标学校 strict 市场实际有 27 件公开商品，其中 20 件迁移商品全部出现且无跨校记录；四排序首屏、cursor 加载更多、分类、搜索、详情、我的发布、修改学校入口和重启恢复均通过，新增 console error/exception 为 0/0。

真实匿名、第二非 allowlist 微信身份和真机仍不可用，明确标记未执行；匿名/不完整资料/无学校/无效学校的服务端与客户端自动验证已通过。

## 9. 云端、权限与配置

本轮修改 `users` 4 条、`products` 20 条。只部署 `productQuery` 和 `manageProduct`；部署后二者以及未重部署的 `authUser` 均为 Active / Nodejs16.13 / index.main / 10 秒 / 256 MB，线上/本地入口哈希一致。

HMAC 存在且长度合格，`PRODUCT_SEED_ENABLED=false`；总开关 true、strict-for-all false、allowlist 1、认证市场策略 true。19 个索引保持不变；未修改 users/products/schools ACL、任何索引、环境变量、学校状态或其他集合。

## 10. 自动验证与 Git

新增专项：数据迁移 26 项、Phase 22B 19 项、认证市场和跨校重上架 16 项。既有换校 75 项、选校 128 项、商品学校绑定 51 项、Phase 18 91 项、canary 28 项、readiness 25 项、夹具 15 项、Phase 22A 6 组、孤立复核 7 组、修复 8 组、preflight 10 组、综合 81 项全部通过，`git diff --check` 通过。

Git 仍为 `main` / `c1cf7a6` / `phase-17-complete` / ahead-behind 0/0。工作区仍混合 Phase 18 与 Phase 22A/22B 内容；未暂存、commit、push 或创建标签。

## 11. 当前判定与下一步

本轮已解除第五轮发现的三个硬阻断：正式产品策略确定并落实为强制登录，active 用户学校覆盖 100%，公开业务商品 strict-ready 100%。因此当前判定为：**第十八阶段可以进入最终切换评审**。

下一步只能是“第十八阶段最终轮：多账号/真机补验 + 扩大灰度 + 正式切换授权评审 + Git 封版”。本轮不自行开启 strict-for-all、不扩大 allowlist、不删除 legacy，也不创建 `phase-18-complete`。

## 12. 最终切换完成补记（2026-08-09）

最终轮已经完成本节所列下一步：强制登录保持开启，strict-for-all 开启，allowlist 清空；账号 A/B 真机、第三既有用户、双校隔离、跨校游标拒绝、换校、发布/下架和显式退出均通过。随后真实部署 legacy 配置并完成回归，再只部署 `productQuery` 恢复最终配置，线上哈希恢复为 `3a2b960ce1c59102f470a7161d263a2c86f7089d27bed3a5c2e0c3d3d753cb89`。完整记录见 `docs/phase-18-final-cutover.md`。
