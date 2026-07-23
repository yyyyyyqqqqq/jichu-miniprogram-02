# 第九阶段：消息中心与私信聊天核心闭环

> 更新日期：2026-07-24
> 稳定基线：`807b1b64252cda6871012f5d79bf9513f0e8c473`（`phase-8-complete`）
> 当前状态：主体功能、真实微信登录、云端部署、双账号联合验收和正式收尾检查均已通过；仅第三个真实账号的非参与者越权真机测试低风险延期，不阻塞 `phase-9-complete`

## 1. 当前工程检查

实施前真实检查结果：

- `main`、`origin/main`、HEAD 和 `phase-8-complete` 均指向 `807b1b6`。
- `pages/messages` 原为登录守卫加静态空态，没有真实会话请求。
- `pages/chat` 已注册到 `app.json`，但只有 `Page({})` 和“尚未开放”占位。
- 消息正常路径没有 Mock 数据，也没有消息 Service 或云函数。
- 商品详情“联系卖家”只执行登录守卫，然后显示后续开放提示。
- 可复用 `AuthStore`、`AuthGuard`、`NavigationService`、空态/Loading 组件、统一云函数响应、客户端超时和页面请求代次保护。
- 现有公开用户以 `users._id` 作为安全 `publicUserId`；商品内部已有可信 `sellerOpenid` 与安全 `sellerId`。
- 现有公开商品、本人发布、收藏和公开主页能力不得回退。

## 2. 范围

本阶段实现：

- 消息中心真实会话列表；
- 商品维度的一对一会话创建或复用；
- 纯文本消息；
- 会话和消息历史游标分页；
- 参与者槽位未读计数；
- 进入会话标记已读；
- 发送中、发送失败和相同 `clientMessageId` 重试；
- 会话参与者权限；
- 商品详情“联系卖家”真实接入；
- 聊天页可见期间 8 秒轻量轮询。

本阶段不实现：

- 面交预约及其状态机；
- 图片、文件、语音、视频或地点消息；
- 撤回、删除、群聊、举报或拉黑；
- WebSocket、数据库 watch 和订阅通知；
- 消息 Tab 总未读角标；
- 第三个真实账号的非参与者越权真机测试（因当前没有第三个真实账号，低风险延期）。

## 3. 分层与接口

```text
pages/product-detail / pages/messages / pages/chat
→ services/message-service.js
→ messageAction / messageQuery
→ conversations / messages / users / products
```

页面不直接调用 `wx.cloud.callFunction()`，也不直接访问数据库。

### messageAction

| action | 输入 | 说明 |
| --- | --- | --- |
| `createOrGetConversation` | `productId` | 从云身份和商品可信卖家建立或复用会话 |
| `sendTextMessage` | `conversationId`、`content`、`clientMessageId` | 事务写消息、更新摘要、增加对方未读 |
| `markConversationRead` | `conversationId` | 只清零当前参与者槽位未读数 |

### messageQuery

| action | 输入 | 说明 |
| --- | --- | --- |
| `listConversations` | `pageSize`、`cursor` | 合并 A/B 槽位查询并稳定分页 |
| `getConversation` | `conversationId` | 校验参与者后返回安全会话头部 |
| `listMessages` | `conversationId`、`pageSize`、`cursor` | 校验参与者后倒序查询，客户端转正序 |

统一响应：

```js
{
  success,
  code,
  message,
  data
}
```

数据库或内部异常只映射为安全业务错误，不返回堆栈、集合名、完整身份或消息内容。

## 4. conversations 数据模型

```js
{
  _id,
  participantAOpenid,
  participantBOpenid,
  participantAUserId,
  participantBUserId,
  productId,
  productSnapshot: {
    productId,
    title,
    coverImage,
    price,
    status
  },
  lastMessage,
  lastMessageType,
  lastMessageAt,
  lastSenderOpenid,
  participantAUnreadCount,
  participantBUnreadCount,
  participantALastReadAt,
  participantBLastReadAt,
  createdAt,
  updatedAt
}
```

