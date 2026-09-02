# Final Release — Feedback Feature

> 日期：2026-08-30（Asia/Shanghai）
> 当前结论：**PASS — FEEDBACK PRODUCTION COMPLETE**
> 后续门禁：**WAITING FOR OWNER FINAL RELEASE STEP 5 AUTHORIZATION**

## 1. 本轮范围

本轮完成“我的 → 意见反馈”独立页面、可信云端入库、服务端限流和 QQ SMTP 通知能力；staging 已通过真实邮件与负责人收件验收。根据 `164.md` 的明确授权，Feedback-only production 基础设施、云函数和唯一一次真实 smoke 均已完成，smoke 已精确清理。没有执行微信上传、审核或正式发布。

## 2. 产品与客户端

- `app.json` 注册 `pages/feedback/index`，个人页新增“意见反馈”入口。
- 页面沿用现有绿色/白色卡片风格，包含多行输入、`0 / 1000` 计数、提交 loading、成功消息和错误消息。
- 客户端与服务端均 trim；空白内容拒绝，最大 1000 字符。
- 页面使用 `AuthGuard.requireIdentity`，不把学校状态误当成反馈登录条件。
- 客户端只发送 `action / content / requestId`；不发送 OPENID、收件人或 SMTP 参数。

## 3. 云端边界

- 新云函数：`feedbackAction`，唯一 action 为 `submit`。
- 身份只取 `cloud.getWXContext().OPENID`；客户端伪造的 `OPENID/openid/userOpenid` 不参与业务。
- `feedbacks` 字段为 `_id / userOpenid / content / status / mailStatus / createdAt / updatedAt`，失败时可增加归一化 `mailLastErrorCode`；不保存用户名、授权码、密码或收件人配置。
- 60 秒最多 1 条，滚动 24 小时最多 10 条；24 小时时间窗查询、幂等二次检查和写入在同一服务端事务中完成，避免并发检查—写入窗口。
- 收件人固定在云端为 `2915487801@qq.com`，客户端不能修改。
- production 主题为“即出 - 新用户反馈”；staging 主题为“[STAGING] 即出 - 测试反馈”。邮件为 `text/plain`，只含环境标记、Feedback ID、时间和反馈正文，不含 OPENID 或其他身份信息。
- QQ SMTP 固定 `smtp.qq.com:465` 且 `secure=true`；运行时只读 `process.env`。
- 缺少邮件配置时，反馈仍入库：`mailStatus=failed / mailLastErrorCode=MAIL_CONFIG_MISSING`，客户端收到 `success=true / accepted=true / notificationDelivered=false`。
- SMTP 失败只保存归一化错误码，日志不输出正文、OPENID、SMTP 配置或堆栈。

## 4. 依赖审计

- Nodemailer 使用精确版本 `9.0.6`，许可证 `MIT-0`，包自身无额外直接依赖；SMTP 参数采用其 465/TLS 标准配置。
- 全函数 lockfile 的 `npm audit` 仍报告 6 项既有传递风险（5 high、1 moderate），均来自项目统一锁定的 `wx-server-sdk 4.0.2` 传递链，不来自 Nodemailer。npm 给出的自动修复方向是降级到 `wx-server-sdk 2.5.3`，会破坏全项目 SDK 4.0.2 基线，因此本功能未单独降级或偏离现有运行时。
- production 前应在全项目 SDK 升级专项中重新评估；本轮只在 staging 部署，且反馈正文不能控制任何外部 URL，SMTP host/port 也被固定。

## 5. 本地验证

- `npm run feedback:verify`：38/38 PASS，超过需求的 20 项最低要求。
- 覆盖：空白、1000/1001 边界、非法 action/requestId、匿名、伪造身份、固定收件人、缺配置、SMTP success/failure、60 秒/24 小时限流、跨用户隔离、幂等、数据库失败、日志/存储隐私、页面注册/登录保护/计数/loading/成功/错误状态。
- `npm run verify`：81/81 PASS。
- staging DevTools 无写页面 smoke PASS：路由为 `pages/feedback/index`，初始 `contentLength=0 / maxLength=1000 / isSubmitting=false`，console error/exception 为 0/0。
- staging CLI preview PASS：主包 `541285 Byte / 528.6 KB`；只是本地预览编译，没有上传体验版、提交审核或正式发布。
- 最终 `git diff --check`、源码一致性、生产隔离和私密值扫描均再次通过。

