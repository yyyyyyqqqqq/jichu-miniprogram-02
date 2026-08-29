# Final Release Step 3B — Production Nationwide School Activation

日期：2026-08-28
范围：production cursor secret、`schoolQuery` rollout、学校索引、2950 所学校受控激活及只读发布后验证
最终结论：**STEP 3B PRODUCTION NATIONWIDE SCHOOL ACTIVATION PASS**

## A. Authorization

- 严格按 `150.md` 执行，仅涉及 production 学校 cursor secret、已在 staging 验证的 `schoolQuery`、必要学校索引、2950 次 `pending → active` 和只读验证。
- 未创建/删除学校，未修改学校 ID、officialCode 或任何 official field。
- 未修改 users、products、favorites、conversations、messages、appointments、productViews、ACL、其他云函数、依赖或运行时。
- 未执行 feedback、微信上传/审核/发布、Git commit/push/tag。

## B. Fresh production baseline

- 目标：`[ENV] PRODUCTION`，环境 `cloud1***6d8e`，AppID `wx5e54***418c`；`activeTargetMatches=true`，`targetsDistinct=true`。
- 写入前学校：total 2952、active 2、pending 2950。
- 商品：total 72、offline 57、sold 12、deleted 3、available 0、reserved 0、public visible 0；`PUBLIC MARKET ZERO=true`。
- 12 个 production 云函数写入前状态、源码和配置已保存至 private snapshot。
- Git：`main`、HEAD 与 `origin/main` 均为 `b4242a7ae17c094753605d06b6444daf172ce28d`；Step 3A 工作区变更保留。
- `phase-25-complete` 未移动，仍指向 commit `4967995d1ca20f0fef8050b91864721dddafbab5`。

## C. Source/checksum validation

- XLS SHA-256：`a0ceb41a15f335c0adfb2d0239137b879b1c58d1b57a322d3e1794866de7d09c`。
- normalized JSON SHA-256：`cf69adbecbeda6d7de3150a8fc19616bd09c2d9cdc2d0fac5e90d55ae2a2fcd3`。
- fresh rebuild 与磁盘 normalized JSON 完全一致：records 2952、missing 0、extra 0、different 0。
- duplicate ID/officialCode/normalized name 均为 0；required missing 0、P0 0、P1 0。
- production 2952 个 ID 和 official fields 完全一致；identity conflict 0、unexpected officialStatus 0。

## D. Production indexes

- 保留并验证 `idx_officialCode_unique`。
- 逐个创建、等待 Ready 并执行真实 query smoke：
  - `idx_school_active_name_id`：platformStatus、officialStatus、nameNormalized、_id。
  - `idx_school_active_province_name_id`：platformStatus、officialStatus、province、nameNormalized、_id。
- 未修改 ACL。

## E. Production cursor secret

- 已安全生成并配置独立的 `SCHOOL_QUERY_CURSOR_HMAC_SECRET`，没有输出或提交 secret 值。
- production fingerprint：`14fa877a9b086077`；与 staging 不同。
- 远端仅存在预期 key；环境 fingerprint 回读一致。
- 单独配置 secret 时旧 production 代码 hash 不变；新版在 secret 缺失时 fail closed，无 unsigned cursor fallback。

## F. schoolQuery deployment

- 仅部署 `schoolQuery`。
- approved local/staging/production remote source SHA-256：`95f227f782395293b7ba9b53a0307e74c4f90020090d43c5520867a771878899`。
- Active/Available；runtime `Nodejs18.15`、handler `index.main`、timeout 10、memory 256。
- package SHA-256 `7837d7262090557f2fd75ada71a0ac7b6874d6782e8edbd078ff2ae87e1da01d`，lock SHA-256 `e49c438a16a6b83cf60ed5d2565b7a9698cd887c993b98cbae5428fe3f1d6409`；production/staging 均 MATCH。

## G. Pre-activation smoke

- 在 active 2 / pending 2950 时完成真实 production smoke。
- list 只返回 2 个 active+valid；pending detail 被拒绝，pending search 返回 0。
- officialCode 精确查询和前缀搜索正常。
- cursor 篡改、cross-province/scope cursor、非法 pageSize/province、超长 keyword 均被拒绝；合法 cursor 重复请求确定。
- 13 次调用、错误 0，PASS。

## H. Activation manifest

- private snapshot：`tmp/final-release-step-3b-before-activation.json`。
- private manifest：`tmp/final-release-step-3b-activation-manifest.json`。
- `targetCount=2950`、`targetStatus=pending`、`targetOfficialStatus=valid`、`safeToApply=true`、`issues=[]`。
- target ID SHA-256：`c2274128e64a19ac88e7faf67cb225c40c71cdf321abe2a8ebd7362eb4ce60c8`。
- manifest 锁定 exact IDs、official hashes、normalized checksum 和仅 `platformStatus/updatedAt` mutation。

## I. Batch execution

- runner 默认 `write=false`；真实写路径同时验证 production、`--write`、授权短语、masked target、private manifest、2950、target ID hash 和 normalized checksum。
- 每条 filter 锁定 `_id + officialCode + officialStatus=valid + platformStatus=pending`；`multi=false`、`upsert=false`。
- 每批写前/写后 readback，并校验 official hash 不变。
- 最初 20 条请求因云端单请求载荷限制被拒绝两次；两次回读均为 succeeded 0 / pending 20，因此 mutation 0。执行器 STOP 并保留错误证据。
- 按“每批最多 20”将批次降为 10，门禁复验后从同一 manifest 幂等恢复；295 个批次全部成功。
- private state：`tmp/final-release-step-3b-operation-state.json`；completed 2950、remaining 0、finished true。

