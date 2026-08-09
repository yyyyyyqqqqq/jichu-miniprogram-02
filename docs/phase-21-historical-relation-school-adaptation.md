# Phase 21：历史业务关系学校适配

> 状态：代码、自动验证、生产部署、索引反查、微信开发者工具零写入验证、preview 与必要页面体验人工验收均已完成，**Phase 21 complete**。
>
> 人工验收沿用 Phase 20 换校后的当前账号，没有再次切换学校。后续阶段尚未开始。

## 1. 基线

| 项目 | 开发前结果 |
| --- | --- |
| branch | `main` |
| HEAD | `4b47dac feat: complete phase 20 school change cooldown` |
| tag | `phase-20-complete` |
| origin | `main` 与 `origin/main` 同步 |
| working tree | clean |

Phase 21 从 Phase 20 封版提交继续开发，没有修改 7 天冷却、`schoolChangedAt`、`schoolVersion` 递增规则或首页 strict 市场作用域。

## 2. 架构审计

| 模块 | 真实查询模型 | Phase 21 结论 |
| --- | --- | --- |
| favorites | `favorites.userOpenid = current identity`，再读取关联商品 | 历史关系查询正确；未增加当前学校过滤 |
| conversation list | 当前身份是 participant A/B | 历史会话查询正确；未增加当前学校过滤 |
| chat | participant 才能读取；商品删除时只读 | 历史跨校会话可继续读取和发送消息；沿用既有语义 |
| appointment | 当前身份是 buyer/seller | 历史预约查询及既有状态流正确；未增加当前学校过滤 |
| seller profile | 原实现按 seller 返回全部公开商品 | 存在跨校公开信息泄露，已改为 viewer 权威学校 scope |
| my products | `sellerOpenid = current identity` | owner scope 正确；不按当前学校过滤 |
| unread | conversation participant 槽位的真实 unread count | 不按学校过滤；项目当前没有独立 TabBar 未读 badge |

“我的”页当前入口没有展示收藏、会话或预约数量，因此不存在换校后数字归零问题。

## 3. Phase 21 实现

### 3.1 收藏历史跨校适配

- 收藏列表继续按用户历史 relation 查询，跨校收藏不会因市场 strict scope 消失。
- 收藏商品安全摘要增加固定的 `schoolId / schoolName`。
- 页面使用统一 helper 对比当前服务端用户学校，仅为跨校历史收藏显示轻量“其他学校商品”标签。
- 点击仍进入 Phase 19 商品详情并由服务端决定 `crossSchoolReadonly / owner`。
- 历史收藏仍可取消；取消后重新收藏仍由 `favoriteProduct` 的 Phase 19 同校闸门拒绝。

### 3.2 消息与聊天历史跨校适配

- 会话列表继续按 participant 查询，未读数继续来自当前参与者槽位。
- 商品摘要增加固定学校字段；消息列表和聊天顶部显示统一轻量标签。
- 已有确定性 conversation 仍先复用，不会创建第二条。
- `messageAction/sendMessage` 既有规则是：参与者在商品未删除时可继续发送消息。本阶段明确保留该产品语义，没有增加跨校发送禁令。
- 商品已删除时仍只能读取历史消息。
- 跨校历史会话中，如已有 appointment，仍可进入查看；如不存在，客户端明确提示不能新建预约，服务端 `appointmentAction` 仍是最终权限来源。

### 3.3 appointment 历史跨校适配

- 预约中心继续按 buyer/seller 查询，真实状态不会因换校重置或自动取消。
- 列表和详情商品摘要增加学校字段，并显示“其他学校商品”标签。
- `pending / accepted / rejected / cancelled / completed` 等既有状态流不因学校变化被阻断。
- 只有创建新 appointment 继续执行 Phase 19 权威同校闸门。

### 3.4 Seller Profile viewer school scope

- `userQuery` 从 `cloud.getWXContext()` 解析真实身份，确定性读取当前 viewer 用户。
- viewer 必须完成资料、绑定有效 active/valid 学校；客户端 `schoolId / viewerSchoolId` 完全不参与授权。
- 公开资料中的在售数和商品列表都在服务端使用 `seller + viewer.schoolId + public status` 查询。
- 返回安全的 viewer school scope，客户端校验 profile/products 两次查询 scope 一致。
- viewer 的 `schoolVersion` 变化后页面递增请求代际、重新加载；旧学校晚到响应不能覆盖新 scope。
- 未登录策略与 Phase 18 的强制登录市场模型一致：没有权威当前学校时不返回公开卖家商品。

### 3.5 My Products owner scope

- 服务端仍只按 owner 和商品状态查询，不增加当前学校条件。
- 页面原有“发布校园”标签继续复用，A/B 历史商品可同时理解。
- schoolVersion 变化后页面重新读取 owner 全量结果，但不会把查询改成当前学校市场。
- `manageProduct` 所有权校验和商品学校不可变规则未修改。

