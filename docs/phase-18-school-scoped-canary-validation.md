# 第十八阶段第四轮：单账号同校市场灰度验收

验收日期：2026-08-06。目标环境公开记录为 `cloud1***6d8e`；所有用户、学校、商品完整 ID 只保存在受 `.gitignore` 保护的 `tmp/phase-18-school-scoped-canary-private.json`。本文不记录 OPENID、HMAC 值或完整内部 ID。

## 1. 结论与最终配置

受控夹具、单账号 strict、A/B 隔离、四排序、多页 seek cursor、分类、关键词、游标篡改/参数/学校绑定、两次 UI 换校、首页刷新和重启恢复均通过。未发现跨校泄露、自动 legacy 回退、索引错误、控制台 error 或运行时 exception，因此最终决定为：**保留单账号受控灰度**。

当前配置为：总开关 `true`、strict-for-all `false`、固定 allowlist 1 个脱敏内部用户 `u_1d3dc1***962f`。`productQuery` 为 `Active / Nodejs16.13 / index.main / 10 秒 / 256 MB`，只部署了该函数；线上/本地 `index.js` SHA-256 均为 `e1e71e01e94666815c552b7b7fa4fd9f7b62c095b8a4c0e37a311357f8c9f381`。部署后下载的 `index.js`、`market-core.js`、`package.json`、`package-lock.json` 四项哈希全部一致。HMAC 存在且长度合格，`PRODUCT_SEED_ENABLED` 原值保持，二者值均未输出或落盘。

本轮核心 strict 验收完成，但“第四轮全部完成标准”仍有一个身份条件未闭环：没有第二套微信身份，无法做灰度开启后的真实匿名/非 allowlist 登录请求。CloudBase CLI/SCF 管理调用实际复用了受控微信身份并返回 strict，因此不冒充匿名结果。自动模式决策确认空身份和非目标内部用户均为 legacy，真实第二身份明确记为未执行。

## 2. Git 与开始前基线

- 分支 `main`，HEAD `c1cf7a6`，HEAD 标签 `phase-17-complete`，相对 `origin/main` ahead/behind 为 0/0。
- 开始前已有阶段 18、22A 和第三轮换校的未提交修改；未暂存、无冲突，私密第三轮文件存在且受忽略。
- 开始前线上 `productQuery` 和本地哈希一致，总开关/strict-for-all/allowlist 为 `false/false/0`；`authUser` 含已部署的 `updateSchool`。
- 没有 reset、clean、checkout、暂存、commit、push 或移动标签。

## 3. 受控测试数据

所有 20 件商品均先通过真实 `createProduct` 创建，客户端同时提交伪造学校字段，回读证明学校仍由服务端当前用户和权威学校绑定。随后只对精确的本轮商品 ID、卖家和标题执行非 multi、非 upsert 的管理员更新，以构造状态、计数和时间边界；未修改既有商品。首次批量回写因 CLI 命令过长失败，20 次创建已成功；修正为每批 4 条后重跑全部命中确定性 requestId 幂等复用，没有重复商品。

| 学校 | 公开 | available | reserved | 非公开 | 分类数 | 关键词样本 | 同价格/热度边界 |
|---|---:|---:|---:|---:|---:|---:|---|
| A | 12 | 11 | 1 | 1 offline | 2 | 13 | 价格 10/20/30 多组；7 件 favorite=9、view=90 且时间相同 |
| B | 5 | 4 | 1 | 1 offline | 2 | 6 | 与 A 共享分类和 10/20/30 价格边界 |
| 无学校 | 0 | 1 条仅供 legacy 存在性验证 | 0 | strict 下排除 | 1 | 1 | 先由 B 权威绑定，再仅对该夹具清除学校字段 |

`A-01…A-13`、`B-01…B-06` 和 `N-01` 均使用“阶段18同校灰度”前缀。创建默认值为 available、favorite/view=0、version=1、createdAt=serverDate；更新后逐件字段保存在私密文件。原始 serverDate 在更新前未持久化快照，私密文件已明确标为“原精确值未保留”，不伪造该值。

## 4. 模式与隔离

| 场景 | 结果 |
|---|---|
| 目标账号 B | 真实返回 `schoolScoped`，权威 scope=B，`page/total=null` |
| 目标账号 A | UI 换校后真实返回 `schoolScoped`，权威 scope=A |
| 空身份、非目标身份 | 服务端模式决策自动测试为 legacy；灰度后真实第二身份未执行 |
| 客户端伪造参数 | 请求边界与自动测试通过；服务端不采用 marketMode、schoolId 或 allowlist 字段 |
| A/B 跨校 | A 列表无 B，B 列表无 A |
| 无学校/非公开 | 两校 strict 列表均为 0 |
| strict 失败 | 篡改和错配均返回 `INVALID_CURSOR_SCOPE`，无第一页、无 legacy 重试 |

