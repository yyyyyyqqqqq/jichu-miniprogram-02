# 第十八阶段正式切换、真实回滚与最终验收

验收日期：2026-08-09。公开材料中的环境、用户、学校和商品标识均已脱敏；OPENID、HMAC 密钥、完整内部 ID、私有游标和原始云日志不进入仓库。

## 1. 最终结论

第十八阶段同校市场已经完成正式全量切换、双账号真机验收、真实 legacy 回滚演练、strict 恢复及恢复后复验。最终生产配置为：

```text
SCHOOL_SCOPED_MARKET_ENABLED=true
SCHOOL_SCOPED_MARKET_STRICT_FOR_ALL=true
SCHOOL_SCOPED_MARKET_ALLOWLIST=[]
MARKET_ACCESS_REQUIRES_AUTH=true
```

所有完整登录且具有有效学校的用户均由服务端进入 `schoolScoped`；客户端提交的模式、学校、用户或灰度字段不被信任。匿名、资料不完整、无学校或学校不可用均 fail-closed，不回退全市场。

## 2. 切换前基线与就绪度

- Git 基线为 `main`，开始时 `HEAD` 与 `origin/main` 同步，`phase-17-complete` 指向该基线；没有 staged 文件或冲突。
- 用户 7/7 为 active、资料完整且绑定 active/valid 学校。
- 最终线上商品共 68 件，其中公开 29 件，29/29 均具有权威学校；排除 20 件专用夹具后业务商品 48 件，公开 29/29 strict-ready。
- 20 件阶段 18 灰度夹具全部 offline；B 终验新商品也已 offline，因此总记录增加但公开口径未增加。
- 学校 2952 所，2 所目标学校为 active/valid；学校 ID 与官方代码保持唯一。
- `products` ACL 为 `ADMINONLY`，索引 19 个，其中 8 个为同校市场复合索引；原索引未删除。

最终只读审计仅执行查询，前后计数及投影哈希一致，没有调用写 API。

## 3. 正式部署

只部署 `cloudfunctions/productQuery`，没有在最终切换或回滚演练中部署 `authUser`、`manageProduct`。函数最终状态为 `Active / Nodejs16.13 / index.main / 10 秒 / 256 MB`，本地与线上入口 SHA-256 一致：

```text
3a2b960ce1c59102f470a7161d263a2c86f7089d27bed3a5c2e0c3d3d753cb89
```

`PRODUCT_QUERY_CURSOR_HMAC_SECRET` 只验证存在且长度合格，不读取或记录值；`PRODUCT_SEED_ENABLED=false` 原样保留。生产 rollout 源码中旧 A/B 身份哈希已删除，allowlist 为空。

## 4. 账号 A 最终 strict 验收

账号 A（公开脱敏为 `u_1d3dc1***962f`，学校 `s_e5ca12***b898`）完成真实开发者工具和真机验收：

- 综合、最新、价格升序、价格降序各连续浏览两页，无重复拼接；
- 分类、关键词、无结果、清空、刷新、加载更多、详情和我的发布正常；
- strict 返回 `page=null / total=null`，市场模式和学校作用域均来自服务端；
- 伪造模式/学校/身份字段无效；正常游标可续页，查询条件错配及跨账号/跨学校游标被拒绝；
- offline 夹具不进入公开列表；控制台 error/exception 为 0/0。

最终恢复后的 18 次受控调用耗时 434–728 ms，未观察到错误或超时。

## 5. 显式退出、匿名重启与恢复登录

账号 A 显式退出后首页商品为 0，未再发出 `productQuery/list`，旧 scope 与 cursor 已清空。重启后仍保持匿名引导且不查询市场；只有用户主动重新登录后才恢复 `schoolScoped`。这证明强制登录策略不会被缓存恢复绕过，也不会把匿名状态伪装成空市场。

## 6. 账号 B 双校隔离与业务闭环

账号 B（公开脱敏为 `u_69ba1f***7116`，学校 `s_2639dd***6f30`）由用户在真机确认：

- final strict 完整浏览通过，allowlist 为空仍进入 `schoolScoped`；
- B 校搜索、分类、四排序、分页、详情和我的发布正常，A 校商品不泄露；
- B→A→B 换校完成，旧作用域与游标失效，最终恢复 B 校；
- 新发布商品只绑定发布时的 B 校，搜索可唯一命中，随后已下架；
- 真实 legacy 回滚恢复 strict 后，再次确认 B strict 通过。

