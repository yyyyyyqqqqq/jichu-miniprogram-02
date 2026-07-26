# 第十三阶段：聊天富消息

更新时间：2026-07-26

## 1. 当前状态

本阶段已完成，范围包括：

- 文本 / 语音输入模式切换；
- 按住录音、上滑取消、最长 60 秒、最短 1 秒；
- 语音上传、气泡、单实例播放和失败重试；
- 相册 1～9 张图片、直接拍摄、逐张上传和独立失败恢复；
- 位置选点确认、位置卡片和微信地图查看；
- 独立“选择商品”页中的“我的商品 / 对方商品”受控选择、分页、服务端快照和商品卡片；
- `text / voice / image / location / product / system` 向后兼容；
- 未知消息类型安全降级；
- 本地 SVG 图标、动态底部布局和安全区域；
- 麦克风和位置权限说明；
- 原有文本、预约、分页、未读和顶部会话商品功能回归。

2026-07-26 已完成代码审计、必要修复和云端代码部署：

- 仅部署 `messageAction`、`messageQuery`；
- 两项均为 `Active / Available`、`Nodejs18.15`、10 秒、256 MB、`index.main`；
- 6 个关键文件的云端下载副本与本地 SHA-256 全部一致；
- 云端包均包含并可加载 `wx-server-sdk@4.0.2`、`ws@8.21.1`；
- `conversations / messages / products / users` 实时反查仍为 `ADMINONLY`；
- 3 个本阶段依赖的业务索引字段、方向和唯一性均正确；
- 登录态无写入探针及非参与者探针通过，探针前后消息与会话数量均保持不变；
- 没有修改数据库或云存储权限，没有新增、删除或修改索引，没有写入生产测试消息。

用户已于 2026-07-26 完成最终真机验收并明确确认当前问题全部解决。语音、图片、拍摄、位置、商品卡片、独立商品选择页、输入框布局、商品图片预览返回和相关安全交互均纳入本次最终结论；第十三阶段可以正式标记为完成。

本地结果：

```text
npm run verify
Verification succeeded: 67 checks passed.

git diff --check
passed

微信开发者工具 CLI open
passed
```

开发者工具 `open / auto` 证明项目已被真实工具接受和编译；真机结论来自用户的最终实际验收，不以自动化或模拟检查替代。

## 2. 入口和交互

聊天底部仍使用纵向 flex：

```text
聊天页
├─ 顶部用户 / 当前会话商品 / 预约入口
├─ 消息滚动区（自动占据剩余空间）
└─ chat-dock
   ├─ 文本模式：语音切换 / textarea / 加号或发送
   ├─ 语音模式：键盘切换 / 按住说话 / 加号
   └─ 扩展面板：相册 / 拍摄 / 位置 / 发送商品

独立页面 pages/chat-product-picker/index
├─ 我的商品 / 对方商品分段切换
├─ 双方各自独立的列表、稳定游标、加载/错误/空状态
└─ 商品卡片发送按钮
```

扩展面板继续参与聊天页正常布局；原聊天底部商品面板已完整删除。“发送商品”会先收起扩展面板，再只携带 `conversationId` 进入独立页面。发送成功后 `navigateBack`，聊天页既有 `onShow → refreshLatestMessages → renderMessages(true)` 链路拉取并滚动到新消息；直接返回不会发送。文本切到语音时保留 `inputValue`，切回后仍可继续编辑。切换模式不会主动申请麦克风权限，只有按下录音按钮时才申请。

textarea 最初使用 `18rpx 20rpx 14rpx`，经两次 padding 调整后为 `20rpx 20rpx 12rpx`，但真机中原生 textarea 的字体基线和 rpx 到物理像素取整使 1rpx 重分配几乎不可见。最终保留该 padding，仅在 textarea 自身增加 `transform: translateY(2rpx)`；外层没有叠加 padding 或 transform。`55.md` 已按产品要求直接从 WXML 删除 `placeholder` 和 `placeholder-class`，空输入框不显示任何提示文字。输入文字和光标继续随原生输入组件整体下移；背景、圆角、总高度、最小/最大高度、行高、500 字限制和 auto-height 均未改变。