真实 B 首次关键词分页返回 `hasMore=true` 和非空 cursor；两页合并为 5 个公开 B 夹具且无重复/遗漏。A 的 12 个公开夹具和 books 分类 8 个夹具均完成多页遍历，无跨校、无学校或非公开混入。

## 5. 四排序、分类与搜索

| 查询 | 首屏/续页 | 顺序与边界 | 重复/遗漏/混校 | 首屏样本耗时 |
|---|---|---|---|---:|
| 综合 | pageSize=4，真实 3 页 | favorite DESC、view DESC、createdAt DESC、ID ASC | 0/0/0 | 488/523/454 ms |
| 最新 | pageSize=4，真实 3 页 | createdAt DESC、ID ASC | 0/0/0 | 517/484/484 ms |
| 价格升序 | pageSize=4，真实 3 页 | price ASC、createdAt DESC、ID ASC | 0/0/0 | 534/499/468 ms |
| 价格降序 | pageSize=4，真实 3 页 | price DESC、createdAt DESC、ID ASC | 0/0/0 | 455/526/430 ms |
| books 分类 | pageSize=5，两页 | 8 件 A books | 0/0/0 | 484/520 ms |
| 统一关键词 | 四排序均使用该关键词并真实续页 | 12 件 A 公开夹具 | 0/0/0 | 见四排序样本 |

33 次受控云调用耗时为 385–534 ms，中位 474 ms，无超时。索引执行计划/扫描量无法由当前接口确认；只能确认 19 个索引仍存在，其中 8 个同校索引名称与方向齐全，查询没有索引错误。正则关键词的执行计划与规模化性能仍是风险。

## 6. HMAC cursor 与失败策略

- 正常 B 两页、A 三页及分类两页均通过，续页没有回第一页。
- 修改签名字符、sort、category、pageSize、学校 scope 均真实返回 `INVALID_CURSOR_SCOPE`。
- B cursor 在 B→A 后拒绝，A cursor 在 A→B 后拒绝；均未返回任一学校第一页。
- cursor 可见 JSON 只含关键词摘要，不含测试关键词明文；完整 cursor 未写入公开文档。
- keyword 修改/清空、action、额外字段、版本、非法时间、超长、过期和未来容差由 91 项本地专项覆盖；其中 24 小时过期与未来时间不是云端等待实测。
- HMAC 缺失、学校无效和查询异常的 fail-closed 由测试桩覆盖；没有为了验证而删除索引、清空密钥或破坏用户学校。

## 7. 换校、页面与开发者工具

B→A 和 A→B 均通过第三轮真实 UI 二次确认完成，`schoolVersion` 两次递增，最终账号回到 B。跨校旧 cursor 均被拒绝。首页重新编译后确认：`marketMode=schoolScoped`、scope=B、`page/total=null`、列表无混校；下拉刷新、详情、我的发布、重启恢复均通过。

页面验收期间发现首页曾用 `result.page || 1` 把 strict 的 null 变成 1，服务端响应无误但页面语义不符。本轮将 strict 分支显式保留 null，并在开发者工具完全关闭/重开重新编译后复验通过。requestVersion、AuthStore 作用域失效和旧响应丢弃继续由既有 91/75 项专项覆盖；本轮未通过人为慢网制造真实竞态。

开发者工具：通过；console error=0、exception=0。warning 未由自动监听器单独计数，未据此声称 0。真机与视觉截图：未执行。

## 8. 匿名与普通业务回归边界

- 灰度前第二轮已完成真实 legacy 回归；灰度后空身份/非目标模式决策、客户端请求形状和不接受伪造字段由自动测试通过。
- 灰度后没有第二套真实微信身份。管理 CLI/SCF 调用命中了 allowlist 身份并返回 strict，不计作匿名。因此匿名 list、匿名四排序/分类/搜索及非目标真实登录均标记“未执行”。
- 目标账号下详情、我的发布、发布绑定、登录恢复和修改学校通过；收藏、聊天、会话、预约没有做跨校行为验证。

## 9. 自动验证