### 3.6 统一 UI 与页面刷新

新增 `utils/school-relation.js`，只负责：

- 规范化学校与 `schoolVersion`；
- 生成页面 auth scope key；
- 为收藏、会话和预约中的商品生成统一展示语义。

它不是权限权威，不会替代云函数闸门。收藏、消息、聊天、预约、卖家主页和我的发布均监听 AuthStore 的学校版本变化，并使用既有 `requestVersion` 思路丢弃旧请求。

### 3.7 商品详情卖家入口决定

跨校只读详情中的卖家主页入口继续保持 Phase 19 的禁用行为。虽然 Seller Profile 已实现 viewer-school scope，从理论上不会泄露跨校商品，但 Phase 19 的该交互已经过正式人工确认；Phase 21 不在没有新产品决策的情况下擅自恢复入口。同校详情入口保持不变。

## 4. 服务端权限边界

| 操作 | 权威规则 |
| --- | --- |
| 读取收藏 | 历史 favorite relation |
| 取消收藏 | existing favorite 可取消 |
| 新收藏 | Phase 19 同校 guard |
| 读取 conversation/messages | participant |
| 复用 conversation | 既有确定性 relation 优先 |
| 新 conversation | Phase 19 同校 guard |
| 历史会话发送 | participant + 商品未删除；跨校仍允许 |
| 读取 appointment | buyer/seller participant |
| 既有状态流 | appointment 角色与状态机 |
| 新 appointment | Phase 19 同校 guard |
| Seller Profile | viewer 权威当前学校 + seller + public status |
| My Products | owner，不按当前学校 |
| 商品学校 | 发布时固定，不迁移 |

## 5. 修改文件

### 新增

- `utils/school-relation.js`
- `scripts/verify-phase-21.js`
- `scripts/deploy-phase-21.js`
- `scripts/verify-phase-21-devtools.js`
- `docs/phase-21-historical-relation-school-adaptation.md`

### 修改

- `cloudfunctions/favoriteProduct/index.js`
- `cloudfunctions/messageQuery/index.js`
- `cloudfunctions/messageAction/index.js`
- `cloudfunctions/appointmentQuery/index.js`
- `cloudfunctions/userQuery/index.js`
- `services/message-service.js`
- `services/appointment-service.js`
- `services/public-user-service.js`
- 收藏、消息、聊天、预约列表、预约详情、卖家主页和我的发布页面
- `scripts/verify-project.js`
- `scripts/verify-appointments.js`
- `package.json`
- `README.md`

### 删除

无。

## 6. 云函数、环境与索引

仅部署以下实际变化函数到既有脱敏目标 `cloud1***6d8e`：

| 函数 | 状态 / runtime | local / remote SHA-256 |
| --- | --- | --- |
| `favoriteProduct` | Active / Nodejs18.15 | `89bfc3412a859e7f7adf1d2e6ff4cb00b9b582af5b66c532c629cb65a7b489f1` |
| `messageQuery` | Active / Nodejs18.15 | `cdd76b4bdc74905e567e8d8629b44159d91b7fb86d3a9342abce5d85ced50c9f` |
| `messageAction` | Active / Nodejs18.15 | `c4fa1940ed83d9d0673bb4aacf801b9d425dcab88fe5bf7495eac800967c8513` |
| `appointmentQuery` | Active / Nodejs18.15 | `a06ab7e29e62755b4657883df9f0472174151cf6a950e09396b059dcc230803f` |
| `userQuery` | Active / Nodejs18.15 | `f0bd4b878e9e0e761d79f19ce9a3f01d76b40436420c95a3010c9927b1325245` |

handler 均为 `index.main`，timeout/memory 均为 `10s / 256MB`，环境变量指纹部署前后一致。

原 19 个 `products` 索引缺少 seller 与 viewer school 的组合，新增一个非唯一索引：

```text
idx_seller_school_status_createdAt_id
sellerOpenid ASC
schoolId ASC
status ASC
createdAt DESC
_id ASC
```

反查索引总数 19→20，定义完全一致，旧索引全部保留。未修改 ACL。

## 7. 自动化

| 命令 | checks | passed | failed |
| --- | ---: | ---: | ---: |
| `npm run phase-21:verify` | 64 | 64 | 0 |
| `npm run verify` | 81 | 81 | 0 |
| `npm run phase-19:verify` | 49 | 49 | 0 |
| `npm run phase-20:verify` | 78 | 78 | 0 |
| `npm run phase-18:verify` | 91 | 91 | 0 |
| `npm run phase-18-school-change:verify` | 79 | 79 | 0 |
| `npm run phase-18-auth-market:verify` | 14 | 14 | 0 |
| `npm run school-selection:verify` | 128 | 128 | 0 |
| `npm run product-school-binding:verify` | 51 | 51 | 0 |