文本模式保持三列 flex：左侧模式按钮固定 72rpx，中间 `width: 0 + flex: 1 1 auto`，右侧 `width: auto + flex: 0 0 auto`。为避免原生 button 固有尺寸参与 flex 自动尺寸时挤压中间列，右侧操作区限制为 72～108rpx，发送按钮限制为 92～108rpx、左右 padding 14rpx；空输入显示 72rpx 加号，有输入显示紧凑“发送/发送中”。语音模式和“按住说话”样式没有改变。

原来的左侧 CSS 麦克风占位已改为“语音输入切换”图标；语音模式下显示键盘图标，避免把入口误解成正在录音。

## 3. 录音和播放

录音使用微信全局单例 `RecorderManager`，页面只保存引用和固定回调：

- 首次初始化只创建一次 `onStart / onStop / onError` 回调；
- 页面 `onShow` 绑定，`onHide / onUnload` 用同一函数引用解绑，避免多个聊天页重复接收全局录音回调；
- 单独跟踪 `start()` 已请求但 `onStart` 未到达的窗口，快速松手或切页仍会调用 `stop()` 并清理状态；
- `touchstart` 先检查 `scope.record`，授权后开始；
- `touchmove` 使用“起始 Y - 当前 Y”计算 80px 取消阈值；
- 正常 `touchend` 停止并发送；
- 进入取消区域后松手或 `touchcancel` 只停止、不发送；
- 不足 1 秒提示“说话时间太短”；
- 最大 60 秒由录音管理器自动停止并进入发送；
- 页面隐藏、卸载时停止录音并清理计时状态；
- 开始录音前停止正在播放的语音。

录音浮层显示秒数和两种明确状态：

```text
正常：手指上滑，取消发送
取消：松开手指，取消发送
```

播放使用页面级 `InnerAudioContext`。同一时间只有一条语音播放；再次点击当前语音停止，点击另一条会先停止上一条。页面隐藏时停止，卸载时销毁实例。

## 4. 图片和拍摄

相册与拍摄只在 `sourceType` 不同，后续共用 `chooseAndSendImages(sourceType)`：

- `mediaType` 固定为 `image`；
- 相册入口固定 `album`，拍摄入口固定 `camera`；
- 一次最多 9 张；
- 使用压缩图片；
- 校验扩展名、实际解码结果、尺寸和单张 10MB 上限；
- 顺序准备、顺序上传，避免同时上传过多；
- 每张图片一条消息、一个独立 `clientMessageId`；
- 单张失败保留自己的本地待发记录，不阻断后续图片；
- 点击已发送图片调用微信图片预览；
- 用户取消选择或拍摄不显示错误。

## 5. 位置消息

位置不是持续共享位置，也不后台追踪。

用户主动点击“位置”后调用 `wx.chooseLocation`，在微信地图中选择并确认名称、地址、纬度和经度。只有选择成功且字段完整时才创建消息；取消不发送，拒绝权限会引导打开设置。

消息卡片不直接展示经纬度，只显示地点名称、地址摘要和“查看位置”。点击后调用 `wx.openLocation`，不跳转外部网页。

服务端限制：

```text
latitude  -90 ～ 90
longitude -180 ～ 180
name      1 ～ 80 字符
address   1 ～ 200 字符
```

## 6. 商品选择和安全边界

独立商品选择页只接受 URL 参数 `conversationId`。分页查询继续只提交：

```text
conversationId
ownerScope: self | other
pageSize
稳定游标
```

客户端不传当前会话商品 ID、任意 ownerId、对方 OPENID 或商品快照。`messageQuery` 先验证当前用户是会话参与者，再从会话的 A/B 槽位解析目标 OPENID 和公开用户 ID，并在服务端排除 `conversation.productId`。新页面复用 `MessageService.listConversationProducts`，没有新增云函数、集合、索引或权限分支。