两个 OPENID 只用于服务端权限判断，按字典序稳定放入 A/B 槽位，不返回客户端。`participantAUserId` 和 `participantBUserId` 是安全 `users._id`。

客户端会话字段仅包括：

```text
conversationId
otherUser.publicUserId / nickname / avatarUrl / campus
product.productId / title / coverImage / price / status
lastMessage / lastMessageType / lastMessageAt
unreadCount / canSend
```

## 5. messages 数据模型

```js
{
  _id,
  conversationId,
  senderOpenid,
  senderPublicUserId,
  type: "text",
  content,
  clientMessageId,
  createdAt
}
```

规则：

- `content` 服务端 `trim`；
- 空字符串拒绝；
- 最大 500 字；
- 本阶段只接受 `type: "text"`，客户端不能指定类型；
- `senderOpenid` 和 `senderPublicUserId` 都由服务端从云身份及会话槽位产生；
- WXML 使用普通 `<text>` 绑定，不使用 `rich-text`；
- 安全响应不返回 `senderOpenid` 或 `clientMessageId`。

## 6. 确定性 ID 与幂等

会话 ID：

```text
c_ + SHA-256(productId:participantAOpenid:participantBOpenid)
```

同一商品、同一双方只能落到同一文档。快速重复点击或并发创建不会产生不同会话 ID。

消息 ID：

```text
m_ + SHA-256(conversationId:senderOpenid:clientMessageId)
```

失败重试继续使用同一个 `clientMessageId`。事务先用确定性消息文档 ID 读取；已存在则返回原消息，不重复增加未读数。

## 7. 事务与未读计数

发送事务只使用：

```text
transaction.collection(...).doc(...).get/set/update
```

不在事务内调用 `where`。

同一事务完成：

1. 读取并校验会话参与者；
2. 读取商品并阻止已删除商品继续发送；
3. 检查确定性消息文档；
4. 新建消息；
5. 更新会话最后消息摘要；
6. 只将对方槽位未读数加 1。

`markConversationRead` 在事务中只把调用者对应槽位清零，不修改对方槽位。重复调用保持 0。

## 8. 商品状态与会话规则

| 商品状态 | 创建新会话 | 打开既有会话 | 既有会话发送 |
| --- | --- | --- | --- |
| `available` | 允许 | 允许 | 允许 |
| `reserved` | 允许 | 允许 | 允许 |
| `offline` | 拒绝 | 允许 | 允许 |
| `sold` | 拒绝 | 允许 | 允许 |
| `deleted` | 拒绝 | 允许查看历史 | 拒绝 |

商品不存在时拒绝创建。本人商品始终拒绝创建自聊会话。客户端按钮状态只是体验优化，最终权限以云函数为准。

## 9. 稳定分页

会话排序：

```text
lastMessageAt DESC
_id DESC
```

消息排序：

```text
createdAt DESC
_id DESC
```

游标同时携带时间和 `_id`。下一页条件为：

```text
time < cursor.time
OR (time == cursor.time AND _id < cursor.id)
```

这避免相同时间戳产生重复或遗漏。消息页把云端倒序结果转换为正序显示。

## 10. 客户端页面

### pages/messages

- 登录守卫；
- 首次 Loading、空态、整页错误和重试；
- 对方头像与昵称；
- 商品摘要和状态；
- 最后一条消息、时间与未读角标；
- 下拉刷新、触底游标分页和去重；
- `onShow` 刷新已读结果；
- 请求代次与卸载保护。

### pages/chat

- 对方资料与商品摘要；
- 历史消息、双方气泡与时间；
- 触顶加载更早消息；
- 空消息和 500 字边界；
- 本地发送中状态；
- 失败消息点击重试，沿用原 `clientMessageId`；
- 发送成功后立即合并并刷新；
- 8 秒轻量轮询，隐藏或卸载后停止，前一请求未结束时不叠加；
- 进入和轮询成功后标记已读；
- 已删除商品显示只读提示。

消息 Tab 总角标本阶段未接入，避免扩大自定义 TabBar 范围；会话内未读与列表角标已完成。

## 11. 数据库集合、权限与索引

需要两个集合：

```text
conversations
messages
```