## 6. Staging 基础设施与受控验证

- `feedbacks`：已创建并保留，当前 fixture 清理后 count=0。
- ACL：`ADMINONLY`，客户端直接读被拒。
- 唯一新增业务索引：`idx_userOpenid_createdAt`，`userOpenid ASC / createdAt DESC`，non-unique、non-sparse。
- `feedbackAction`：Active/Available，Nodejs18.15，`index.main`，20 秒，256 MB；最终远端/本地源码 SHA-256 均为 `2f34e04a346bc554e1f15f660727f10281dddb0533880c34a5e3fc04812a7688`。
- 当前远端环境变量键名为 `FEEDBACK_ENVIRONMENT / FEEDBACK_MAIL_HOST / FEEDBACK_MAIL_PORT / FEEDBACK_MAIL_USER / FEEDBACK_MAIL_SECRET`；私密值只从 Git 忽略的本地私密配置定向注入 staging，未写入源码、报告或版本控制。
- staging fixture manifest 在首个业务写前生成，fixtureRunId 为 `feedback_staging_20260830_01`，只允许一个精确 feedback ID。
- 真实 DevTools 验证 PASS：可信身份入库、客户端伪造身份/收件人无效、`status=submitted`、`mailStatus=failed`、`MAIL_CONFIG_MISSING`、`notificationDelivered=false`、客户端直读拒绝、无私密邮件字段。
- 上述缺配置测试当时 `realSmtpAttempted=false`。其 fixture 已精确删除，leftover=0；集合、ACL、索引和函数保留。

## 7. Production Rollout 边界

rollout 前 fresh PRE 确认 production `feedbacks` collection 和 `feedbackAction` function 均不存在。本轮只创建 `feedbacks`、`ADMINONLY` ACL、`idx_userOpenid_createdAt` 和 `feedbackAction`，只注入 Feedback production 邮件环境变量；没有修改任何其他 collection、ACL、index、cloud function、runtime 或业务数据。

## 8. 私密配置与下一步

稳定、被 Git 忽略的私密配置路径：

`config/cloud.secrets.private.js`（相对于本地项目根目录）

该文件 `staging` 与 `production` 节点的 SMTP 字段均已由负责人填写。受控工具只检查存在性并定向注入对应环境；没有向终端输出、复制、散列、记录或提交私密值。

```js
FEEDBACK_MAIL_HOST: 'smtp.qq.com',
FEEDBACK_MAIL_PORT: '465',
FEEDBACK_MAIL_USER: '',
FEEDBACK_MAIL_SECRET: ''
```

- `FEEDBACK_MAIL_USER`：QQ 邮箱账号。
- `FEEDBACK_MAIL_SECRET`：**新生成的 QQ SMTP/IMAP 授权码，不是 QQ 密码**。
- 不要读取、复用或截图识别旧授权码；旧的已泄露/可疑授权码必须先在 QQ 邮箱设置中撤销，再生成新的。
- 不要把私密文件加入 Git，不要把授权码粘贴到聊天、文档、命令行或截图中。
- 收件人固定为 `2915487801@qq.com`，不需要也不能在私密文件中配置。

负责人已明确回复“已收到测试邮件，内容正常”，确认 staging 邮件成功到达、主题与测试正文正确且中文显示正常。Staging Real SMTP Verification 已 PASS。

## Staging Real SMTP Verification

- credential configured：yes；secret value：**NEVER RECORDED**。
- staging 环境变量定向注入 PASS；远端函数仍为 Active/Available、Nodejs18.15、`index.main`、20 秒、256 MB。
- 部署前后本地/远端源码 SHA-256 均为 `2f34e04a346bc554e1f15f660727f10281dddb0533880c34a5e3fc04812a7688`，源码、依赖和运行时未改变。
- 当前实现不提供独立 transport preflight；为避免额外 SMTP 连接，本轮直接执行唯一一次真实 staging 反馈提交，没有重试。
- 真实提交 PASS：`status=submitted`、`mailStatus=sent`、无 `mailLastErrorCode`、`notificationDelivered=true`，SMTP 服务接受发送；客户端伪造的身份和收件人仍无效，客户端直接读仍被拒绝。
- 期望主题：`[STAGING] 即出 - 测试反馈`；测试正文为固定合成内容，不含 OPENID、凭据或其他身份信息。
- 精确 fixture ID 只保存在 Git 忽略的私密 manifest 中，报告仅显示掩码 `fb_***23674ffc`。真实发送次数为 1；精确删除 1 条后 fresh audit leftover=0。
- production `feedbacks` 和 `feedbackAction` 仍不存在，production writes=0；未部署 production。
- 负责人已完成人工收件箱验收。最终状态：**PASS — STAGING REAL SMTP VERIFICATION COMPLETE**。

