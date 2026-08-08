# 第十八阶段第三轮：受控修改学校与两校测试数据准备

日期：2026-08-01

状态：已完成代码、专项回归、`authUser` 单函数部署和微信开发者工具真实云端验证；未执行真机验证，未开启同校市场灰度。

## 1. 本轮结论

- “我的”页已提供修改学校入口，复用权威学校列表和二次确认。
- 修改只允许已登录、状态正常、资料完整且已绑定有效学校的本人发起。
- 客户端只提交目标 `schoolId`；内部用户 ID、OPENID 和学校名称均不作为客户端可信输入。
- `authUser/updateSchool` 在事务内重新定位本人并读取目标 `schools` 文档，只接受 `active + valid` 学校，写入权威 `schoolName`。
- 用户换校不更新 `products`；旧商品保留发布时学校，新商品继续由 `createProduct` 按服务端当前学校绑定。
- 真实账号已从学校 A 受控切换到学校 B，并准备一件 A 校、一件 B 校测试商品。
- `productQuery` 总开关、strict-for-all 和 allowlist 保持关闭/空；没有执行真实 `schoolScoped` 灰度。
- 本轮只部署 `authUser`，没有修改权限、索引或学校集合，没有 commit、push 或标签操作。

## 2. 原有链路审计

原认证链路为 `wx.cloud.callFunction -> authUser -> getWXContext -> openid -> users`。首次选校使用 `authUser/selectSchool`，有效学校一经绑定即拒绝再次通过首次选校 action 改绑。安全用户摘要由 `AuthService/AuthStore` 缓存并供 AuthGuard、首页和各业务页使用。

商品发布学校从来不以客户端字段为准：`createProduct` 根据真实微信身份读取当前用户，再读取 active、valid 的权威学校，最后把当时的 `schoolId/schoolName` 固化到新商品。`manageProduct` 的字段白名单不允许普通编辑或状态操作改变商品学校；`myProducts` 按本人身份而不是当前学校过滤，因此可保留跨学校历史商品管理能力。

## 3. 修改学校架构

```text
“我的”页修改学校入口
  -> pages/school-select?mode=change
  -> SchoolService 权威学校 list/search
  -> 当前学校不可提交 + 二次确认
  -> AuthStore.updateSchool
  -> AuthService.updateSchool（仅 schoolId）
  -> authUser/updateSchool
  -> getWXContext 定位本人
  -> 事务读取 users + schools
  -> 更新本人学校摘要与版本
  -> AuthStore 覆盖缓存
  -> 返回“我的”并由首页学校作用域键触发全量失效
```

入口没有放入首页筛选区。选择页在 change 模式下不会因已经绑定学校而自动跳走，会展示当前学校、禁用同校提交，并在确认文案中明确旧商品不会迁移。

## 4. 服务端安全实现

实际云函数/action：`cloudfunctions/authUser/index.js` 的 `updateSchool`。

处理顺序：

1. 只接收格式合法的目标 `schoolId`；
2. 使用 `cloud.getWXContext()` 获取真实微信身份；
3. 按既有确定性用户 ID 定位且校验 `_openid` 一致；
4. 拒绝不存在、停用、资料未完成或尚未完成首次选校的用户；
5. 在事务内读取用户当前学校，拒绝当前学校不可用的异常状态；
6. 同校请求返回 `SCHOOL_UNCHANGED` 且不写入；
7. 从 `schools` 读取目标记录，要求存在、`platformStatus=active`、`isValid=true` 且名称非空；
8. 只更新当前用户文档，不信任请求中的 `userId/openid/schoolName`；
9. 更新 `schoolId`、权威 `schoolName`、`schoolUpdatedAt`、`updatedAt` 和递增的 `schoolVersion`，保留首次 `schoolSelectedAt`；
10. 返回既有安全用户 DTO。

稳定错误覆盖参数、认证、用户、资料、当前学校、目标学校、同校重放和事务失败。客户端连续提交由页面 `isConfirming/isSubmitting/isReturning`、AuthStore 共享 Promise 和服务端同校无写入共同保护。

## 5. 客户端状态处理

- `AuthService.updateSchool` 只发送 `{ schoolId }`。
- `AuthStore.updateSchool` 复用同一进行中 Promise，使用 `operationVersion` 丢弃过期结果，成功后一次性覆盖内存态和本地安全用户缓存。
- 学校选择页加载、确认、提交和返回期间均有交互锁；取消确认不会调用云函数。
- 首页既有 `authScopeKey` 同时包含用户、`schoolId` 和 `schoolVersion`。任一变化都会递增 `requestVersion` 并清空列表、页码、总数、`hasMore`、`nextCursor`、`marketMode`、market scope 和 `queryScopeKey`，随后重新加载。
- 首页每个异步响应在落地前比较 `requestVersion` 和查询作用域；换校前的旧响应不能覆盖换校后的状态。
- 当前 strict 功能关闭，因此真实首页重载后仍为 `legacy`，但状态失效机制已经按学校变化执行。