数据权限都应设置为：

```text
客户端不可读、不可写
仅云函数通过服务端身份访问
```

### conversations 索引

| 名称 | 字段顺序 | 唯一 |
| --- | --- | --- |
| `idx_participantA_lastMessageAt_id` | `participantAOpenid ASC` → `lastMessageAt DESC` → `_id DESC` | 否 |
| `idx_participantB_lastMessageAt_id` | `participantBOpenid ASC` → `lastMessageAt DESC` → `_id DESC` | 否 |
| `idx_product_participants_unique` | `productId ASC` → `participantAOpenid ASC` → `participantBOpenid ASC` | 是 |

### messages 索引

| 名称 | 字段顺序 | 唯一 |
| --- | --- | --- |
| `idx_conversation_createdAt_id` | `conversationId ASC` → `createdAt DESC` → `_id DESC` | 否 |
| `idx_conversation_sender_clientMessage_unique` | `conversationId ASC` → `senderOpenid ASC` → `clientMessageId ASC` | 是 |

确定性 `_id` 是第一层幂等约束，两个唯一索引作为业务兜底。2026-07-19 已通过 CloudBase 管理 API 反查字段顺序、方向与唯一性，5 个业务索引全部生效；集合另含系统 `_id_`、`_openid_1` 索引。

## 12. 安全与隐私

- 身份只来自 `cloud.getWXContext()`；
- 客户端创建会话只传 `productId`；
- 卖家 OPENID 优先从商品记录读取；兼容旧商品时，只允许通过商品 `sellerId` 对应的受信任 `users` 文档补齐；
- 每个查询和写入都校验当前 OPENID 位于参与者 A/B 槽位；
- 客户端伪造 `senderPublicUserId`、卖家或发送者字段不会生效；
- 安全响应显式构造，不透传数据库文档；
- 不返回 `openid`、`_openid`、`senderOpenid`、`sellerOpenid` 或参与者 OPENID；
- 日志只记录 action、步骤和安全错误码，不记录完整身份或消息内容；
- 两个新集合禁止客户端直读直写。

## 13. 自动验证

扩展 `scripts/verify-project.js`，覆盖：

- 页面路由、真实服务接入和占位路径移除；
- 未登录拒绝；
- 本人、缺失、下架和删除商品创建规则；
- 重复与并发会话创建；
- 参与者列表隔离；
- 非参与者读取会话、读取消息和发送拒绝；
- 空消息、超长消息；
- `clientMessageId` 幂等；
- 摘要与仅对方未读计数；
- `markRead` 调用者槽位隔离和幂等；
- 会话和消息双字段游标去重；
- 商品详情只提交 `productId`；
- 客户端不直连两个集合；
- 响应静态和动态隐私检查；
- 原有登录、商品、收藏、公开主页和禁用 seed 回归。

当前结果：

```text
Verification succeeded: 51 checks passed.
```

验证中的：

```text
[manageProduct] image cleanup incomplete
```

仍是原有预期失败路径日志，不是验证失败。

### WXML 编译回归验证

`pages/messages/index.wxml` 的成功态分支曾缺少 `wx:elif` 属性结束引号，导致微信开发者工具报 WXML 编译错误。现已修正，并把属性引号、`wx:if` / `wx:elif` 表达式、`wx:else` 用法和标签闭合纳入 `scripts/verify-project.js`。

阶段 9 的消息、聊天、商品详情和我的页面已完成 WXML 全量审计，没有发现第二处同类错误。微信开发者工具 Stable v2.01.2510290 真实编译运行无 WXML、WXSS、JavaScript、`__route__` 或缺失页面/组件错误；模拟器已实际检查首页、商品详情、消息、聊天和我的页面。消息页 Loading、空态、成功态均非白屏，无效 `conversationId` 会显示安全错误态。

## 14. 部署与最终人工验收

### 14.1 最终云端状态

2026-07-24 使用微信开发者工具 CLI 和 CloudBase 管理 API 实时反查：

