# Phase 22：存量学校数据迁移正式收口

> 审计与封版日期：2026-08-09（Asia/Shanghai）
>
> 状态：生产只读复核、历史迁移幂等验证、重新上架安全修复及自动回归均已完成；公开市场 `29 / 29` strict-ready，未发现新的迁移候选。

## 1. Git 与历史基线

| 项目 | 开发前结果 |
| --- | --- |
| branch | `main` |
| HEAD | `0fd2e67850b87d577ba8ff5d120e4349b70ea53e` |
| tag at HEAD | `phase-21-complete` |
| origin | `main` 与 `origin/main` 同步 |
| tracked working tree | clean |

Phase 22A 的只读盘点和 Phase 22B 的已授权迁移不是本轮重新执行的工作。历史记录确认：

- 22A 已盘点 users、products、favorites、conversations、messages、appointments、productViews 与 schools，并完成数据摘要、预约阻断分析、候选分类和安全停止门禁。
- 后续已获得精确授权，将 4 个缺学校 active 用户和 20 件缺学校公开商品迁移到权威确认的目标学校。
- 历史迁移已执行 dry-run、精确清单 apply、逐条反查和幂等重跑。
- 本轮只读核对这些结果，不重新 apply，也不扩大授权范围。

历史证据继续保留在 `docs/phase-22a-school-data-audit.md`、`docs/phase-18-data-migration-and-auth-market.md` 和 `docs/phase-18-final-cutover.md`。

## 2. 当前生产快照

真实目标仅以掩码 `cloud:cloud1***6d8e` 记录。审计报告不包含 OPENID、完整生产对象 ID、聊天内容、地点、媒体地址或本机绝对路径。

| 集合 | 数量 |
| --- | ---: |
| users | 8 |
| products | 68 |
| favorites | 6 |
| conversations | 20 |
| messages | 144 |
| appointments | 19 |
| productViews | 24 |
| schools | 2952 |

学校集合保持 2 所 `active + officialStatus=valid`、2950 所 pending；本阶段没有扩大开放范围。

## 3. 用户学校 readiness

| 指标 | 数量 |
| --- | ---: |
| users 总数 | 8 |
| active users | 8 |
| 当前学校有效 | 8 |
| 缺失或无效 | 0 |
| 当前学校名称与权威记录不一致 | 0 |

用户学校表示当前状态；4 个历史迁移用户当前的 `schoolId / schoolName / schoolVersion` 均合法。本次验证允许 Phase 20 之后的合法换校，不会把后续有效变化误判为历史迁移失败。

## 4. 商品学校 readiness

| 指标 | 数量 |
| --- | ---: |
| products 总数 | 68 |
| 有有效学校 | 52 |
| 无有效学校 | 16 |
| 公开商品 | 29 |
| 公开 strict-ready | 29 |
| 公开不就绪 | 0 |
| 非公开商品 | 39 |
| 非公开有学校 | 23 |
| 非公开无学校 | 16 |
| 学校名称快照不一致 | 0 |

按真实状态：

| status | 总数 | 其中无学校 |
| --- | ---: | ---: |
| available | 29 | 0 |
| reserved | 0 | 0 |
| offline | 25 | 3 |
| sold | 11 | 11 |
| deleted | 3 | 2 |
| draft | 0 | 0 |
| other | 0 | 0 |

公开市场 readiness 为 `29 / 29 = 100%`。没有无学校 `available / reserved` 商品，strict 市场无需回退或放行 legacy 数据。

## 5. 剩余无学校商品分类

复用既有 T1—T5 分类，不创建冲突 taxonomy。稳定摘要仅用于报告定位，不泄露完整生产 `_id`。