候选商品：

- 仅当前会话双方的商品；
- 仅 `available / reserved / sold`；
- 排除当前会话顶部关联商品；
- 排除 `offline / deleted` 和第三方商品；
- 按 `createdAt DESC, _id ASC` 稳定分页；
- 只返回商品卡片所需公开字段。

发送时客户端只提交 `productId`。`messageAction` 在同一事务内重新读取商品，验证真实存在、状态可展示、所有者属于本会话双方且不是当前会话商品，再从数据库生成标题、封面、价格、状态和所有者公开 ID 快照。客户端提交的标题、价格、封面或 owner 字段不会进入数据库。

发送按钮使用页面级互斥锁；首次点击生成并保留 `clientMessageId`，失败后用同一键重试。发送失败停留当前页，成功后返回聊天页。两个 owner scope 分别保留列表和游标，切换时不会串页。

点击历史商品卡片时仍查询当前商品详情；商品已经失效时只提示“商品已失效”，不使用历史快照绕过当前访问状态。

## 7. 消息模型

旧文本和预约系统消息不迁移。新记录按类型只写对应载荷：

```js
// voice
{
  type: 'voice',
  conversationId,
  senderOpenid,          // 服务端身份
  senderPublicUserId,    // 服务端从会话槽位确定
  clientMessageId,
  createdAt,             // serverDate
  media: {
    fileId,
    durationMs,
    size,
    format: 'mp3'
  }
}

// image
{
  type: 'image',
  media: { fileId, width, height, size }
}

// location
{
  type: 'location',
  location: { name, address, latitude, longitude }
}

// product
{
  type: 'product',
  product: {
    productId,
    title,
    coverImage,
    price,
    status,
    ownerPublicUserId
  }
}
```

所有类型共用：

- 会话参与者校验；
- 商品删除后的会话只读规则；
- `m_SHA256(conversationId:senderOpenid:clientMessageId)` 确定性消息 ID；
- 事务写消息、更新摘要和增加对方未读；
- 同一发送者、会话、`clientMessageId` 采用“首次成功写入胜出”；后续即使更换内容或另一个受支持类型，也返回原消息，不重新校验可变载荷、不重复写入、不增加未读、不更新摘要；
- `createdAt DESC, _id DESC` 历史游标；
- 安全响应不返回 OPENID、文件名、本地临时路径或客户端幂等键。

会话摘要：

```text
voice    [语音]
image    [图片]
location [位置]
product  [商品]
```

未知类型在客户端解析成 `unsupported` 并显示“当前版本暂不支持此消息类型”，不会让整页渲染失败。

## 8. 云存储路径与孤儿文件

媒体上传路径：

```text
chat-media/voice/{conversationId}/{senderPublicUserId}/{YYYYMMDD}/{clientMessageId}.mp3
chat-media/image/{conversationId}/{senderPublicUserId}/{YYYYMMDD}/{clientMessageId}.{jpg|jpeg|png|webp}
```

客户端路径只使用已规范化的会话 ID、当前登录公开用户 ID、日期和 `clientMessageId`，不使用用户输入。创建消息时云函数再次用可信会话参与者身份逐段校验：

- `chat-media` 前缀；
- 消息类型目录；
- 当前会话目录；
- 服务端解析的发送者公开 ID；
- 8 位日期目录；
- 文件名必须等于本条 `clientMessageId`；
- 扩展名白名单；
- 语音时长、格式、大小；
- 图片宽高和大小。

数据库只保存 `fileId`，不保存临时路径或永久下载 URL。展示语音时按需换取临时 URL；图片由小程序云文件能力加载。

