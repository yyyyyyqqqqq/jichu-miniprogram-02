# 第十阶段：预约面交业务闭环

> 更新日期：2026-07-26
> 开发基线：`b2b685bc058c25ff55ccdd5697c6c692d9ea2065`（`phase-9-public-ready`）
> 当前状态：功能开发、58 项自动验证、云端部署、双账号完整流程和第三账号越权验收均已通过；等待本节记录对应的 Git 提交与 `phase-10-complete` 标签收尾

## 1. 阶段目标

本阶段在既有商品会话中增加真实线下面交预约：

```text
商品会话
→ 发起预约
→ 选择未来时间和结构化地图地点
→ 对方接受或拒绝
→ 发起方或允许的参与者取消
→ 仅卖家确认完成
→ 预约 completed 与商品 sold 原子更新
→ 其他有效预约自动关闭
```

预约不是支付订单，不涉及资金、担保、物流、收货地址或结算。

## 2. 实际工程审计

开发前确认：

- Git HEAD、`main` 和 `origin/main` 均位于阶段 9 公开稳定基线，工作区干净。
- 真实工程没有预约集合、预约 Service、预约云函数或预约页面。
- `pages/chat`、`MessageService`、`messageAction` 和 `messageQuery` 已提供真实会话、事务消息、稳定游标和参与者校验。
- 商品使用 `available / reserved / offline / sold / deleted` 等状态；已有管理操作仅允许真实卖家修改商品状态。
- 消息只支持 `text`，因此本阶段进行兼容扩展，增加只由服务端生成的 `system` 消息。
- `pages/location-picker` 原为占位页，商品仅有旧 `location` 字符串。第十阶段实现真实 `wx.chooseLocation`，不迁移或伪造旧商品坐标。

阶段设计采用用户确认的安全规则：只有商品卖家能最终完成预约并将商品标记为 `sold`。买家不能直接或间接修改商品状态。

## 3. 分层与文件

```text
pages/appointment-create
pages/appointment-detail
pages/appointments
pages/chat
→ services/appointment-service.js
→ appointmentAction / appointmentQuery
→ appointments / conversations / messages / products / users
```

页面不直接调用云函数，也不直接访问数据库集合。地图页只负责微信原生选点和通过页面事件通道返回安全地点结构。

## 4. appointments 数据模型

```js
{
  _id,
  productId,
  conversationId,

  buyerOpenid,
  sellerOpenid,
  buyerUserId,
  sellerUserId,
  initiatorOpenid,

  scheduledAt,
  location: {
    name,
    address,
    latitude,
    longitude
  },
  note,

  status,
  activeKey,
  isDeleted,
  cancelReason,

  createIdempotencyKey,
  lastActionType,
  lastActionIdempotencyKey,
  lastActionBy,

  createdAt,
  updatedAt,
  acceptedAt,
  rejectedAt,
  cancelledAt,
  completedAt
}
```

服务端生成字段：

- `_id`、参与者身份、参与者公开用户 ID；
- `status`、`activeKey`、全部状态时间；
- `lastActionBy` 和幂等操作字段；
- 创建时间和更新时间。

客户端只提交：

```text
conversationId
scheduledAt
location
note
idempotencyKey
```

客户端响应不包含任何内部身份字段。参与者仅以 `isSeller`、`isInitiator`、按钮权限和安全公开资料表示。

预约 ID：

```text
a_ + SHA-256(conversationId:initiatorIdentity:idempotencyKey)
```

有效预约使用：

```text
activeKey = "active"
```

结束后改为：

```text
activeKey = "closed:<appointmentId>"
```

配合唯一组合索引，保证同一商品和双方不能并发存在多个有效预约，同时允许已结束后创建新记录。

## 5. 时间、地点和备注