| 分类 | 数量 | 状态 | 历史关系 | 证据与最终决定 |
| --- | ---: | --- | --- | --- |
| T1 | 1 | offline 1 | 无 | 权威历史证据不足；保持未归属 |
| T2 | 9 | sold 9 | 均有 | 存在收藏、会话、消息、预约或浏览历史；线索不足或冲突，保留关系并保持未归属 |
| T3 | 1 | offline 1 | 无 | 明确测试候选、无媒体；仅标记 cleanup candidate，不删除、不迁移 |
| T4 | 3 | offline 1、sold 2 | 无 | 非权威线索冲突或不足；等待未来人工证据，保持未归属 |
| T5 | 2 | deleted 2 | 其中 1 件有历史关系 | 保留软删除记录，不迁移、不清理关系 |

共 16 件，全部非公开；10 件具有至少一种历史业务关系；关联的未删除 `pending / accepted` appointment 为 0。确定性学校证据为 0，新增迁移候选为 0。

脱敏稳定摘要：

- T1：`p#c2d82f0996`
- T2：`p#07afbbeec3`、`p#358536aea0`、`p#389a242622`、`p#6a8d5236e5`、`p#78ac6b9c40`、`p#9cfb96d65e`、`p#9ec62f476b`、`p#a34bfad194`、`p#aa7b7883d6`
- T3：`p#56853a8ed6`
- T4：`p#5cebee7790`、`p#90482feda5`、`p#910341f711`
- T5：`p#64f4a511af`、`p#6cc830117e`

当前 owner 学校、标题、campus、地点、聊天参与者和业务关系均未被用作旧商品学校推断依据。

## 6. 历史迁移幂等核对

| 对象 | 授权数 | 证据记录 | 当前存在 | 仍合法/固定 | changed | writes |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| users | 4 | 4 | 4 | 4 | 0 | false |
| products | 20 | 20 | 20 | 20 | 0 | false |

20 件商品仍固定在原迁移学校且学校引用有效，当前均为 available。历史迁移工具以安全等价模式重跑，返回 `already-applied`，`changed=0`、`skipped=20`、`writesExecuted=false`。没有重复迁移。

## 7. 本轮安全修复

审计发现 `manageProduct/relist` 原先只验证所有权与状态，可能把无学校历史 offline 商品重新上架到 strict 市场。已实施最小 fail-closed 修复：

- relist 前校验商品自身 `schoolId / schoolName`；
- 在同一事务读取 schools，要求目标学校仍为 `active + officialStatus=valid`；
- 无学校或学校失效时返回 `PRODUCT_SCHOOL_UNAVAILABLE`；
- 不读取 owner 当前学校作为商品学校，不写商品学校字段；
- 合法的历史跨校商品仍可由 owner 管理和重新上架，其发布学校保持不变。

`manageProduct` 是本阶段唯一部署的云函数。部署前后 runtime、handler、timeout、memory 和环境变量指纹保持不变；本地与远端代码摘要一致。没有通过普通 edit、save 或 relist 承担迁移职责。

客户端补充两项诚实展示：My Products 沿用“历史商品：未标校园”，owner 商品详情在学校快照为空时显示同样文案；没有显示 owner 当前学校。

## 8. strict、索引与 ACL

| 检查 | 结果 |
| --- | --- |
| `enabled` | true |
| `strictForAll` | true |
| `accessRequiresAuth` | true |
| allowlist | 0 |
| products indexes | 20，Phase 18/21 必需索引齐全 |
| products ACL | `ADMINONLY` |
| productQuery local/remote | 摘要一致、Active |
| manageProduct local/remote | 摘要一致、Active |

本阶段没有新增、删除或修改索引，没有修改任何集合 ACL，也没有修改 strict 配置。

## 9. 自动化与回归

| 命令 | checks | passed | failed |
| --- | ---: | ---: | ---: |
| `npm run phase-22:verify` | 42 | 42 | 0 |
| `npm run verify` | 81 | 81 | 0 |
| `npm run phase-21:verify` | 64 | 64 | 0 |
| `npm run phase-20:verify` | 78 | 78 | 0 |
| `npm run phase-19:verify` | 49 | 49 | 0 |
| `npm run phase-18:verify` | 91 | 91 | 0 |
| `npm run phase-18-school-change:verify` | 79 | 79 | 0 |
| `npm run phase-18-auth-market:verify` | 16 | 16 | 0 |
| `npm run school-selection:verify` | 128 | 128 | 0 |
| `npm run product-school-binding:verify` | 51 | 51 | 0 |
| `npm run phase-22a:verify` | 6 groups | 6 groups | 0 |
| `npm run phase-22b:verify` | 19 | 19 | 0 |
| `npm run phase-18-data-migration:verify` | 26 | 26 | 0 |
| `npm run phase-18-preflight:verify` | 10 groups | 10 groups | 0 |