## 6. 历史商品规则与真实数据

用户学校与商品学校是两个独立概念。用户换校只更新本人 `users` 文档，不遍历或更新 `products`。旧商品详情、普通编辑、重新上架和状态变化都不得把商品学校改成用户当前学校；商品迁校必须另行设计，本轮没有实现。

真实验证记录按项目规范脱敏：

| 对象 | 学校/结果 |
|---|---|
| 测试账号 | `u_1d3dc1***962f` |
| 学校 A | 上海工程技术大学，`s_e5ca12***b898` |
| 学校 B | 上海财经大学浙江学院，`s_2639dd***6f30` |
| A 校测试商品 | `p_e32fa0***de91`，换校后仍属于 A |
| B 校测试商品 | `p_2cd6de***48b4`，换校后新建且属于 B |
| `myProducts` | 同时返回上述 A/B 两件本人商品 |

两件商品标题均以“阶段18换校验证”开头，便于下一轮识别。完整内部 ID 只保存在受 `.gitignore` 保护的 `tmp/phase-18-school-change-private-result.json`，不记录 OPENID。

## 7. 自动验证结果

- `npm run phase-18-school-change:verify`：75 项通过；
- `npm run school-selection:verify`：126 项通过；
- `npm run product-school-binding:verify`：51 项通过；
- `npm run phase-18:verify`：91 项通过；
- `npm run phase-22a:verify`：6 组通过；
- `npm run phase-18-orphan-review:verify`：7 组通过；
- `npm run phase-18-orphan-fix:verify`：8 组通过；
- `npm run phase-18-preflight:verify`：10 组通过；
- `npm run verify`：81 项通过。
- 99 个 JavaScript 文件通过 `node --check`，67 个 JSON 文件通过 Node 原生 `JSON.parse`，`git diff --check` 通过。

专项测试包含服务端身份/学校/事务失败、客户端伪造字段、同校无写入、连续调用共享 Promise、过期响应丢弃、缓存覆盖、A→换校→B 商品真实服务端来源、`myProducts` 边界，以及首页全状态失效和 strict 三项关闭断言。

## 8. 微信开发者工具真实验证

开发者工具版本 `2.01.2510290`，基础库 `3.16.2`，使用项目既有真实登录态和真实云环境。自动化 `Page.getData/Page.getElement` 域在本机版本中曾无响应，验收脚本已改为通过开发者工具的真实 App 运行上下文读取页面状态并触发页面事件，同时使用原生确认/取消弹窗；每一步增加超时，不再无限等待。

验收脚本还强制要求显式提供预期学校 A/B 的确定性学校 ID，并在任何写入前确认当前账号仍处于 A；最终账号已在 B，因此误重跑会先失败，不会把 B 当作新的 A 或重复创建测试商品。

| 项目 | 结果 |
|---|---|
| 打开修改学校、选择 B、二次确认 | 通过 |
| 点击当前学校不写入 | 通过 |
| 取消确认不写入 | 通过 |
| 快速连续提交保护 | 通过（自动专项） |
| 无效学校直接调用 | 通过，稳定拒绝且用户未变化 |
| 客户端直接更新 users | 通过，权限拒绝 |
| 重启/重新打开后恢复 B | 通过 |
| “我的”页显示 B | 通过 |
| 首页重新加载 | 通过，非 loading、`marketMode=legacy`、无 strict 错误 |
| 旧 A 商品学校保持 | 通过 |
| 新 B 商品使用 B 学校 | 通过 |
| `myProducts` 同时显示 A/B | 通过 |
| 新增控制台 error / 运行时 exception | 0 / 0 |
| 真机 | 未执行 |

验证过程中先完成 A→B，再重启确认 B；为排除验收脚本早期未等待异步导航造成的锁，随后受控执行 B→A 并确认正常返回“我的”，最后回到 B。最终 `schoolVersion=4`，这只是当前测试账号的受控学校变更历史，不涉及其他用户或商品迁移。

## 9. 云端操作

- 只部署 `authUser`；部署后为 `Active / Nodejs16.13 / index.main / 10 秒 / 256 MB`。
- 部署后本地与线上入口 SHA-256 均为 `5c1a33af83f84a8d3824a3091131938f73406ab2bc9c3ce8bae5cced69010030`。
- 未部署 `productQuery` 或其他云函数；第二轮已配置的 HMAC 环境变量未读取或修改。
- 未修改数据库权限、索引、学校状态或集合结构。
- 正式数据写入仅限当前测试账号学校字段及两件明确标记的本人测试商品；没有修改其他用户或生产无关商品。
- 没有批量迁移、删除商品或发生回滚。

## 10. 本轮文件

云函数：`cloudfunctions/authUser/index.js`。

服务/状态：`services/auth-service.js`、`services/auth-guard.js`、`store/auth-store.js`。

页面：`pages/profile/*`、`pages/school-select/*`、`pages/login/index.wxml`。首页已有的学校作用域清理逻辑经本轮审计和测试固定。

