# FINAL RELEASE STEP 2B — Production Product Cleanup

执行日期：2026-08-25（Asia/Shanghai）
最终状态：`STEP 2B PRODUCTION CLEANUP PASS`

## A. Authorization

项目负责人通过 `145.md` 明确授权：仅在 production 对批准 manifest 中 hash 为 `0f2fced4111aa70f3254ba951a8a348d132cbbc9d8e6154b2d89b3e00627fb38` 的 32 个 product 执行 `available → offline`。

授权精确范围：

- 上海财经大学浙江学院 `s_2639dd0d2bb01fb6a317e43e771a6f30`：2 条。
- 上海工程技术大学 `s_e5ca127017371b84bec8b1a67137b898`：30 条。
- product document mutation：32 次。
- product remove：0 次。
- 其他 collection mutation：0 次。

未修改其余 40 个 product、16 个 no-school legacy、user、school、favorites、conversations、messages、appointments、productViews、ACL、index、cloud function、dependency 或 runtime；没有学校激活、部署、微信发布、commit、push 或 tag。

## B. Fresh preflight

写入前于 `2026-08-25T13:48:05.789Z` 重新执行 production Step 2A zero-write audit，结果：

```text
environment = production
write = false
products total = 72
available total = 32
reserved total = 0
offline = 25
sold = 12
deleted = 3
target count = 32
invalid seller target count = 13
issues = []
safeToApply = true
```

production/staging target distinct，active target 为 production；target IDs SHA-256 与授权值完全一致。没有自动调整目标范围。

## C. Fresh manifest

批准 manifest 保存在 ignored/private：`tmp/final-release-product-cleanup-manifest.json`。写前副本保存在 `tmp/final-release-step-2b-before-snapshot.json`。

- target IDs SHA-256：`0f2fced4111aa70f3254ba951a8a348d132cbbc9d8e6154b2d89b3e00627fb38`
- before snapshot SHA-256：`e0f4319a2a2c9c4acb370a90abe9ce05168afe1ecc7d9882ad71d762a9435630`
- exact school scope：2 + 30。
- 目标关系总量：favorites 6、active conversations 3、merged conversations 0、direct product messages 19、product context/card messages 81、appointments 8、productViews 19。
- 13 个 invalid-seller target 全部仍分类为 exact `seed/mock`。

manifest 与 operation state 均位于 `.gitignore` 覆盖的 `tmp/`，未把 product ID、OPENID 或原始 production record 写入报告/可提交文件。

## D. Before snapshot

写前 snapshot 包含 72 个 product 的 status grouping、32 个目标的 ID hash/version/school/seller integrity/逐项关系计数，以及全库 Phase 25 integrity gate，保存在：

- `tmp/final-release-step-2b-before-snapshot.json`
- `tmp/final-release-step-2b-before-integrity-audit.json`

写前完整性结果：

| 范围 | 结果 |
|---|---|
| conversations | 26 total；6 active canonical；20 merged alias |
| canonical integrity | malformed 0；duplicate 0；dangling alias 0 |
| messages | 201 total；orphan 0；participant/type/lifecycle failure 0 |
| appointments | 23 total；conversation/product/participant failure 0 |
| Phase 25 readiness gate | PASS，blockers `[]` |

## E. Runner safety controls

新增一次性 runner `scripts/final-release-step-2b-product-cleanup.js`、验证器 `scripts/verify-final-release-step-2b-product-cleanup.js` 和只读 post-audit `scripts/final-release-step-2b-post-audit.js`。

runner 默认 `write=false`。进入写路径必须同时提供：

- exact `--env production`
- `--write`
- exact authorization phrase
- 固定 private manifest path
- `--expected-count 32`
- exact approved target hash
- masked production target confirmation
- explicit `--batch 1|2`

它拒绝任意 manifest/state path、任意 product IDs、wildcard school、multi/upsert 和非 products mutation。每条 command 仅允许：

```text
$set: status, version
$currentDate: offlineAt, updatedAt
multi: false
upsert: false
```

query 同时锁定 exact `_id + schoolId + status=available + version/field-absence`。每次 mutation 前读、写后读并比较 protected-field SHA-256。operation state 在写前先记录 pending，支持中断后的精确检查和安全 resume；两批之间有强制顺序门。批量 update、remove/delete/drop 和其他 collection command 均不存在。

## F. Batch 1 result

Batch 1 dry-run：20 条，已完成 0，预计 mutation 20，写前计数 `available 32 / offline 25 / sold 12 / deleted 3`。

第一条 update 后 CloudBase CLI 返回结构没有可解析的 affected-count，runner 按 fail-closed 立即停止，没有继续下一条。pending readback 确认该唯一目标已精确变为 offline、version +1、server timestamps 存在、protected hash 未变化；operation state 安全恢复为 1/32。

随后 resume 完成剩余 19 条。Batch 1 最终：

```text
completed = 20/20
available = 12
offline = 45
sold = 12
deleted = 3
product removes = 0
other collection mutations = 0
```

runner 对无法从 CLI response 解码 count 的情况仍强制 after-readback；因为 update query 为 unique `_id`、`multi=false`、`upsert=false`，最大 cardinality 为 1，after state 不匹配即停止。

## G. Batch 2 result

Batch 2 只有在 Batch 1 的 20 条全部存在于 verified state 后才可进入。

Batch 2 dry-run：12 条，已完成 0，预计 mutation 12，写前计数 `available 12 / offline 45 / sold 12 / deleted 3`。