- `scheduledAt` 必须晚于服务端当前时间，且不超过未来 30 天。
- 地点名称最长 80 字，地址最长 120 字。
- 纬度范围 `[-90, 90]`，经度范围 `[-180, 180]`。
- 拒绝 `0,0`，不为旧商品伪造坐标。
- 备注可选，服务端 `trim`，最长 200 字。
- 旧商品的 `location` 字符串只作为默认地点名称展示；提交新预约前仍须真实地图选点。

## 6. 状态机

```text
pending  → accepted
pending  → rejected
pending  → cancelled
accepted → cancelled
accepted → completed
```

禁止所有终态逆向迁移。

状态权限：

| 当前状态 | 操作 | 权限 |
| --- | --- | --- |
| `pending` | 接受、拒绝 | 非发起方参与者 |
| `pending` | 取消 | 发起方 |
| `accepted` | 取消 | 买卖双方 |
| `accepted` | 完成 | 仅商品真实卖家 |
| `rejected/cancelled/completed` | 修改 | 禁止 |

买家查看 `accepted` 预约时显示“等待卖家确认面交完成”，不显示完成按钮。

## 7. 云函数接口

### appointmentAction

| action | 输入 | 事务与权限 |
| --- | --- | --- |
| `create` | 会话、时间、地点、备注、幂等键 | 校验参与者、商品卖家、商品状态、地点、时间和有效预约唯一性；创建预约和系统消息 |
| `accept` | 预约 ID、幂等键 | 仅非发起方处理 `pending` |
| `reject` | 预约 ID、幂等键 | 仅非发起方处理 `pending` |
| `cancel` | 预约 ID、幂等键 | `pending` 仅发起方；`accepted` 双方 |
| `complete` | 预约 ID、幂等键 | 仅卖家处理 `accepted`；预约完成、商品 `sold`、完成消息原子提交 |
| `retryProductSoldCleanup` | 商品 ID | 仅已售商品卖家重试关闭其他有效预约 |

稳定错误码：

```text
INVALID_ACTION
UNAUTHORIZED
INVALID_PARAMS
PRODUCT_NOT_FOUND
PRODUCT_UNAVAILABLE
SELF_APPOINTMENT_NOT_ALLOWED
CONVERSATION_NOT_FOUND
FORBIDDEN
APPOINTMENT_NOT_FOUND
APPOINTMENT_ALREADY_EXISTS
INVALID_APPOINTMENT_TIME
INVALID_APPOINTMENT_LOCATION
INVALID_STATUS_TRANSITION
ACTION_NOT_ALLOWED
IDEMPOTENCY_CONFLICT
DATABASE_ERROR
INTERNAL_ERROR
```

### appointmentQuery

| action | 输入 | 说明 |
| --- | --- | --- |
| `detail` | 预约 ID | 仅参与者可读取安全详情 |
| `listMine` | `pending / accepted / ended`、页大小、游标 | 分别查询买家和卖家分支，合并去重后稳定分页 |
| `getActiveByConversation` | 会话 ID | 校验会话参与者并返回当前有效预约 |

列表排序：

```text
updatedAt DESC
_id DESC
```

游标同时携带时间和 `_id`，相同时间记录不会重复或遗漏。

## 8. 消息系统联动

`messages` 增加兼容类型：

```js
{
  type: "system",
  eventType,
  appointmentId,
  productId,
  content
}
```

事件：

```text
appointment_created
appointment_accepted
appointment_rejected
appointment_cancelled
appointment_completed
appointment_auto_cancelled
```

系统消息：

- 只能由预约云函数生成；
- 使用 `appointmentId + eventType` 生成确定性消息 ID；
- 同时生成唯一的服务端 `clientMessageId`，兼容现有消息唯一组合索引；
- 重复操作不会重复写消息或增加未读；
- 在同一事务中更新会话最后消息；
- 只增加另一方槽位未读数；
- 沿用消息的 `createdAt DESC + _id DESC` 游标；
- 聊天页显示不可编辑卡片，点击进入预约详情。