验证与部署：`scripts/verify-phase-18-school-change.js`、`scripts/verify-phase-18-school-change-devtools.js`、`scripts/deploy-phase-18-school-change.js`，以及 `package.json`、综合验证和既有选校静态断言更新。

文档：本文、`docs/phase-18-school-scoped-market-implementation.md` 和本地忽略的 `00-项目总交接文档.md`。

## 11. 明确未执行

- 未开启 `SCHOOL_SCOPED_MARKET_ENABLED`；
- 未开启 strict-for-all；
- allowlist 仍为空；
- 未执行真实 `schoolScoped` 灰度或正式切换；
- 未删除 legacy；
- 未批量迁移历史商品，未实施商品迁校；
- 未执行阶段 22B；
- 未做真机验证；
- 未 commit、push 或移动/创建标签。

## 12. 已知限制与风险

- 单账号受控换校不能替代两个账号同时处于不同学校的并发权限测试。
- 真实 strict 查询、四排序 seek、游标签名/过期/篡改及索引执行效果仍未执行。
- 跨校收藏、聊天和预约的新关系权限尚未完成真实验证。
- 本轮未实现换校频率或冷却限制；恶意频繁换校仍有业务风险，当前只有并发/同校重放保护和审计时间/version。
- 历史商品留在原校是有意规则，但会带来跨校历史商品管理与后续编辑政策问题。
- 开发者工具 App 上下文验证已完成，真机仍未执行。

## 13. 下一轮建议

下一轮为“第十八阶段正式开发第四轮：单账号受控灰度与真实同校/跨校商品隔离验证”。开始前应明确授权把脱敏记录对应的单个内部用户加入服务端 allowlist，并保持总开关策略可回滚；使用已准备的 A/B 商品验证 strict 跨校边界、四排序多页、游标安全、索引命中和失败不回退。未经新授权，不得自行开启灰度。

## 14. 第四轮换校验收更新（2026-08-06）

已在单用户 strict 灰度下通过真实 UI 执行 B→A→B，两次 `schoolVersion` 均递增；换校后旧校 cursor 返回 `INVALID_CURSOR_SCOPE`，新首页只显示权威当前学校，最终账号回到 B。首页 strict 的 `page/total` 语义、下拉刷新、详情、我的发布与重启恢复均通过。历史商品未迁校，完整结果见 `docs/phase-18-school-scoped-canary-validation.md`。

## 15. 第五轮政策与历史商品更新（2026-08-07）

第五轮检查时真实测试账号最终处于 A 校，`schoolVersion=31`；这是后续受控人工操作产生的当前云端事实，不改变第四轮 B→A→B 验收结论。个人页修改学校入口、选校页当前学校标记、二次确认和“旧商品仍留在原校园且不会迁移”的说明均存在。

开发/灰度期间继续维持无冷却，正式上线建议改为“首次纠错免费，之后服务端 30 天冷却并展示下次可修改日期”。管理员例外应由后续受控支持流程处理，不能接受客户端跳过冷却参数；本轮未实施该策略。

历史商品继续保持学校不可变，`myProducts` 不按当前学校过滤。本轮在卡片中新增商品发布校园；无学校旧商品明确显示“历史商品：未标校园”。正式上线前建议禁止当前学校不同于商品发布学校时直接重新上架，或至少要求明确确认原校园；本轮未改变既有管理权限或迁移任何商品。完整结论见 `docs/phase-18-final-readiness-review.md`。

## 16. 第五轮修复：迁移与跨校重新上架规则（2026-08-07）

项目所有者明确授权 4 个缺学校用户补齐至上海工程技术大学；迁移使用首次绑定语义 `schoolVersion=1`，写入 `schoolUpdatedAt/updatedAt`，不伪造 `schoolSelectedAt`。迁移后 active 用户学校覆盖为 7/7。

历史商品仍不随用户换校迁移。本轮只对另行明确授权的 20 件公开无学校业务商品执行 Phase 22B 定向补齐，不依据卖家当前学校推断。另在 `manageProduct/relist` 增加服务端事务门禁：当前用户学校与商品学校不同时返回 `PRODUCT_SCHOOL_MISMATCH`，真实 DevTools 验证被拒绝后商品仍 offline、学校不变。

30 天换校冷却本轮未实现，因为现有测试账号已有大量受控换校历史，缺少干净的策略生效时间；未来应在明确上线时间后独立实现。完整记录见 `docs/phase-18-data-migration-and-auth-market.md`。

## 17. 正式切换换校验收补记（2026-08-09）

最终轮中 A/B 两个真实账号均完成跨校作用域验收。账号 B 执行 B→A→B 后，首页旧列表、scope、cursor 和请求窗口均失效；随后在 B 校发布的商品保持 B 校绑定并已下架。真实 legacy 回滚期间账号 A 又完成 A→B→A，恢复 strict 后 A/B 均复验通过。历史商品仍不随用户换校迁移，跨当前学校重新上架保护保持生效。完整证据见 `docs/phase-18-final-cutover.md`。