这里的安全能力是“可信参与者 + 完整 fileID 路径 + 客户端元数据范围”校验。当前云函数没有下载云对象读取文件头，也没有调用对象元数据接口，因此不能声称验证了云端对象的真实 MIME 或真实字节大小。路径类型错配、跨会话、跨用户、商品封面、头像和其他业务目录会被拒绝；对象内容与扩展名不一致仍属于已知边界。

孤儿文件策略：

- 上传本身失败：没有消息、保留本地待发记录供重试；
- 消息创建明确拒绝（如 `INVALID_MEDIA`）：尝试删除刚上传文件，待发记录清除该 fileId，重试时重新上传；
- 网络超时、数据库异常、响应异常等结果不确定：保留已上传 fileId，并用相同 `clientMessageId` 重试，避免服务端实际成功后误删其文件；
- 消息发送成功：文件随消息保留；
- 本阶段没有“删除单条消息 / 删除会话”功能，因此不新增批量媒体删除。未来实现删除时必须先核对消息引用，不能按目录盲删。

真实实现等级是“客户端在明确失败后的尽力补偿删除”。删除失败仅在开发版记录不含 fileID、路径或原始错误文本的安全日志，且返回 `false`，不会掩盖原始发送错误。当前没有服务端定时扫描、后台自动回收或人工清理任务；准确表述应为：

> 已实现发送失败时的尽力补偿删除；长期孤儿文件扫描仍为后续运维项。

## 9. 权限和隐私

`app.json` 已加入：

```json
{
  "permission": {
    "scope.record": {
      "desc": "用于在聊天中录制并发送语音消息"
    },
    "scope.userLocation": {
      "desc": "用于在聊天中选择并发送位置消息"
    }
  },
  "requiredPrivateInfos": [
    "chooseLocation"
  ]
}
```

权限只在用户主动使用对应功能时触发。拒绝麦克风、相册、摄像头或位置后会说明用途并提供打开设置入口；主动取消不当作系统错误。

上线前由项目管理员登录微信公众平台，在“小程序 → 设置 → 服务内容声明/用户隐私保护指引”（后台名称可能随平台版本调整）核对并更新以下项目。信息类型名称必须以当前后台下拉项为准，不要把 `scope`、API 名或文档简称直接当作后台名称：

| 后台需核对的信息类型 | 触发功能 | 实际 API | 建议用途说明 |
| --- | --- | --- | --- |
| `麦克风` | 用户按住录制语音 | `wx.getRecorderManager()`、`RecorderManager.start()`；代码按需申请 `scope.record` | 在用户主动按住说话时录制并发送聊天语音 |
| `选中的照片或视频信息` | 用户从相册选聊天图片 | `wx.chooseMedia({ mediaType: ['image'], sourceType: ['album'] })` | 由用户主动选择并发送聊天图片；本功能不选择视频 |
| `摄像头` | 用户点击“拍摄” | `wx.chooseMedia({ mediaType: ['image'], sourceType: ['camera'] })` | 由用户主动拍摄并发送聊天图片 |
| `选择的地理位置` | 用户点击“位置”并在地图确认 | `wx.chooseLocation()`；`requiredPrivateInfos` 已声明 `chooseLocation` | 保存并发送用户主动确认的一次性位置快照 |
| `位置信息` | 地图选点时系统显示/使用当前位置 | `wx.chooseLocation()`、`scope.userLocation` | 仅辅助本次地图选点，不持续定位、不后台跟踪 |

其中“选择的地理位置”与 `chooseLocation` 返回结果直接对应；代码没有调用 `wx.getLocation`、位置变化监听或后台定位。若当前公众平台将 `chooseLocation` 只归类到“选择的地理位置”，不要额外宣称持续收集“位置信息”；但由于代码和 `app.json` 实际使用 `scope.userLocation`，提交前必须在后台接口检测结果中同时核对该项。

正式提审前仍应按公众平台当时的接口检测结果复核上述信息类型和用途说明，并在有差异时更新用户隐私保护指引。第十三阶段完成结论只代表项目研发、部署和真机验收闭环，不等同于微信官方审核或正式发布上线。