`messageQuery` 显式白名单返回 `system` 消息所需字段，不返回内部身份。

## 9. 商品状态与补偿策略

卖家完成预约的核心事务必须同时：

1. 重读预约；
2. 验证参与者和真实卖家；
3. 验证预约为 `accepted`；
4. 验证商品存在、未删除且仍可完成；
5. 将预约更新为 `completed`；
6. 将商品更新为 `sold` 并增加 `version`；
7. 写入完成系统消息；
8. 更新会话摘要和对方未读。

其他预约关闭采用核心事务后的补偿流程：

- 查询同商品其他 `pending / accepted` 预约；
- 每条使用独立事务改为 `cancelled`；
- 写入 `cancelReason = "product_sold"`；
- 生成确定性自动关闭消息；
- 每批最多处理 100 条；
- 失败只记录脱敏日志，不回滚已完成的真实面交；
- 重复完成请求和 `retryProductSoldCleanup` 都会安全重试；
- 页面发现 `cleanupPending` 时会额外发起一次重试。

## 10. 页面与交互

### 聊天页

- 商品上下文下增加“预约面交”入口；
- 有有效预约时显示状态和预约时间，并进入详情；
- 系统消息使用居中的预约卡片；
- 预约状态随原 8 秒消息轮询刷新。

### 发起预约

- 商品和对方摘要；
- 未来 30 天日期与时间；
- 旧地点字符串提示；
- 真实地图选点；
- 结构化地点预览；
- 200 字备注；
- 防重复提交和固定创建幂等键。

### 预约详情

- 状态、商品、角色、时间、结构化地点、备注和时间线；
- 根据服务端安全权限显示接受、拒绝、取消或完成；
- 卖家完成前显示不可撤销二次确认；
- 买家不显示完成按钮。

### 我的预约

- 个人中心入口；
- 待处理、进行中、已结束三类；
- Loading、空态、错误态、下拉刷新和稳定分页。

### 地图选点

- 复用并实现原 `pages/location-picker`；
- 使用 `wx.chooseLocation`；
- 取消、权限拒绝和打开失败均有安全提示；
- 取消不会覆盖发起页原地点；
- 不保存或返回虚假坐标。

## 11. 数据库权限

待创建：

```text
appointments
```

权限必须设置为：

```text
ADMINONLY
```

客户端不得直接读写。现有 `conversations` 和 `messages` 权限不能降低。

## 12. 索引清单

以下索引已于 2026-07-25 在云端创建并反查可用：

| 名称 | 字段顺序 | 唯一 | 查询 |
| --- | --- | --- | --- |
| `idx_buyer_deleted_updatedAt_id` | `buyerOpenid ASC` → `isDeleted ASC` → `updatedAt DESC` → `_id DESC` | 否 | 买家全部列表 |
| `idx_seller_deleted_updatedAt_id` | `sellerOpenid ASC` → `isDeleted ASC` → `updatedAt DESC` → `_id DESC` | 否 | 卖家全部列表 |
| `idx_buyer_status_deleted_updatedAt_id` | `buyerOpenid ASC` → `status ASC` → `isDeleted ASC` → `updatedAt DESC` → `_id DESC` | 否 | 买家状态筛选 |
| `idx_seller_status_deleted_updatedAt_id` | `sellerOpenid ASC` → `status ASC` → `isDeleted ASC` → `updatedAt DESC` → `_id DESC` | 否 | 卖家状态筛选 |
| `idx_product_pair_active_unique` | `productId ASC` → `buyerOpenid ASC` → `sellerOpenid ASC` → `activeKey ASC` | 是 | 有效预约唯一性 |
| `idx_conversation_status_deleted_updatedAt_id` | `conversationId ASC` → `status ASC` → `isDeleted ASC` → `updatedAt DESC` → `_id DESC` | 否 | 会话有效预约 |
| `idx_product_status_updatedAt_id` | `productId ASC` → `status ASC` → `updatedAt DESC` → `_id DESC` | 否 | 已售商品补偿清理 |
| `idx_initiator_create_key_unique` | `initiatorOpenid ASC` → `createIdempotencyKey ASC` | 是 | 创建幂等兜底 |

