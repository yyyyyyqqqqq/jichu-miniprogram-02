# Phase 20：学校切换、7 天冷却与全局市场状态失效

> 状态：代码、自动验证、生产部署、微信开发者工具零写入验证、preview 与项目负责人真实 A → B 换校人工验收均已完成，**Phase 20 complete**。
>
> Phase 21 尚未开始。

## 1. 基线

| 项目 | 开发前结果 |
| --- | --- |
| branch | `main` |
| HEAD | `5e8c95f feat: add phase 19 cross-school detail access guards` |
| tag | `phase-19-complete` |
| origin | `main` 与 `origin/main` 同步 |
| working tree | clean |

本节记录 Phase 20 开发前基线；Phase 20 最终通过本报告所述封版提交与 annotated tag `phase-20-complete` 收口。

## 2. 原架构审计

- 当前学校：`users.schoolId / schoolName` 是服务端权威；客户端 AuthService、AuthStore 和安全本地摘要只缓存服务端返回值。
- 首次选校：`pages/school-select` → `AuthStore.selectSchool` → `AuthService.selectSchool` → `authUser/selectSchool`。
- 后续换校：同一页面的 `mode=change` → `AuthStore.updateSchool` → `authUser/updateSchool`，没有复制学校搜索页。
- 资料/current：`authUser/current` 解析权威学校状态，AuthStore 启动时用云端结果覆盖本地摘要。
- 学校合法性：服务端重新读取 `schools`，只接受 `platformStatus=active + officialStatus=valid + 有效名称`。
- 首页/搜索/分类：都在 `pages/home`，通过同一 `ProductService.getProducts` school-scoped 查询；筛选和排序可以保留，结果及 cursor 会重置。
- cursor：Phase 18 服务端 cursor 已绑定学校作用域；首页本地同时保存 `marketScope / queryScopeKey / nextCursor`。
- 旧请求：首页 `authScopeKey` 已包含用户、`schoolId` 和 `schoolVersion`，并用 `requestVersion` 丢弃晚到响应。
- 全局状态：`app.js`、AuthStore 和 AppStore；没有额外 userStore，也不依赖客户端 schoolId 作为服务端权限来源。

## 3. Phase 20 实现

### 学校修改入口

继续复用“我的 → 学校 → `pages/school-select?mode=change`”。个人页显示当前是否可修改及下一次允许时间；换校页进入前强制刷新 `authUser/current`，不只信本地缓存。

### 首次选择与后续切换

- 首次选择写 `schoolVersion=1`，保留 `schoolChangedAt` 为空，不启动冷却。
- 既有不可用学校重新绑定属于真实变化：递增版本、写入服务端变更时间并启动冷却。
- 已有有效学校只能走 `updateSchool`，不能用首次选择 action 绕过。

### 服务端权限与 7 天冷却

`authUser/updateSchool` 在数据库事务中重新读取本人、当前学校和目标学校。准确按：

```text
schoolChangedAt + 7 × 24h
```

判断，`6d23:59:59` 拒绝，刚好 7 天和超过 7 天允许。手机时间、storage、页面变量、客户端时间戳、oldSchoolId、schoolName 和 schoolVersion 均不参与授权。

冷却统一返回 `SCHOOL_CHANGE_COOLDOWN`，并附带仅用于 UI 的：

- `canChangeSchool`
- `nextSchoolChangeAllowedAt`
- `schoolChangeRemainingMs`

最终权限仍由每次服务端事务重新决定。

### schoolChangedAt / schoolVersion / no-op

- 真正成功换校使用云函数运行时服务端时间写 `schoolChangedAt`。
- 每次真实变化将 `schoolVersion` 恰好加 1。
- 同校请求返回成功 no-op：`changed=false / reason=unchanged`，不写数据库、不更新时间、不增加版本、不触发首页作用域失效。
- 没有 `schoolChangedAt` 的历史用户保持兼容，允许第一次 Phase 20 换校；没有批量迁移。