## 10. 数据库权限和索引

不新增集合，不修改权限：

```text
conversations ADMINONLY
messages      ADMINONLY
products      ADMINONLY
users         ADMINONLY
```

富消息复用已有消息索引：

```text
messages
idx_conversation_createdAt_id
conversationId ASC → createdAt DESC → _id DESC

idx_conversation_sender_clientMessage_unique
conversationId ASC → senderOpenid ASC → clientMessageId ASC
unique
```

商品选择复用阶段 7 已存在的商品索引：

```text
products
idx_sellerOpenid_status_createdAt_id
sellerOpenid ASC → status ASC → createdAt DESC → _id ASC
```

因此本阶段没有索引改动。2026-07-26 已通过 CloudBase 管理 API 实时反查：

- `messages` 两个业务索引与上表完全一致；
- `products.idx_sellerOpenid_status_createdAt_id` 与查询 `sellerOpenid = ? AND status IN (...) ORDER BY createdAt DESC, _id ASC` 的等值前缀和排序方向一致；
- `conversations` 的三个既有业务索引保持不变；
- 四个相关集合均为 `ADMINONLY`。

没有创建、删除或修改任何索引与权限。

## 11. 自动化覆盖

`scripts/verify-project.js` 新增覆盖：

- 本地 SVG 与权限声明；
- 录音按压生命周期和单实例播放；
- 相册 / 拍摄共用图片链路；
- 图片类型、尺寸、数量和上传路径；
- 上传进度、临时 URL、孤儿文件清理和取消选择；
- MessageService 五类消息解析与安全请求字段；
- 未知消息类型降级；
- 语音 / 图片 / 位置 / 商品服务端写入；
- 会话摘要和查询回读；
- 语音相同 `clientMessageId` 幂等；
- 同一幂等键更换内容或受支持类型时“首次写入胜出”，未读和摘要不变；
- 跨会话、跨用户、跨语音/图片目录、商品封面、头像、伪造会话和非参与者媒体引用拒绝；
- 坐标越界、字段缺失、名称/地址超长和非参与者位置发送拒绝；
- 自己 / 对方商品受控查询；
- 当前商品、不存在、隐藏、删除、第三方商品排除；
- 非参与者商品查询拒绝；
- 买卖角色反转及稳定分页；
- 商品标题、价格、封面和 owner 快照由服务端重建，不信任客户端；
- 孤儿删除失败只记安全开发日志、不暴露 fileID；
- 全局录音监听器只绑定当前可见聊天页。

现有文本、预约、商品、登录、收藏、浏览量等回归测试继续通过。

## 12. 部署与云端验证结果

目标环境来自本机被忽略的 `config/cloud.private.js`，与当前项目真实 AppID 匹配，没有猜测或改写公开配置。

部署只包含：

| 云函数 | 最终状态 | 运行时 / 超时 / 内存 | 云端修改时间 |
| --- | --- | --- | --- |
| `messageAction` | Active / Available | Nodejs18.15 / 10 秒 / 256 MB | 2026-07-26 20:12:32 |
| `messageQuery` | Active / Available | Nodejs18.15 / 10 秒 / 256 MB | 2026-07-26 19:56:37 |

两项均保持 `index.main`、0 个环境变量、0 个触发器。首次仅源码上传后的冷启动探针准确发现 `Cannot find module 'wx-server-sdk'`，没有误报成功；随后分别执行锁文件 `npm ci --omit=dev --ignore-scripts`，确认 `wx-server-sdk@4.0.2` 和 `ws@8.21.1` 可加载，并把生产依赖随代码包重新部署。最终下载包依赖可加载，6 个关键文件哈希如下：