- 换校 75 项；选校 126 项；商品学校绑定 51 项；Phase 18 91 项；canary 28 项。
- Phase 22A 6 组；孤立复核 7 组；孤立修复 8 组；preflight 10 组。
- `npm run verify` 81 项，包含 JavaScript 语法、JSON 解析、模块加载、隐私和结构检查；`git diff --check` 通过。
- 真实 DevTools canary 通过，33 次云调用，无 console error/exception。

## 10. 云端、文件与回滚

- 只部署 `productQuery`；`authUser` 未重部署且保持 Active、线上/本地哈希一致。
- 未修改环境变量值，HMAC 和种子开关原样保留；未修改权限，`products` ACL 仍为 `ADMINONLY`。
- 创建 20 件本轮夹具；只修改这些夹具的排序/状态字段，N-01 例外清除学校字段；没有修改其他用户、其他历史商品、学校状态、索引、收藏、聊天、会话或预约。
- 未发生回滚。回滚工具要求先用补丁将总开关改回 false 并清空 allowlist，再显式确认目标部署。
- 云函数：`productQuery/index.js`。页面：`pages/home/index.js`。工具：canary core、夹具、部署、回滚、静态验证和 DevTools 验证脚本；`package.json` 增加命令；三份既有文档和本文更新；私密结果文件受忽略。

## 11. 未执行、风险与下一步

未开启 strict-for-all、未扩大 allowlist、未正式切换、未删除 legacy、未执行双账号并发或真机、未验证跨校聊天/收藏/预约、未执行阶段 22B、未提交/推送/移动标签。

单账号换校不等于双账号同时在线；真实匿名/非目标身份尚缺；正则执行计划未知；snapshotAt 不是事务快照；24 小时游标过期仍仅本地验证；换校没有冷却；历史商品可跨当前学校继续管理；云 SDK 依赖审计风险仍在；正式切换回滚窗口仍需评审。

下一步建议为“第十八阶段正式开发第五轮：灰度收尾、真机验收、换校策略与正式切换方案评审”，优先补第二微信身份的 legacy 验收和真机。不得自行扩大灰度或进入阶段 22B。

## 12. 第五轮收口更新（2026-08-07）

用户确认第四轮人工验收通过。第五轮按精确私密清单将 20 件灰度夹具全部收口为 offline：18 件发生状态变化、2 件原本 offline，重复执行为 0 变化；没有删除夹具、修改学校或影响其他商品，也没有 active 预约阻挡。夹具保留供未来受控回归。

当前测试账号在后续受控操作后最终为 A 校、`schoolVersion=31`。开发者工具再次确认首页 strict 成功、个人页学校绑定、修改学校页当前校标记，以及 `myProducts` 同时包含 A/B/无学校历史记录。真实匿名、非 allowlist 身份和真机仍因没有第二微信身份/可用设备标为未执行。

只读线上就绪审计显示：7 个 active 用户只有 3 个有效学校；排除夹具后 28 件公开业务商品只有 8 件严格就绪、20 件缺少有效学校。因此第五轮结论为“不扩大灰度、不切 strict-for-all、第十八阶段暂不能完成”。完整报告见 `docs/phase-18-final-readiness-review.md`。

## 13. 第五轮修复/补验更新（2026-08-07）

`87.md` 已授权并完成 4 个缺学校 active 用户和 20 件缺学校公开业务商品的定向迁移，迁移后 readiness 为用户 7/7、公开业务商品 28/28。20 件 Phase 18 专用夹具继续全部 offline，没有恢复、删除或迁校。

当前 allowlist 真实账号位于目标 A 校。部署后 DevTools 验证目标校 strict 市场实际 27 件公开商品，20 件迁移商品全部出现；四排序、续页、分类、搜索、详情、我的发布、修改学校入口和重启通过。使用本人 B 校 offline 商品真实调用 relist 返回 `PRODUCT_SCHOOL_MISMATCH`，商品状态和学校保持；console error/exception 为 0/0。

总开关仍 true、strict-for-all false、allowlist 1；新增认证市场策略为 true。真实第二身份和真机仍未执行，不扩大灰度。完整记录见 `docs/phase-18-data-migration-and-auth-market.md`。

## 14. 从单账号灰度到全量 strict（2026-08-09）

最终轮已删除生产 rollout 中的旧身份哈希，allowlist 为空并开启 strict-for-all。账号 A、账号 B 真机及第三既有有效用户均证明全量语义不再依赖灰度名单；四排序多页、搜索/分类、离线隔离、游标错配/跨校拒绝、退出重启和换校均通过。真实 legacy 回滚后立即恢复最终配置，A/B 再次 strict 通过。当前有效结论以 `docs/phase-18-final-cutover.md` 为准。