## J. Checkpoints

| Completed | Active | Pending | Error records | Unexpected | Official drift | Query | Market zero |
|---:|---:|---:|---:|---:|---:|:---:|:---:|
| 20 | 22 | 2930 | 2 | 0 | 0 | PASS | true |
| 100 | 102 | 2850 | 2 | 0 | 0 | PASS | true |
| 500 | 502 | 2450 | 2 | 0 | 0 | PASS | true |
| 1000 | 1002 | 1950 | 2 | 0 | 0 | PASS | true |
| 2000 | 2002 | 950 | 2 | 0 | 0 | PASS | true |
| 2950 | 2952 | 0 | 2 | 0 | 0 | PASS | true |

两条 error 仅为前述 20 条载荷被拒绝且 `0 succeeded` 的审计记录；切换 10 条批次后无新增错误或未对账 mutation。

## K. Final school counts

```text
schools total = 2952
active = 2952
pending = 0
official field drift = 0
identity conflicts = 0
school ID set unchanged = true
```

实际 school mutation 精确为 2950 次 `pending → active`；insert/remove 和 official field mutation 均为 0。

## L. Nationwide pagination proof

- 完整遍历 2952 条、148 页；首屏 20。
- unique 2952、duplicate 0、cursor duplicate 0。
- 最后一页 `hasMore=false`；合法 cursor 重复请求确定；篡改和跨 scope 复用被拒绝。

## M. Search/province proof

- 搜索：北京 61/4 页、上海 64/4 页、浙江 57/3 页、清华大学 1、officialCode `4111010003` 1、不存在关键词 0。
- “财经 / 工程”为 0，符合 prefix 语义。
- 省份：北京市 92/5 页、上海市 69/4 页、浙江省 111/6 页、广东省 167/9 页、四川省 146/8 页。
- production-target DevTools 只读验证：首屏 20、加载更多、非首 20、100 条窗口、搜索、省份、stale response 防护全部 PASS；console error 0、exception 0。
- DevTools：首屏 4880ms（含 reLaunch/鉴权/初始化）、第二页 550ms、扩展到 100 条窗口 2241ms、搜索 546ms、省份 1107ms、快速切换 575ms；未观察到明显卡死。
- `MANUAL SCHOOL SELECTION NOT EXECUTED DUE TO TEST ACCOUNT LIMITATION`；未修改主账号学校或触发 cooldown。

## N. Existing-user integrity

- users 仍为 8；完整 snapshot、protected school fields 和学校引用计数与 activation 前一致。
- schoolId、schoolChangedAt、schoolCooldownAt/profile 当前学校均未变化。
- 2950 个 target school 当前用户引用数为 0。

## O. PUBLIC MARKET ZERO

- products 仍为 72：offline 57、sold 12、deleted 3；available 0、reserved 0、public visible 0。
- `PUBLIC MARKET ZERO=true`；没有 seed 商品，products mutation/remove 0。
- DevTools probes/audit 前后全部业务集合 count 与投影 hash 完全一致。

## P. Performance sample

- production 全国采样 204 次调用，errors 0。
- remote：min 1ms、p50 53ms、p95 66ms、max 105ms。
- payload p95 4214 bytes、max 4498 bytes；function memory max 35,962,880 bytes。
- 与 staging 参考 p50≈55ms、p95≈68ms、max≈129ms、max payload≈4.5KB 相当，无明显退化；未做 destructive load test。

## Q. Automated regression

最终输出 `REGRESSION_PASS`：

- Phase 18：91/79/16/26/28/48 checks；Phase 19 49、20 78、21 64、22 42、22A 6 groups、22B 19、23 133。
- Phase 24：88、auth flow 71、login transaction 35、pair 52。
- Phase 25：lifecycle 67、hide/send race 899、attempt diagnostics 69、rollback compatibility 35。
- school data 5 groups、school selection 128、Step 3A、selector pagination 5 groups、Step 3B 26、project 81 全部 PASS。
- production zero-write security probes 18/18 PASS；console error/exception 0，前后集合完全一致。
- production school integrity、public-market-zero、最终 Step 3B audit 和 `git diff --check` PASS。

## R. Rollback readiness

- 2950 target IDs、before status snapshot、ID hash 和 normalized checksum 已保留。
- target user references 0，业务关系未变化，具备在 owner 重新授权后条件 `active → pending` 的技术前置条件。
- 未自动 rollback。未来若出现业务引用，禁止盲目全量回滚，应先关闭新增选择、保留历史读取、分析引用并重新授权。

## S. Production mutations summary

| Scope | Mutations |
|---|---:|
| schools pending → active | 2950 |
| school insert/remove/official fields | 0 |
| users/products/favorites | 0 |
| conversations/messages/appointments/productViews | 0 |
| other cloud functions / ACL | 0 |

此外仅发生已授权的 production secret 配置、两条 school index 创建及 `schoolQuery` 单函数部署。

## T. Remaining release blockers

- Step 3B 自动化、production 数据、索引、后端、客户端只读验证阻塞项：无。
- `MANUAL SCHOOL SELECTION NOT EXECUTED DUE TO TEST ACCOUNT LIMITATION`。建议 owner 使用专用 production 测试账号完成非首 20 学校选择、profile、冷启动、首页市场和 cooldown 的最小手工验收。
- 微信正式体验版上传、审核和发布未执行，需另行授权。
- 未 commit/push/tag；等待 owner 审核报告后决定 Git 与发布动作。

**STEP 3B PRODUCTION NATIONWIDE SCHOOL ACTIVATION PASS**