部署前应先创建集合并设置 `ADMINONLY`，再创建上述 8 个索引。完成后必须反查字段顺序、方向、唯一性和索引状态。

控制台操作步骤：

1. 进入目标 `YOUR_CLOUDBASE_ENV_ID` 的云开发控制台。
2. 在数据库中创建 `appointments` 集合。
3. 将集合权限设置为“所有用户不可直接读写 / 仅管理员与云函数访问”，并反查为 `ADMINONLY`。
4. 按上表逐项创建 8 个组合索引，严格保持字段顺序、升降序和唯一性。
5. 等待所有索引状态变为可用，再部署预约云函数并进行真实调用。
6. 部署后重新查询权限和索引，不能只依赖控制台提交成功提示。

## 13. 自动化验证

验证体系从 51 项扩展到 58 项；原有 57 项全部保留，新增 1 项预约—商品状态联动检查。预约测试包含：

- 未登录、商品缺失、删除、下架、自有商品和会话不匹配；
- 服务端身份和参与者推导；
- 时间、地点、备注边界；
- 创建重复、并发同幂等键和有效预约唯一性；
- 买家、卖家和第三方查询隔离；
- 接受、拒绝、取消、终态禁止逆转；
- `pending` 不改变商品，接受时预约与商品原子进入
  `accepted + reserved`；
- 同一商品允许多个 `pending`，但第二条接受会被商品状态闸门拒绝；
- 重复接受幂等，不重复写系统消息、未读数或商品版本；
- 取消 `accepted` 时事务内检查其他 `accepted`，满足条件才恢复
  `available`；
- `sold/offline/deleted` 不会被取消流程错误恢复；
- 首页、详情、收藏、用户主页和“我的发布”一致展示 `reserved`；
- `reserved` 商品保留联系卖家入口，但不能新建或接受预约；
- 返回页面和下拉刷新取得最新商品状态；
- 买家和第三方不能完成；
- 仅卖家完成；
- 预约完成和商品 `sold` 原子一致；
- 其他有效预约自动关闭；
- 自动关闭和补偿重试幂等；
- 系统消息、会话摘要和未读槽位；
- 系统消息客户端标准化与隐私；
- 稳定分页；
- 地图取消处理和无虚假坐标；
- 预约查询失败时聊天继续可用，且消息服务错误不会被吞掉；
- 原阶段 1—9 商品、登录、收藏和消息回归。

当前本地结果：

```text
npm run verify
Verification succeeded: 58 checks passed.
JavaScript syntax: 62 files passed.
appointmentAction production dependency tree and Node load: passed.
appointmentQuery production dependency tree and Node load: passed.
messageQuery production dependency tree and Node load: passed.
```

验证输出中的图片清理失败日志仍是阶段 7 的预期失败路径，不是测试失败。
未执行破坏性的 `npm audit fix --force`。

## 14. 人工验收结果

### 双账号

1. 卖家 A 发布 `available` 商品。
2. 买家 B 进入详情并联系卖家。
3. B 在聊天页点击“预约面交”。
4. 确认旧商品地点字符串只作提示，不出现伪造坐标。
5. 取消一次地图选点，确认表单原数据不变。
6. 重新打开地图并选择真实校园地点。
7. 选择未来时间、填写备注并提交。
8. 确认聊天只出现一条创建系统消息，A 未读增加。
9. B 重复操作不会创建第二条有效预约。
10. A 打开系统卡片并接受。
11. 双方详情同步为 `accepted`。
12. B 端只显示等待卖家完成，不显示完成按钮。
13. A 点击完成，核对二次确认文案。
14. A 确认后预约变为 `completed`，商品变为 `sold`。
15. 重复完成不产生重复消息或未读。
16. 已售商品不能创建新预约。
17. 分别验证发起方取消和非发起方拒绝。
18. 重启小程序后列表和详情状态可以恢复。
19. 下拉刷新和列表分页无重复。