执行结果：12/12 逐条成功并回读；累计 state 为 32 results、pending false。operation 时段：`2026-08-25T13:51:27.839Z` 至 `2026-08-25T14:01:52.697Z`。

结果类型：31 条 `updated-and-verified`，1 条 `recovered-after-readback`；两者都具有相同的 before/after protected hash 与精确 next version 证明。

## H. Final product counts

最终 production fresh read-only inventory：

```text
products total = 72
available = 0
reserved = 0
offline = 57
sold = 12
deleted = 3
legacy no-school available = 0
```

32 个批准目标仍存在于 products collection，均为 offline；13 个 legacy seed 的缺失 version 已从 normalized 0 更新为 1，其余目标均精确 +1。

## I. Public market zero proof

production post-audit 同时检查全局和两所 exact school 的公开状态集合 `available + reserved`：

| 查询/计数语义 | 结果 |
|---|---:|
| global public-visible products | 0 |
| 上海财经大学浙江学院 available / reserved / visible | 0 / 0 / 0 |
| 上海工程技术大学 available / reserved / visible | 0 / 0 / 0 |
| 首页 list | 0 |
| 分类 list | 0 |
| 搜索 list | 0 |
| seller public products | 0 |
| seller public active count / “件在售” | 0 |

上述入口使用部署基线中的同一 authoritative status/school filter；production DB 已不存在任何 `available/reserved` product，因此 offline/sold/deleted 无法进入公开结果。没有改客户端 mock 来制造结果。

结论：**PUBLIC MARKET ZERO = true**。

## J. Invalid seller blocker closure

```text
PUBLIC AVAILABLE PRODUCTS WITH INVALID SELLER = 0
```

13 条 exact seed/mock product 仍存在，最终均为 offline，不进入首页、分类、搜索、公开详情交易入口或 seller 公开在售列表。关系数据和 snapshot fallback 未删除；`PRODUCT_SELLER_UNAVAILABLE` 不再是公开市场商品的交易 blocker。

## K. Relationship integrity

写后 production Phase 25 integrity gate 与 target-specific relation manifest 全部通过：

| Gate | 写后结果 |
|---|---:|
| conversation orphan/read failure | 0 |
| dangling alias | 0 |
| active canonical malformed/duplicate | 0 |
| message orphan/product-context failure | 0 |
| appointment orphan/product missing | 0 |
| favorite orphan | 0 |
| productView orphan | 0 |

26 个 conversations、201 个 messages、23 个 appointments 与写前总数一致；6 active canonical + 20 merged aliases 的结构未变化。32 个目标的 favorites/conversation/message/appointment/productView 逐项计数与 before manifest 完全相同。live product 仍存在，conversation snapshot fallback 和 historical product rendering source 均有效。

私有 post-audit：`tmp/final-release-step-2b-post-audit.json`，最终 `passed=true`。

## L. Automated regression

cleanup 后全部通过：

| Gate | 结果 |
|---|---|
| Phase 25 lifecycle | PASS，67 assertions |
| hide/send race | PASS，899 assertions，含 120 repeated interleavings |
| attempt diagnostics | PASS，69 assertions |
| rollback compatibility | PASS，35 assertions |
| project verify | PASS，81 checks |
| Phase 24 pair | PASS，52 assertions/scenarios |
| Phase 24 | PASS，88 checks |
| school verification | PASS，5 groups |
| school selection | PASS，128 checks |
| Phase 23 hardening | PASS，133 checks |
| Phase 22 integrity | PASS，42 checks |
| Phase 22A | PASS，6 groups |
| Phase 18 preflight | PASS，10 groups |
| Step 2A cleanup dry-run verifier | PASS，28 checks |
| Step 2B runner verifier | PASS，40 checks |
| production Phase 25 integrity gate | PASS，blockers `[]` |
| production Step 2B post-audit | PASS |
| `git diff --check` | PASS |

回归使用 mock/in-memory test stores，不为通过测试而修改 production 数据。

## M. Production mutations summary

| 项目 | 实际值 | 授权值 | 结论 |
|---|---:|---:|---|
| product document mutations | 32 | 32 | 精确一致 |
| 上海财经大学浙江学院 | 2 | 2 | 精确一致 |
| 上海工程技术大学 | 30 | 30 | 精确一致 |
| product remove | 0 | 0 | 一致 |
| other 40 product mutations | 0 | 0 | 一致 |
| other collection mutations | 0 | 0 | 一致 |
| final verified targets | 32 | 32 | 全部 offline |

每个 mutation 只改变 `status/offlineAt/updatedAt/version`。没有 broad update、hard delete、关系删除或范围扩大。

## N. Remaining release blockers

Step 2B product cleanup 本身没有剩余 blocker，最终状态为：

`STEP 2B PRODUCTION CLEANUP PASS`

但正式全国发布仍保留 Step 2A 已记录的两个独立事项：

1. dependency 分类仍为 `NO SAFE UPGRADE — RISK ACCEPTANCE CANDIDATE`；owner 需明确接受 residual risk，或等待 CloudBase vendor stable patched chain。
2. Node16/18 EOL 仍为 `NON-BLOCKING HARDENING`；建议后续单独 staging-first 迁移至 CloudBase 推荐的 Nodejs20.19，不与本次数据清理混合。

下一步建议：owner 先确认本报告和 production 只读证据；在确认前不 commit/push/tag。确认后单独决定 dependency risk acceptance 与 Node20 staging 计划，再进入后续正式发布 gate。