云日志脱敏抽样中的正常 B 请求耗时约 37–152 ms，没有观察到 5xx、超时或索引错误。原始响应正文不进入文档。

## 7. 第三既有用户与全量语义

另选择一个不属于 A/B 的既有有效用户（脱敏为 `u_2270c7***d95a`），使用服务端模式决策和权威数据库记录验证：在 `strictForAll=true` 且空 allowlist 下同样进入 `schoolScoped`。此证据用于证明最终模式不依赖历史两枚身份哈希；不把自动服务端判断冒充第三台真机验收。

## 8. 真实 legacy 回滚演练

回滚工具默认只 dry-run，并明确只允许目标环境和 `productQuery`。正式演练将配置改为：

```text
enabled=false
strictForAll=false
allowlist=[]
accessRequiresAuth=false
```

随后只部署 `productQuery`。legacy 线上/本地 SHA-256 一致：

```text
7726a45143f08b1a8b063561af8474a29231c1700367bbb3c7269722b02b6753
```

账号 A 在真实开发者工具完成四排序各两页、分类、搜索、详情、我的发布及 A→B→A 换校；16 次调用 389–7746 ms，存在一次慢调用，但无超时、error 或 exception。演练没有修改 ACL、索引、HMAC、种子变量或其他云函数。

## 9. strict 恢复与恢复后门禁

legacy 验收后立即把源码恢复为最终四项配置，并再次只部署 `productQuery`。线上哈希恢复为 `3a2b...cb89`，A strict、匿名退出/重启、B strict 及线上就绪度均重新验证。最终验证脚本会读取受忽略的私密证据，要求 A/B、显式退出、真实回滚和恢复全部通过，避免只验证静态配置。

## 10. 自动回归与预览

最终自动验证包括：

- 数据迁移 26、Phase 22B 19、认证市场 16；
- 换校 75、选校 128、商品学校绑定 51；
- 同校市场 91、canary 29、最终就绪 25、夹具 15；
- preflight 10 组、显式退出 28、双账号 18；
- 最终切换门禁（含线上状态和私密验收证据）及综合验证全部通过。

最终微信开发者工具 preview 为 471240 Byte（460.2 KB），低于 2 MiB，未出现 80051。JavaScript 语法、JSON 解析、`git diff --check` 和隐私扫描在 Git 收口前再次执行。

## 11. 隐私与仓库边界

完整用户/学校/商品 ID、OPENID、HMAC 值、私有游标、二维码、原始云响应和私密快照只允许存在于 `.gitignore` 覆盖的 `tmp/` 或私有配置中。公开文档只保留脱敏 ID、聚合统计和不可逆代码哈希。三个完全相同的本地“副本”文档由忽略规则排除，不纳入提交。

## 12. 回滚方法

先执行默认 dry-run：

```powershell
npm run phase-18-canary:rollback -- --confirm-target cloud1***6d8e
```

只有在确认目标、源码回滚配置和部署范围后，才追加显式部署参数。回滚仅部署 `productQuery`；完成故障处置后必须恢复最终四项配置、重新部署并运行：

```powershell
npm run phase-18-final-cutover:verify
npm run verify
```

## 13. 已知限制

- legacy 代码作为紧急回滚路径继续保留，不能在本阶段删除；
- 正则关键词查询在数据增长后仍需持续观察扫描量和延迟；
- `snapshotAt` 不是数据库事务快照，客户端仍以 ID 去重抵御分页期间的数据变化；
- 换校冷却期尚未实现，正式运营策略仍建议加入服务端冷却；
- `wx-server-sdk@4.0.2` 的依赖审计遗留风险未在本阶段通过破坏性降级处理，应单独安排依赖维护；
- legacy 演练出现一次 7746 ms 慢调用，虽未超时，仍应纳入后续云函数延迟监控。

## 14. Git 收口

本轮使用提交信息 `feat: complete phase 18 school scoped marketplace`，推送 `main` 并创建 annotated tag `phase-18-complete`。本地忽略的交接文档、私密证据和重复副本不进入提交。