| 项目 | 最终状态 |
| --- | --- |
| `authUser` | `Active`，`Nodejs16.13`，超时 10 秒 |
| `createProduct` | `Active`，`Nodejs16.13`，超时 10 秒 |
| `productQuery` | `Active`，`Nodejs16.13`，超时 10 秒 |
| `messageAction` | `Active`，`Nodejs18.15`，超时 10 秒 |
| `messageQuery` | `Active`，`Nodejs18.15`，超时 10 秒 |
| 生产依赖 | 两项消息函数使用 `wx-server-sdk 4.0.2`、`ws 8.21.1`，已通过远端 npm 安装部署 |
| 云端/本地 SHA-256 | 两项消息函数的 `index.js`、`package.json`、`package-lock.json` 共 6 个文件全部一致 |
| 非写入探针 | 两项消息函数非法 action 均返回 `INVALID_ACTION` |
| 集合权限 | `users`、`products`、`favorites`、`conversations`、`messages` 均为 `ADMINONLY` |
| 消息索引 | `conversations` 3 个、`messages` 2 个业务索引均按字段顺序、方向和唯一性反查通过 |

当前消息函数文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `messageAction/index.js` | `f3b4111e38aa06fdc4b8ffdc04d649e784894a37a612c5f474c063e33f1263f8` |
| `messageAction/package.json` | `09faec341a277f1e0acd6bfbb195fdaf3cc0923360f4f2afd7829d02925d4998` |
| `messageAction/package-lock.json` | `4c4a56fea1b465371c39331d8c499962aabcb87a4dd3e845f86c90ddd7952252` |
| `messageQuery/index.js` | `a2cdfa9b3ae89f7db7288f36519a684869be6e688dadc3486d8db62b452d5bc9` |
| `messageQuery/package.json` | `e2b11f943d6525f397cd70c444e0c332c64dc4089cdb2e6b6446d40a105cc68e` |
| `messageQuery/package-lock.json` | `580b82f501378dc833e52e296451842ee5fc8fb3b44665c83886da3c4041397e` |

### 14.2 双账号联合验收结论

2026-07-24 根据正式人工联合验收结果，以下项目均已通过：

- 两个真实微信账号登录并生成不同 `users` 记录；
- 新商品发布与真实卖家身份绑定；
- 联系卖家首次创建会话，重复联系复用同一会话；
- 双向文本消息收发、双方消息气泡方向；
- 未读计数增加与进入聊天后清零；
- 历史消息持久化、排序和分页；
- 空消息与 500 字限制；
- 发送失败、恢复网络和重试；
- 相同 `clientMessageId` 重试幂等，不重复消息、不重复增加未读；
- 8 秒轮询以及页面隐藏、退出、前后台切换时的启停；
- 消息中心下拉刷新、最后消息摘要、排序和未读角标；
- 本人商品禁止自聊；
- `available`、`reserved`、`offline`、`sold`、`deleted` 状态下的会话规则；
- 登录回跳；
- 双账号资料、商品、收藏和消息数据隔离；
- `conversations`、`messages`、`users` 最终数据核对。

阶段 9 主体功能和双账号联合验收据此判定通过。

### 14.3 唯一延期项目

未执行项：第三个真实账号 C 作为非参与者，读取 A/B 会话、读取 A/B 消息以及向 A/B 会话发送消息的真机测试。

- 延期原因：当前没有第三个真实微信账号；
- 风险等级：低；
- 风险依据：服务端所有相关查询和写入均校验当前 OPENID 位于参与者槽位，自动验证已覆盖非参与者读取会话、读取消息和发送均返回 `FORBIDDEN`；
- 后续补测：准备第三个真实账号 C，在不修改参与者字段、不直写数据库的前提下，分别调用 `getConversation`、`listMessages`、`sendTextMessage`，确认均返回 `FORBIDDEN`，且会话、消息、摘要和未读数均不变；
- 阻塞判断：该项属于低风险补充联合验收，不阻塞第九阶段完成或创建 `phase-9-complete`。

## 15. 已知风险与后续