本机 `npm audit --omit=dev` 对两项相同依赖树均报告 `1 moderate / 5 high / 0 critical`，来自 `wx-server-sdk@4.0.2` 及其传递依赖；npm 当前发布的 `wx-server-sdk` 最新版仍为 `4.0.2`，自动修复会建议破坏性降级到 `2.5.3`，因此本轮未执行 `npm audit fix --force`。

```text
messageAction/index.js          0A1E21BE197B3109CE7B6E225AE256F622206C15EE241E90A93693BF7F1E603F
messageAction/package.json      09FAEC341A277F1E0ACD6BFBB195FDAF3CC0923360F4F2AFD7829D02925D4998
messageAction/package-lock.json 4C4A56FEA1B465371C39331D8C499962AABCB87A4DD3E845F86C90DDD7952252
messageQuery/index.js           A8D75EE5CCD38E449CBE7B2A3567457FCE1EAB617535F011E0780B8E6694C6BB
messageQuery/package.json       E2B11F943D6525F397CD70C444E0C332C64DC4089CDB2E6B6446D40A105CC68E
messageQuery/package-lock.json  580B82F501378DC833E52E296451842EE5FC8FB3B44665C83886DA3C4041397E
```

云端无写入验证：

- 非登录管理探针：两项非法 action 均返回 `INVALID_ACTION`，合法 action 返回 `LOGIN_REQUIRED`；
- 开发者工具当前登录身份：非法类型 `INVALID_MESSAGE_TYPE`、非法位置 `INVALID_LOCATION`、伪造媒体 `INVALID_MEDIA`、不存在商品 `PRODUCT_NOT_ACCESSIBLE`、当前会话商品 `INVALID_PRODUCT`；
- `self / other` 商品查询均为 `OK`，旧 `text / system` 历史查询为 `OK` 且不含内部身份字段；
- 对一个真实非参与会话执行详情、消息、商品列表和位置发送，四项均为 `FORBIDDEN`；
- 使用一条已存在的本人文本消息幂等键改成非法位置载荷，返回原 `text`、`reused=true`，会话摘要和未读状态不变；
- 探针前后消息与会话数量均保持不变，没有创建、更新或删除生产消息与会话。

“新商品消息快照由服务端生成”的安全边界由本地事务攻击测试覆盖，商品消息完整交互已由最终真机验收确认。未知历史消息类型在自动化中使用构造数据验证安全降级，没有为验证而写入生产消息。

## 13. 最终真机验收结论

2026-07-26，用户完成最终真机验收并明确确认当前问题全部解决。本次结论覆盖：

- 文本 / 语音模式切换、按住录音、上滑取消、发送与单实例播放；
- 相册多图、摄像头拍摄、位置选择、位置卡片与地图查看；
- 独立完整的“选择商品”页面、“我的商品 / 对方商品”切换、发送和返回刷新；
- 服务端参与者权限、商品范围过滤、可信商品快照、幂等、未读计数和会话摘要；
- 图片、位置、商品点击事件隔离；
- 商品详情图片预览返回不整页刷新、不重置滚动位置；
- 输入栏三列布局、空输入加号、非空紧凑发送按钮、无 placeholder、语音图标和“按住说话”布局；
- iOS / iPad 与 Android 的相关核心交互和视觉回归。

自动验证、云端无写入安全探针和用户真机验收共同构成本阶段的最终证据。`messageAction`、`messageQuery` 已部署为 `Active / Available`，最终自动验证为 `67 checks passed`。

## 14. 已知非阻塞限制

- 服务端校验可信参与者、受控云文件路径、扩展名和客户端声明元数据，但不下载真实文件执行字节签名或 MIME 内容审查。
- 消息发送明确失败时仅执行即时、尽力而为的孤儿媒体补偿；补偿失败会安全记录，不影响原始业务错误。
- 尚未实现长期孤儿聊天媒体的定时扫描与回收任务。

这些限制未在本阶段中解决，不影响当前阶段完成结论；后续若实现，应作为独立安全与运维任务评估，不能通过放宽云存储权限或客户端直写数据库来规避。