### 多买家与第三账号

1. B、C 对同一商品分别建立会话和有效预约。
2. A 完成其中一条。
3. 另一条自动变为 `cancelled`，原因是商品已售。
4. 受影响会话只出现一条自动关闭系统消息。
5. 非参与者账号不能读取详情、枚举或执行任何状态操作。

2026-07-26 最终人工验收结论：

- 双账号完整预约流程通过；
- 地图取消保留原表单、真实地图选点和结构化坐标提交通过；
- 创建、接受、拒绝、取消、完成、预约列表和状态恢复通过；
- 系统消息各写入一次，普通聊天和未读数无回归；
- 同商品允许多个 `pending`，第二条 `accepted` 被服务端阻止；
- 第三账号不能读取、枚举或操作非参与预约；
- 商品状态联动通过：
  `pending + available`、`accepted + reserved`、
  `cancelled + available`、`completed + sold`。

## 15. 部署清单

2026-07-25 已在本机私有配置指定的真实环境完成：

```text
appointments      0 条记录 / ADMINONLY / 8 个业务索引
appointmentAction Active / Nodejs18.15 / index.main / 10 秒 / 256 MB
appointmentQuery  Active / Nodejs18.15 / index.main / 10 秒 / 256 MB
messageQuery      Active / Nodejs18.15 / index.main / 10 秒 / 256 MB
```

三项函数的 `index.js / package.json / package-lock.json` 共 9 个文件均已下载反查，云端与本地 SHA-256 一致。云端生产依赖均为 `wx-server-sdk@4.0.2` 和 `ws@8.21.1`。

安全探针结果：

- CLI 无身份上下文：非法 action 为 `INVALID_ACTION`，合法预约 action 为 `UNAUTHORIZED`；
- 当前开发者工具登录身份：`listMine` 成功返回空列表，已有会话的 `getActiveByConversation` 成功返回空，缺少创建参数为 `INVALID_PARAMS`；
- 既有会话和 3 条 text 消息可读，消息返回未出现内部身份字段；
- 普通客户端直接读、更新、删除 `appointments` 均被数据库权限拒绝；
- 所有探针前后 `appointments` 均为 0 条，没有创建测试预约。

聊天页已将预约请求隔离：预约模块异常时显示“预约功能暂不可用”，不会阻断会话和消息；消息服务失败仍进入会话错误态。

## 16. 已知风险与延期项

- 其他预约关闭不与核心完成事务跨会话原子提交，采用幂等补偿。
- 单次补偿最多处理 100 条，极端情况下需要继续重试。
- `wx.chooseLocation` 依赖用户授权和微信地图能力。
- 旧商品没有结构化地点，不能直接提交预约。
- 预约仍依赖 8 秒轮询，不是实时推送。
- 云函数和 `wx-server-sdk@4.0.2` 沿用现有依赖审计风险。

## 17. Git 状态

提交前文档快照中的 Git 收尾信息：

- 目标分支：`main`；
- 提交标题：`feat: complete meetup appointment workflow`；
- 提交哈希：由包含本文件的最终 Git 提交记录为准；
- 完成标签：`phase-10-complete`，指向上述最终提交；
- 推送目标：`origin/main` 和远端同名标签；
- 不重写历史、不 force push、不移动任何旧阶段标签。

提交对象无法在自身文件内容中稳定嵌入自己的最终哈希；完整提交哈希、annotated
tag 对象哈希和远端同步结果由最终验收报告及 Git 对象记录提供。

## 18. 预约—商品状态联动修复（2026-07-26）