## Production Rollout

- owner staging email confirmation：PASS。
- Git gate：`main == origin/main == d07b335bc225e0dfe4fb57f11c076386deb77bcf`，ahead/behind `0/0`，staged 0；当前可见未提交内容仅属于 Feedback 客户端、云函数、验证/部署工具和文档，没有无关业务 diff。
- source freeze：本地与 staging 远端 `feedbackAction` SHA-256 均为 `2f34e04a346bc554e1f15f660727f10281dddb0533880c34a5e3fc04812a7688`。
- private config：仍 ignored / untracked；受版本控制和候选文件中的 authorization code occurrence=0。
- production environment identity：registered production，active target fresh match，且与 staging distinct。
- PRE snapshot：users 8、products 72、favorites 7、conversations 26、messages 209、appointments 25、schools 2952、productViews 28；`feedbacks=false / feedbackAction=false`。PUBLIC MARKET ZERO，schools 2952 active / 0 pending / 0 official drift / 0 identity conflict。
- production infrastructure：`feedbacks` exists、count 0、ACL `ADMINONLY`；唯一业务索引 `idx_userOpenid_createdAt` 为 `userOpenid ASC / createdAt DESC`、non-unique、non-sparse。
- production function：`feedbackAction` Active/Available、Nodejs18.15、`index.main`、20 秒、256 MB；remote source SHA-256 精确为 `2f34e04a346bc554e1f15f660727f10281dddb0533880c34a5e3fc04812a7688`。
- production SMTP configured：**yes**；只记录五个环境变量键存在，credential value **NEVER RECORDED**。
- immediate zero-write gate PASS：invalid action、blank、oversized 均拒绝；client direct DB read/write 均拒绝；合法 submit 0，feedback count 0。
- real production Feedback smoke：仅执行 1 次，无自动重试。`success/accepted=true`、`status=submitted`、`mailStatus=sent`、无 `mailLastErrorCode`、`notificationDelivered=true`；邮件期望主题为 `即出 - 新用户反馈`，不得带 staging marker。
- smoke fixture：正式报告只记录 masked ID `fb_***e026b7c2`；exact ID 仅在 ignored manifest。精确删除 1 条后 fresh audit leftover=0，realMailAttempts=1。
- security regression：Feedback production-safe probes PASS；既有 Phase 23 production zero-write probes 18/18 PASS，前后计数与投影摘要一致，console/exception 0/0。
- POST integrity：八个既有 collection 的 count/normalized digest 与 PRE 精确相等；PUBLIC MARKET ZERO 和学校不变量保持。`feedbacks` 保留且 count 0，函数/ACL/index/credential 配置均健康。
- local regression：feedback 38/38、project 81/81 PASS。
- owner production inbox confirmation：PASS。负责人确认 production 邮件实际到达，subject 正确、production synthetic smoke content 正确、中文正常，且未发现 OPENID、secret 或 credential；未提交邮箱截图。
- Client：production-ready；`feedbackAction`：production Active/Available；`feedbacks`：production exists / current count 1；该记录由 owner 在 rollout 后自行测试产生并明确确认，非 Codex smoke，按生产数据保留。ACL `ADMINONLY`；index Ready；SMTP configured；production real mail PASS；Codex smoke leftover 0；secret scan PASS。
- Git final seal：本次变更以 `feat: add secure user feedback flow` 提交并 push `main`；仓库没有 Feedback / Final Release tag convention，因此 **NO TAG CREATED**。
- 最终状态：**PASS — FEEDBACK PRODUCTION COMPLETE**。Final Release Step 5、Final Release Closure、微信审核与正式发布均未执行。