### 并发保护

冷却检查、学校写入、时间和版本递增位于同一事务。并行提交两个不同目标学校时，只有一个请求可以形成真实变化；另一个在冲突后的权威状态上进入冷却并被拒绝。

### 客户端同步与多设备恢复

- 服务端成功后 AuthStore 才一次性替换用户和本地安全摘要；失败继续保留旧学校。
- AuthStore 继续合并重复提交并丢弃晚于 logout/新操作返回的旧响应。
- `app.onShow` 从服务端刷新当前用户。另一设备换校后，旧设备下一次进入前台即可读取新的 `schoolId / schoolVersion / schoolChangedAt`。
- 未调用 `wx.clearStorage`，只更新现有用户安全摘要。

### 首页、搜索、分类与 cursor 失效

权威用户的 `schoolId` 或 `schoolVersion` 变化后：首页立即递增请求代际并清空商品、分页、`nextCursor`、query scope 和 market scope，再从新学校第一页加载。关键词、分类或排序控件可保留，但旧结果和旧 cursor 不保留；旧学校晚到响应不能覆盖新状态。

### Phase 19 兼容

没有迁移历史商品、收藏、会话、消息或预约。商品继续固定在发布学校；卖家仍可管理本人旧商品；历史关系继续保留；新跨校收藏、会话和预约继续由 Phase 19 服务端闸门拒绝；合法旧校详情在刷新后变为跨校只读，本人旧商品仍为 owner。

## 4. 修改文件

### 新增

- `scripts/verify-phase-20.js`：78 项冷却、安全、并发、缓存和 Phase 18/19 边界验证。
- `scripts/deploy-phase-20.js`：仅部署 `authUser` 的环境确认、摘要与配置守卫。
- `scripts/verify-phase-20-devtools.js`：生产只读页面/云函数验证和七集合投影零变化检查。
- `docs/phase-20-school-change-cooldown.md`：本报告。

### 修改

- `cloudfunctions/authUser/index.js`：7 天冷却、权威状态、no-op、并发事务与安全日志。
- `services/auth-service.js`：冷却字段和安全错误详情归一化。
- `store/auth-store.js`：冷却字段缓存、服务端结果替换与错误详情。
- `app.js`：进入前台时刷新服务端当前用户。
- `pages/profile/index.js / index.wxml / index.wxss`：冷却状态与下一次允许时间。
- `pages/school-select/index.js / index.wxml / index.wxss`：权威刷新、冷却 UI、7 天确认和竞态错误恢复。
- `scripts/verify-phase-18-school-change.js`：同校 no-op 和冷却字段回归。
- `scripts/verify-project.js`：允许且约束不含身份信息的学校变更结果日志。
- `package.json`：Phase 20 验证、部署和 DevTools 命令。
- `README.md`：阶段状态。

### 删除

无。

## 5. 云函数与生产状态

只部署 `authUser` 到既有脱敏目标环境 `cloud1***6d8e`：

| 项目 | 结果 |
| --- | --- |
| status | Active |
| runtime | Nodejs16.13 |
| handler | `index.main` |
| timeout / memory | 10s / 256MB |
| local / remote SHA-256 | `ff9186ee...d58d`，一致 |
| 环境变量指纹 | 部署前后一致 |

未部署其他函数，未修改 ACL、索引、密钥、rollout 或学校基础数据。

## 6. 自动化

| 命令 | checks | passed | failed |
| --- | ---: | ---: | ---: |
| `npm run phase-20:verify` | 78 | 78 | 0 |
| `npm run verify` | 81 | 81 | 0 |
| `npm run phase-18-school-change:verify` | 79 | 79 | 0 |
| `npm run school-selection:verify` | 128 | 128 | 0 |
| `npm run phase-19:verify` | 49 | 49 | 0 |
| `npm run phase-18:verify` | 91 | 91 | 0 |
| `npm run phase-18-auth-market:verify` | 14 | 14 | 0 |
| `npm run product-school-binding:verify` | 51 | 51 | 0 |