- A/B 两条会话查询需合并；两个对应组合索引缺一不可。
- 会话页按需读取对方公开资料和商品当前状态，列表很大时需要关注查询成本。
- 8 秒轮询不是实时长连接；消息可能延迟到下一轮。
- 未实现总未读角标、后台对账、消息内容审核后台和推送通知。
- `wx-server-sdk@4.0.2` 依赖审计沿用现有风险，不执行破坏性 `npm audit fix --force`。
- 第三个真实账号的非参与者越权真机测试仍待补测；服务端校验和自动验证已覆盖，当前评估为低风险。

下一阶段建议独立实现面交预约业务，包括预约发起、接受、拒绝、取消和状态通知。

## 16. `27.md` 商品详情联系卖家误报修复

### 根因与真实数据

- 截图商品的真实路由和云端商品 ID 为 `product-009`。
- 2026-07-19 通过 `productQuery/detail` 只读调用确认：该文档真实存在，状态为 `available`，标题、价格、描述、标签、浏览数和收藏数均与截图一致。
- 页面数据源是 `ProductService` 调用真实 `productQuery`，没有 Mock 或本地缓存回退。
- 历史种子记录只有 `sellerId: user-009`，没有可信 `sellerOpenid`。旧 `messageAction` 把“商品不存在”“商品已删除”和“卖家身份不可用”统一返回为 `PRODUCT_NOT_FOUND`，客户端因此固定显示“商品已不存在”。
- 商品 ID 链路没有混用：列表和详情响应的 `_id` 在 `ProductService` 归一化为 `product.id`，详情页联系卖家时使用当前已展示商品的 `product.id`。

### 修复

- 详情页从当前展示商品读取并校验 `productId`，开发版仅记录 `productId`、是否已有商品和商品状态。
- `ProductService` 校验详情响应 ID 必须与请求 ID 一致，避免错误记录串页。
- `messageAction` 将状态拆分为：
  - 文档不存在：`PRODUCT_NOT_FOUND`；
  - `deleted`、`offline` 或为新会话打开 `sold` 商品：`PRODUCT_UNAVAILABLE`；
  - 卖家身份缺失或冲突：`PRODUCT_SELLER_UNAVAILABLE`；
  - 本人商品：`SELF_CONVERSATION_FORBIDDEN`。
- 对历史商品，只允许从 `sellerId` 对应的受信任 `users` 文档读取 OpenID；不接受客户端卖家身份，也不猜测或伪造卖家。
- 云端诊断只记录 action、商品 ID 是否存在及长度、文档是否命中和安全错误码，不记录完整商品 ID、用户身份或消息内容。
- 保留阶段 9 状态规则：`offline` / `sold` 不能新建会话，但既有会话仍可复用；`deleted` 可查看历史但不能发送。

### 验证与部署

- 当时 `npm run verify`：`Verification succeeded: 48 checks passed.`；阶段 9 最终收尾已扩展为 51 项并全部通过。
- 覆盖真实可用商品、本人商品、缺失商品、删除商品、下架/售出商品、旧商品卖家身份补齐、卖家身份不可用、重复及并发创建等路径。
- 全部 50 个 JavaScript 文件通过语法解析。
- `messageAction` 已于 2026-07-19 20:29:05 更新至 `cloud1-d9gpdpv6p2db56d8e`，云端状态为“部署完成”。
- `productQuery/detail(product-009)` 只读实测返回 `success: true`、`status: available`。
- 本节描述的是 `27.md` 修复当时尚未创建正式会话的历史状态；后续 `29.md` 和最终联合验收已经完成真实会话创建、复用与双向消息验证。

## 17. 正式收尾

2026-07-24 最终收尾检查：

```text
npm run verify：51 checks passed
全部 JavaScript：52 files，node --check 失败 0
git diff --check：通过
微信开发者工具：清理 compile 缓存后重新打开项目成功；阶段 9 最终运行无红色错误、异常或警告
工作区清理：node_modules、tmp 临时部署目录、测试日志、截图缓存、临时脚本、云函数下载文件均已移出项目并送入回收站
```

本轮没有修改业务功能，没有执行 `npm audit fix --force`，没有删除任何正式用户、商品、会话或消息数据。第九阶段满足正式收尾条件。
