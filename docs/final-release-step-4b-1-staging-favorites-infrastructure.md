# Final Release Step 4B-1 — Staging Favorites Infrastructure Enablement

## 1. 原阻塞原因与本轮结论

Step 4B 在 production deployment 前正确停止：staging 缺少 `favorites` collection，真实 `listMyFavorites` 因 `DATABASE_ERROR` 无法完成 runtime gate。P4A-01 源码、依赖包和函数配置没有 regression。

本轮只补齐 staging 收藏子系统，并完成真实 runtime、mutation/security、性能和 cleanup。production 未部署、未写入、未改 collection/index/ACL/config。

最终结论：**PASS — STEP 4B-1 COMPLETE**。Step 4B production controlled rollout 仍未恢复，等待 owner 下一轮明确指令。

## 2. Environment Identity Gate

- production 与 staging 注册环境 ID 不同；所有输出只保留 masked identity。
- 资源创建、fixture、runtime mutation 脚本只接受 `--env staging`，对 `--env production` fail closed。
- 所有 staging 写操作要求 masked target confirmation；runtime 还要求 active client target 精确等于 registered staging。
- active client target 最终保留为 staging，便于后续恢复 Step 4B 的 staging preflight；这只是 ignored private local target，不改变 production。

## 3. Production Favorites Query Shape（只读审计）

`favoriteProduct/listMyFavorites` 的真实关系查询为：

- condition：`userOpenid == trusted wx context OPENID`
- count：同一 condition 的 relation 总数
- order：`createdAt DESC, _id DESC`
- pagination：`skip((page - 1) * pageSize)` + `limit(pageSize)`
- defaults/limits：page 默认 1、最大 100；pageSize 默认 6、最大 20
- hydration：按 relation 顺序读取 `products.doc(productId)`；并行 `Promise.all` 不改变输入顺序
- filtering：保留 available / reserved / offline / sold；missing / deleted 被过滤
- `total` / `hasMore`：基于 relation，而不是过滤后的 product 数量
- access：客户端不能直接读写 collection；云函数以 `cloud.getWXContext()` 为 authoritative identity

production 实际索引与 ACL：

| Name | Unique | Fields |
|---|---:|---|
| `_id_` | yes | `_id ASC` |
| `_openid_1` | no | `_openid ASC` |
| `idx_userOpenid_createdAt_id` | no | `userOpenid ASC, createdAt DESC, _id DESC` |
| `idx_userOpenid_productId_unique` | yes | `userOpenid ASC, productId ASC` |

ACL：`ADMINONLY`。本轮没有复制 production favorites 文档、OPENID 或任何私密业务数据。

## 4. Staging Collection / Index / ACL

在 explicit staging gate 后创建 `favorites`，fresh inspection 结果：

- collection exists：yes
- ACL：`ADMINONLY`
- client-wide read/write：未开放
- `idx_userOpenid_createdAt_id`：exact field/order/unique match，DescribeTable returned
- `idx_userOpenid_productId_unique`：exact field/order/unique match，DescribeTable returned
- 真实分页查询随后成功，进一步证明索引可用
- 未创建任何 speculative index

测试结束后 collection、两条必要索引和 ACL 均保留；fixture count 为 0。

## 5. Fixture Manifest

private ignored manifest：`tmp/final-release-step-4b1-favorites-fixture-manifest.json`。

- manifest 在首条云端写入前落盘
- 记录 fixtureRunId、staging identity fingerprint、purpose、createdAt、两个 collection 的精确 document IDs
- 只使用现有合法 staging test actor；其 OPENID 不写入报告或 Git
- synthetic seller、product、favorite relation 全部只存在于 staging
- 10 个 products + 8 个 initial favorites = 18 条 fixture
- 覆盖 6 个可展示商品、1 个 deleted product、1 个 missing relation、mutation target、own-product、cross-school product
- 未复制 production 用户、favorite、product 或私密字段

首次 prepare 在 Windows CLI command-length gate 前停止，云端写入为 0；按同一 manifest fresh cleanup 验证 0 leftover 后，将写入改为小批次。正式 fixture run 完整创建并读回 18 条。

## 6. Staging RC Deployment

只部署 `favoriteProduct`：

- Release Candidate commit：`02edd6e279fe338dc6ec3f67e4b6d7219f2e0873`
- approved/remote source SHA-256：`0214cf9d702af7d097aae03169cce9103a9dc54e30e4ec93caebddefe9cd6e60`
- status：Active / Available
- runtime：Nodejs18.15
- handler：`index.main`
- timeout / memory：10s / 256MB
- InstallDependency：TRUE
- package/lock：match
- installed dependency：wx-server-sdk 4.0.2、ws 8.21.3，可加载
- environment variables：空变量基线

fresh final dry-run/detail 再次确认远端 hash 与配置完全一致。