另通过 142 个 JavaScript 语法检查、67 个 JSON 解析、隐私扫描和 `git diff --check`。微信开发者工具 preview 为 `478599 Byte / 467.4 KB`，无 80051。

## 7. 冷却边界矩阵

| 场景 | 结果 |
| --- | --- |
| 首次设置 | PASS；version=1，changedAt 为空，不冷却 |
| 同校 no-op | PASS；零写入、版本与时间不变 |
| 6d23:59:59 | PASS；拒绝，remainingMs=1000 |
| 刚好 7d | PASS；允许 |
| >7d | PASS；允许 |
| invalid school | PASS；拒绝 |
| pending school | PASS；拒绝 |
| direct cloud call | PASS；仍执行冷却 |
| fake timestamp/version/oldSchoolId/name | PASS；全部忽略 |
| parallel requests | PASS；一个成功、一个冷却拒绝、只写一次 |

## 8. A → B 状态矩阵

| 状态 | 结果 |
| --- | --- |
| `users.schoolId / schoolName` | 写入目标 ID 与数据库权威名称 |
| `schoolChangedAt` | 服务端可信时间 |
| `schoolVersion` | +1 |
| home/search/category | 旧结果清空，基于 B 重新查询 |
| cursor | A cursor 主动清空，不在 B 复用 |
| detail | 旧校合法商品刷新后只读；本人商品 owner |
| favorite | 历史保留；新跨校拒绝 |
| conversation | 历史复用；新跨校拒绝 |
| appointment | 历史保留；新跨校拒绝 |

## 9. 生产零写入验证

部署后真实开发者工具已确认：

- `authUser/current` 返回完整冷却字段；
- 换校页显示的当前学校和冷却能力与服务端一致；
- 首页继续为 `schoolScoped`，商品只属于当前学校；
- users、products、favorites、conversations、messages、appointments、schools 验证前后计数与投影哈希一致；
- console error / exception 为 0 / 0。

该检查没有点击确认换校，也没有创建业务关系。

## 10. 真实人工验收

项目负责人已按正常业务路径完成一次真实 A → B 换校，并明确确认 **PASS**：

- 当前学校成功从 A 切换到 B，“我的”页面正确显示 B；
- 首页立即切换到 B 校市场，搜索、分类、排序和加载更多均只返回 B 校商品；
- 旧 A 校结果和旧 cursor 没有残留；
- 立即再次进入换校页后进入准确 7 天冷却，不能再次换校；
- 完全关闭并重新打开小程序后，B 校与冷却状态正确恢复；
- A 校历史发布商品没有迁校且本人仍可管理；
- 历史收藏、会话和预约继续保留；
- Phase 19 跨校详情只读和新关系限制继续正常。

本次人工验收只执行 A → B，没有尝试在冷却期内执行 A → B → A。

## 11. 数据影响

- 本轮自动化、部署和 DevTools 零写入验收没有修改 users、products、favorites、conversations、messages、appointments 或 schools。
- 没有 fixture、迁移、批量用户更新、商品迁校、ACL 或索引变化。
- 项目负责人的真实人工验收按正常业务路径修改了所选测试账号的 `users.schoolId / schoolName / schoolChangedAt / schoolUpdatedAt / schoolVersion / updatedAt`；这是唯一预期业务写入。
- 历史商品、收藏、会话、消息和预约均未迁移或删除。

## 12. Git 与阶段结论

- commit：`feat: complete phase 20 school change cooldown`。
- push：封版提交推送至 `origin/main`。
- annotated tag：`phase-20-complete`，指向上述封版提交并推送至 origin。
- Phase 19 标签未移动。

**Phase 20 complete**

项目负责人真实 A → B 换校验收与最终自动化回归均已通过；实现、部署、数据边界、文档和 Git 封版全部收口。Phase 21 尚未开始。