### 18.1 根因与状态语义

根因是原 `appointmentAction.accept` 事务只校验商品可交易并更新预约，
没有更新关联商品；同时 `reserved` 被错误地视为可创建、可接受预约的状态。
因此预约可进入 `accepted`，商品仍保持 `available`，并且同商品可能继续接受
其他预约。

商品状态的最终语义为：

| 状态 | 语义 | 公开首页 | 公开详情 | 新建/接受预约 |
| --- | --- | --- | --- | --- |
| `draft` | 未公开草稿 | 否 | 否 | 否 |
| `available` | 公开在售 | 是，显示“在售” | 是 | 是 |
| `reserved` | 已有唯一接受预约 | 是，显示“已预定” | 是 | 否 |
| `offline` | 卖家主动下架 | 否 | 否 | 否 |
| `sold` | 已完成面交，不可逆 | 否 | 是，仅保留详情 | 否 |
| `deleted` | 软删除 | 否 | 否 | 否 |

`messageAction` 仍允许 `reserved` 商品建立或复用普通会话，因此用户可继续联系
卖家；预约创建页、聊天预约入口和服务端创建事务均只接受 `available`。

### 18.2 最终状态机与并发规则

- 创建预约：`available + create → pending + available`。
- 接受预约：同一事务执行
  `pending + available → accepted + reserved`，并记录
  `reservedAppointmentId`、`reservedAt` 及商品版本。
- 拒绝或取消 `pending`：预约进入终态，商品保持 `available`。
- 取消 `accepted`：同一事务内查询同商品其他未删除 `accepted`；
  仅在不存在其他接受预约且商品仍为 `reserved` 时恢复 `available`。
  若兼容历史数据时仍有其他 `accepted`，事务保持 `reserved` 但递增商品版本，
  使并发取消在同一商品文档上冲突重试，避免最后一条取消后的残留状态。
- 完成 `accepted`：同一事务更新为 `completed + sold`，清空预定归属；
  其他有效预约继续使用原有确定性系统消息和幂等补偿关闭。
- `sold` 不可逆；取消、重试和补偿均不把 `sold/offline/deleted`
  恢复为 `available`。

多预约策略收紧为“多个 `pending`、单个 `accepted`”。本轮不新增索引：
接受事务必须写同一商品文档，首个接受把商品从 `available` 改为 `reserved`；
并发的第二个事务会冲突重试并读到 `reserved`，从而返回现有
`PRODUCT_UNAVAILABLE`。已有按买卖双方限制有效预约的唯一索引保留不变，
没有删除或迁移任何生产预约。

为兼容修复前数据，重复调用同一 `accept` 时若预约已为 `accepted`、商品仍为
`available`，事务会补齐 `reserved`，但不会重复系统消息或未读数。本次部署
未主动批量修改历史生产数据；修复前已经不一致的记录仍需通过人工回归确认，
不能在未确认具体业务记录的情况下自动改库。

### 18.3 查询、页面与商品管理

- `productQuery.list` 仅公开 `available/reserved`，不返回
  `draft/offline/sold/deleted`。
- `productQuery.detail` 继续返回 `available/reserved/sold`。
- 商品卡片和详情统一复用状态元数据：
  `available → 在售`，`reserved → 已预定`。
- “我的发布”的“在售”筛选同时返回 `available/reserved`；`reserved`
  只展示说明，不提供编辑、下架、标记已售或删除按钮。云端
  `manageProduct` 原有状态守卫会拒绝这些操作，因此本轮无需修改或部署该函数。
- 收藏列表和用户主页商品列表补充 `reserved`，并保留真实状态，不再硬编码
  `available`。
- 接受、取消和完成导致商品变化时递增 `AppStore.productsVersion`；
  首页和“我的发布”按版本刷新，详情与用户主页返回时重新查询，收藏页在商品
  版本变化后刷新；所有相关页面仍支持下拉刷新。