## 7. Functional Runtime Matrix

真实 staging DevTools identity + `wx.cloud.callFunction` 共 23 项通过：

| Area | Result |
|---|---|
| page 1 / page 2 / pageSize / total / hasMore | PASS |
| stable repeat order | PASS |
| available / reserved / offline / sold | PASS |
| missing product filtering | PASS |
| deleted product filtering | PASS |
| invalid page → 1 | PASS |
| invalid pageSize → 6 | PASS |
| oversized pageSize → 20 | PASS |
| response envelope | PASS |
| exact safe DTO field shape | PASS |
| private `sellerOpenid` absent | PASS |
| parallel hydration preserves relation order | PASS |

带 missing/deleted 的 page 1 从 5 条 relation 得到 3 条 DTO；page 2 从 3 条 relation 得到 3 条 DTO。最终顺序与 surviving relations 顺序精确一致。

cleanup 后再次执行真实空列表 smoke：total 0、第一页 0、第二页 0、3 个正式样本 0 errors。

## 8. Mutation / Security Regression

| Probe | Result |
|---|---|
| getFavoriteStatus before add | PASS |
| add favorite | PASS |
| duplicate add idempotency | PASS |
| add relation + product count transaction readback | PASS |
| remove favorite | PASS |
| duplicate remove idempotency | PASS |
| remove relation + product count transaction readback | PASS |
| own-product add rejection | PASS (`CANNOT_FAVORITE_OWN_PRODUCT`) |
| cross-school add rejection | PASS (`CROSS_SCHOOL_RELATION_FORBIDDEN`) |
| malformed product ID rejection | PASS (`INVALID_PARAMS`) |
| forged client OPENID/userId ignored | PASS；结果仍绑定 trusted wx context identity |
| client direct `favorites` database read | PASS；被 `ADMINONLY` 拒绝 |

operator-side SCF invoke 会由平台注入调用 identity，因此没有把它误记为“无 WX context”。真实安全边界由 trusted-context identity、forged identity rejection/ignore、ownership/school isolation 和 client direct DB rejection共同验证。

## 9. Staging Performance

真实云环境，1 warm-up（排除）+ 10 sequential samples，pageSize 10：

- errors：0
- p50：507ms
- p95：552ms
- max：552ms
- payload p50 / p95 / max：4844 bytes
- raw relation total：8
- returned safe DTO：6
- console errors / exceptions：0 / 0
- stable order/envelope：yes

这只是 staging health gate，不用于预测 production latency；未执行 load test、retry、cache、prefetch 或额外 concurrency pool。最大 hydration 并行量继续受 `MAX_PAGE_SIZE = 20` 限制。

## 10. Fixture Cleanup

- created fixture count：18
- deleted fixture count：18
- runtime mutation relation：add 后 remove，最终 0
- fresh exact-ID audit：products 0 leftover，favorites 0 leftover
- fresh empty-list smoke：PASS
- 未 broad delete、未 truncate、未按模糊条件删除

保留的 staging 能力：`favorites`、必要索引、`ADMINONLY`、Active/Available RC `favoriteProduct`。

## 11. Production Unchanged Proof

结束前对 production 做 fresh read-only audit，并与 Step 4B PRE normalized digest 逐 collection 比较：

| Collection | Count | Digest vs PRE |
|---|---:|---|
| users | 8 | equal |
| products | 72 | equal |
| favorites | 7 | equal |
| conversations | 26 | equal |
| messages | 209 | equal |
| appointments | 25 | equal |
| schools | 2952 | equal |
| productViews | 28 | equal |

- production `favoriteProduct` source SHA-256 仍为旧版 `89bfc3412a859e7f7adf1d2e6ff4cb00b9b582af5b66c532c629cb65a7b489f1`
- production deployment / collection / index / ACL / fixture / benchmark：0
- products：offline 57 / sold 12 / deleted 3；public visible 0；PUBLIC MARKET ZERO true
- schools：2952 active / 0 pending / official drift 0 / identity conflict 0

## 12. Git / Tooling

- business source `cloudfunctions/favoriteProduct/index.js` 无新 diff；RC commit 不变
- 新增长期可复用、staging hard-gated 的 setup / actor capture / fixture / runtime / production read-only audit scripts
- 修正已有 performance verifier 对 DTO 主键的断言：真实字段为 `_id`，不是 `id`
- local `main` 仍相对 `origin/main` ahead 1 / behind 0
- 未 push、未 tag、未创建 production release seal
- private actor、manifest、runtime/performance/integrity JSON 均位于 ignored `tmp/`，不进入 Git

## 13. Continuation Decision

**PASS — STEP 4B-1 COMPLETE**

现在停止。不要自动部署 production。下一轮只有在 owner 明确恢复 Final Release Step 4B 后，才允许进入 production controlled rollout。