另通过 146 个 JavaScript 语法检查、67 个 JSON 解析和 `git diff --check`。微信开发者工具 preview 为 `486901 Byte / 475.5 KB`，无 80051。

## 8. 场景矩阵

| 场景 | 自动结果 |
| --- | --- |
| cross-school favorite 保留与标签 | PASS |
| 历史 favorite cancel | Phase 19 回归 PASS |
| 取消后重新跨校收藏 | 服务端拒绝 PASS |
| historical conversation 读取与复用 | PASS |
| historical conversation 继续发送 | 保留既有 participant 语义 PASS |
| 不存在 conversation 时跨校创建 | 服务端拒绝 PASS |
| unread | participant 总量，不按学校过滤 PASS |
| historical appointment 读取与状态流 | PASS |
| cross-school new appointment | 客户端提示 + 服务端拒绝 PASS |
| seller profile A viewer | 只返回 A 商品 PASS |
| seller profile B viewer | 只返回 B 商品 PASS |
| client forged seller-profile school | 无效 PASS |
| my products old/new school | owner 全量且学校固定 PASS |

## 9. Phase 18 / 19 / 20 回归

- Phase 18：首页、搜索、分类、四排序、分页及 school-scoped cursor 的 91 项通过。
- Phase 19：跨校详情只读、新收藏/新会话/新预约拒绝、历史关系保留、owner 历史商品管理的 49 项通过。
- Phase 20：准确 7×24 小时冷却、`schoolVersion`、多设备恢复、首页/搜索/分类/cursor 失效的 78 项通过。
- 首次选校 128 项、商品服务端学校绑定 51 项继续通过。

## 10. DevTools / 生产零写入验证

真实开发者工具确认：

- 当前学校和 `schoolVersion` 可用；
- 收藏、会话、预约按历史关系读取；
- 存在跨校历史会话安全样本，消息页跨校状态正确；
- 当前账号没有安全的跨校收藏或跨校预约页面样本，没有为验收制造 fixture；
- 找到同时拥有两校公开商品的真实卖家样本，B viewer 的服务端结果、计数和页面只包含 B 校商品；伪造 school 参数无效；
- My Products 继续为 owner scope；
- 首页继续为 Phase 18 `schoolScoped`；
- users、products、favorites、conversations、messages、appointments、schools 前后计数与投影完全一致；
- console error / exception 为 0 / 0。

为保持零写入，自动验收没有进入会触发 mark-read 的聊天页，也没有取消收藏、发送消息或操作预约。

## 11. 必要人工页面验收

项目负责人已使用 Phase 20 换校后的当前账号完成页面体验验收，并在 `96.md` 明确确认 **PASS**：

1. “我的收藏”中的历史收藏正常存在；如有跨校历史收藏样本，其跨校状态提示和只读详情正常。
2. “消息”中的跨校历史会话正常存在并显示“其他学校商品”；未读状态正常，没有重复 conversation。
3. 跨校历史聊天的历史消息、商品信息、学校提示和输入区域状态正常；没有既有预约时不能新建跨校预约。
4. “我的预约”中的历史预约和原有状态保持正常，没有自动取消。
5. 卖家公开主页只展示当前学校可见的公开商品，没有当前学校商品时空态正常。
6. “我的发布”中的旧学校和当前学校商品均正常存在，发布校园显示正确；旧学校商品可进入详情/编辑页，学校字段不可修改。
7. 返回首页后，首页、搜索和分类仍只展示当前学校商品。

本轮人工验收没有再次换校，也没有取消收藏、发送测试消息、修改预约或修改商品状态等业务写操作。

## 12. 数据影响

| 对象 | 影响 |
| --- | --- |
| users | 无业务写入 |
| products | 无文档写入；仅新增 1 个组合索引 |
| favorites | 无写入、删除或迁移 |
| conversations | 无写入、删除或迁移 |
| messages | 无写入或删除 |
| appointments | 无写入、删除或状态变化 |
| schools | 无写入 |
| fixture | 0 |
| migration | 0 |
| ACL | 不变 |
| indexes | products 19→20，旧索引全保留 |

## 13. Git 与阶段结论

- commit：`feat: complete phase 21 historical relation school adaptation`。
- branch：`main` 已推送至 `origin/main`。
- tag：annotated tag `phase-21-complete` 已创建并推送，指向本阶段封版提交。
- `phase-20-complete` 未移动。

**Phase 21 complete**

代码、生产部署、索引、自动回归、零写入 DevTools 验收、preview、必要页面人工验收与 Git 封版均已完成。后续阶段尚未开始。