### 18.4 自动测试

新增或调整的覆盖包括：

1. 创建一个或多个 `pending` 后商品仍为 `available`。
2. 接受事务同时得到 `accepted + reserved` 并记录预定归属。
3. 重复接受不重复消息、未读、商品版本。
4. `reserved` 不能创建新预约，也不能接受其他 `pending`。
5. 被阻止的 `pending` 详情不显示接受按钮。
6. 拒绝 `pending` 不改变商品。
7. 取消 `pending` 不改变商品。
8. 取消唯一 `accepted` 恢复 `available` 并清除预定归属。
9. 单 `accepted` 规则阻止第二条接受。
10. 已变为 `sold` 的商品不会被取消流程恢复。
11. 完成后保持 `completed + sold`，补偿重试幂等。
12. 首页查询同时返回 `available/reserved`。
13. 首页排除 `draft/offline/sold/deleted`。
14. `reserved` 状态文案为“已预定”。
15. 商品详情、卡片和其他商品列表使用同一状态映射。
16. 创建页与聊天入口阻止 `reserved` 新预约。
17. 首页、详情、收藏和用户主页具备 `onShow`/版本刷新路径。
18. 原商品、登录、收藏、消息和预约测试全部回归。

本地结果：

```text
npm run verify
Verification succeeded: 58 checks passed.
```

5 个修改函数的生产依赖树和 Node 加载均通过。验证输出中的图片清理失败日志
仍是阶段 7 的预期失败路径。

### 18.5 实际部署与只读核验

2026-07-26 仅部署了实际修改的 5 个函数：

```text
appointmentAction Active / Nodejs18.15 / index.main / 10 秒 / 256 MB
appointmentQuery  Active / Nodejs18.15 / index.main / 10 秒 / 256 MB
productQuery      Active / Nodejs16.13 / index.main / 10 秒 / 256 MB
favoriteProduct   Active / Nodejs18.15 / index.main / 10 秒 / 256 MB
userQuery         Active / Nodejs18.15 / index.main / 10 秒 / 256 MB
```

5 个函数的 `index.js / package.json / package-lock.json` 共 15 个文件均已
下载反查，云端与本地 SHA-256 为 `15/15` 一致。部署后只读调用
`productQuery.list` 返回 18 条，状态集合仅为 `available,reserved`，
禁用状态数量为 0。

本轮没有写入测试预约或商品，没有修改集合权限，没有新增、删除或修改索引。

### 18.6 人工回归结果

1. 新建商品后首页显示“在售”：通过。
2. 创建 `pending` 后商品保持“在售”：通过。
3. 卖家接受后首页和详情显示“已预定”：通过。
4. 第二条接受被阻止，普通聊天仍可用：通过。
5. 取消唯一 `accepted` 后恢复“在售”：通过。
6. 再次预约并完成后商品变为“已出”且公开首页隐藏：通过。
7. 完成后的取消、重复完成和补偿均不会恢复“在售”：通过。
8. 系统消息、未读数、预约列表和普通聊天无回归：通过。
9. 第三账号不能查看或操作非参与预约：通过。

### 18.7 本地私有配置与 Git 边界

- `project.private.config.json`、`config/cloud.private.js` 和
  `00-项目总交接文档.md` 仅保留在本地；
- 三个文件均被 `.gitignore` 命中且未被 Git 跟踪；
- 公开配置只使用 `YOUR_WECHAT_APP_ID`、`YOUR_CLOUDBASE_ENV_ID`、
  `<PROJECT_ROOT>` 和 `<WECHAT_DEVTOOLS_CLI_PATH>` 等占位符；
- `config/cloud.private.example.js` 仅提供空白公开模板；
- 不提交真实 AppID、云环境 ID、OPENID、密钥、本机绝对路径或内部交接资料；
- Git 收尾按第 17 节执行，不 force push、不重写历史、不移动旧标签。