覆盖 Phase 18 首页/搜索/分类/四排序/分页/cursor strict scope，Phase 19 跨校详情与新关系闸门，Phase 20 冷却、schoolVersion 和 scope 失效，Phase 21 历史关系、seller profile 与 owner scope，以及 Phase 22 未归属商品 relist、普通编辑不补学校、历史迁移幂等和审计零写入边界。

另通过 150 个 JavaScript 语法检查、67 个 JSON 解析、敏感信息增量扫描和 `git diff --check`。微信开发者工具真实 preview 为 `487168 Byte / 475.8 KB`，无 80051。

## 10. 生产只读证明

最终审计对 8 个集合分别读取两次全量受控投影：

- 前后计数完全一致；
- 前后 8 组 SHA-256 投影摘要逐集合一致；
- `databaseWriteApiCalled=false`；
- `transactionExecuted=false`；
- `migrationApplied=false`；
- `fixtureCreated=false`；
- `dataDeleted=false`。

本轮生产业务数据变化均为 0。唯一外部变更是已获本阶段授权的 `manageProduct` 安全代码部署；没有业务数据写入。

## 11. 数据影响

| 对象 | 影响 |
| --- | --- |
| users | 0 写入 |
| products | 0 写入、0 迁移、0 删除 |
| favorites | 0 写入、关系保留 |
| conversations | 0 写入、关系保留 |
| messages | 0 写入、历史保留 |
| appointments | 0 写入、状态不变 |
| productViews | 0 写入 |
| schools | 0 写入、active 范围不变 |
| fixture | 0 |
| migration | 0 |
| ACL | 不变 |
| indexes | 不变，仍为 20 |
| cloud functions | 仅部署 `manageProduct` 安全修复 |

## 12. DevTools 与必要页面验收

当前开发者工具登录账号存在安全的真实无学校已售 owner 样本，因此没有制造 fixture。页面级只读验收通过：

1. My Products 的真实未归属历史商品继续存在，页面数据没有推断 `schoolId / schoolName`，模板命中“历史商品：未标校园”分支。
2. owner 详情成功打开同一真实历史商品，`isOwnProduct=true`，学校字段继续为空，模板命中同一诚实文案分支。
3. 当前首页为 `schoolScoped`，所有返回商品均属于当前权威学校。
4. 无结果关键词搜索和书籍分类请求仍为同一学校 scope，没有出现无学校历史商品。
5. console error / exception 为 `0 / 0`。

验收没有换学校、取消收藏、发消息、建预约、编辑商品或点击重新上架；`writesRequested=false`、`fixturesCreated=false`。验收后再次执行完整生产审计，8 个集合的计数和投影摘要仍逐项一致，完成门禁继续为通过。

## 13. Git 封版

- commit message：`fix: finalize phase 22 school data governance`
- branch：`main` 推送至 `origin/main`
- tag：创建并推送 annotated tag `phase-22-complete`
- `phase-21-complete` 保持不动
- 本地受保护总交接文档继续由 `.gitignore` 忽略，不进入公开 Git

## 14. 阶段结论

当前公开市场 100% strict-ready；剩余 16 件均为不可公开且无确定学校证据的历史记录，保持未归属是正确结果。历史 4 个 users 与 20 件 products 的已授权迁移完整且幂等，所有历史关系得到保留。本轮没有新增迁移候选、没有生产业务数据写入、没有 blocker。

**Phase 22 complete**

Phase 23 尚未开始。
