# 第十五阶段：官方高校数据解析、标准化与学校基础服务

## 阶段结论

第十五阶段的源码、数据产物、云端集合、正式数据导入、真实测试学校激活和只读查询线上闭环已经完成。教育部附件 1 中 2952 所普通高等学校已写入 `schools`；上海工程技术大学、上海财经大学浙江学院为 `active`，其余 2950 所保持 `pending`。

本阶段没有实现用户或商品 `schoolId`、学校选择页、学校市场隔离或管理员云函数。阶段 16 的前置数据和只读服务条件已经满足，但必须在用户验收并下达新指令后才能进入。

## 官方来源与文件画像

- 官方页面：<https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/202606/t20260618_1441074.html>
- 附件：附件 1“全国普通高等学校名单”
- 发布日期：2026-06-18
- 统计时点：截至 2026-06-17
- 原文件：旧版 OLE/BIFF `.xls`
- 文件大小：464896 字节
- SHA-256：`863404a90d6faed6ea2ea4c45df0c9e44e42378933893a9be7594d084a32d437`
- 工作表：`全国普通高等学校名单`
- 使用区域：`A1:G2986`
- 合并区域：33
- 公式：0
- 批注：0
- 解析器可见图片：0；旧版 BIFF 嵌入对象不作为本结论的绝对排除范围

教育部页面同时公布普通高等学校 2952 所和成人高等学校 244 所。本阶段原文件只包含附件 1，因此解析范围是 2952 所普通高等学校，不包含附件 2 的成人高校。

## 解析、字段映射与范围

解析器按省级分组行识别 `province`，按学校数据行读取以下列：

| 原始列 | 标准字段 | 处理 |
| --- | --- | --- |
| 学校名称 | `name` / `nameNormalized` | NFKC、空白和标点规范化 |
| 学校标识码 | `officialCode` | 规范化为 10 位字符串 |
| 主管部门 | `authority` | 文本规范化 |
| 所在地 | `city` | 文本规范化 |
| 办学层次 | `educationLevel` | 保留本科或专科 |
| 备注 | `remark` | 保留源文本 |
| 省级分组标题 | `province` | 从结构行继承 |

最终记录数为 2952，其中本科 1412、专科 1540，覆盖 31 个省级分组。每个分组声明数量与实际数据行完全一致。

## 标准化数据模型

每条学校记录包含：

```text
_id
name
nameNormalized
officialCode
province
city
educationLevel
authority
remark
officialStatus
dataSource
sourceYear
sourceVersion
sourceRow
platformStatus
createdAt
updatedAt
lastSeenAt
```

`_id` 使用 `s_ + SHA-256("MOE:" + officialCode)` 前 32 个十六进制字符，确保重跑稳定。`officialStatus` 当前为 `valid`；`platformStatus` 首次导入固定为 `pending`；公开响应中的 `selectable` 只有在 `active + officialStatus: valid` 时才为真。

`createdAt`、`updatedAt` 和 `lastSeenAt` 由数据库服务端时间生成，不进入规范化源文件哈希。

## 校验结果

- 缺失学校名称：0
- 缺失或非法学校标识码：0
- 缺失省份、城市、主管部门或办学层次：0
- 重复 `officialCode`：0
- 重复 `nameNormalized`：0
- 结构声明数量不一致：0
- P0：0
- P1：0
- 非空备注：856

规范化 JSON SHA-256 为 `cf69adbecbeda6d7de3150a8fc19616bd09c2d9cdc2d0fac5e90d55ae2a2fcd3`。连续两次构建哈希一致，构建前后原始 `.xls` 哈希一致。

## 生成文件与复现

```text
data/schools/generated/manifest.json
data/schools/generated/schools.normalized.json
data/schools/generated/schools.normalized.csv
reports/schools/source-profile.json
reports/schools/source-anomalies.json
reports/schools/source-summary.md
reports/schools/validation-report.json
reports/schools/validation-report.md
reports/schools/dry-run-report.json
reports/schools/dry-run-report.md
reports/schools/cloud-dry-run-report.json
reports/schools/import-report.json
```

复现命令：

```powershell
npm ci
npm run schools:build
npm run schools:dry-run
npm run schools:verify
```

原始附件必须由官方地址重新取得并放在项目根目录，文件名为 `list of universities.xls`。该路径被精确写入 `.gitignore`。

## dry-run 与导入

导入批次：

```text
school-import-2026-863404a90d6f-cf69adbecbed
```

首次云端 dry-run：

- 新增：2952
- 更新：0
- 完全一致：0
- 冲突：0
- 非法：0

正式导入时，102 条同一已校验批次记录先在小批次探针中写入，最终批次工具继续写入 2850 条；总计 2952 条，失败 0。导入后再次 dry-run：

- 新增：0
- 更新：0
- 完全一致：2952
- 冲突：0
- 非法：0

导入工具默认只执行 dry-run。真实写入必须显式使用 `--apply --confirm <batchId>`，并受最大写入数、单批上限、失败重试和冲突中止保护。官方字段更新不会覆盖 `platformStatus`、激活信息和运行时审计字段。

## 真实测试学校激活

2026-07-28 使用 `scripts/schools/set-platform-status.js` 激活以下学校：

| 学校 | 脱敏 schoolId | officialCode | 省份/城市 | 层次 |
| --- | --- | --- | --- | --- |
| 上海工程技术大学 | `s_e5ca12...b898` | `4131010856` | 上海市/上海市 | 本科 |
| 上海财经大学浙江学院 | `s_2639dd...6f30` | `4133014207` | 浙江省/金华市 | 本科 |

两条记录激活前均为 `officialStatus: valid`、`platformStatus: pending`，确定性 ID、唯一 officialCode 和官方字段与规范化数据一致。

激活操作：

```text
operationId: school-status-d0bb73feb64b8ba9b7b31d0a
toolVersion: school-platform-status-v1
reason: phase-15 test school activation
updated: 2
skipped: 0
conflicts: 0
failed: 0
```

运维工具默认 dry-run，最多接受两所明确学校；正式执行必须提供与学校、状态、原因绑定的确定性操作 ID。写入使用 `_id + officialCode + officialStatus + 原 platformStatus` 条件更新，只修改运营状态与审计字段。非法确认 ID 已验证会在写入前拒绝，同一操作重复执行会幂等跳过两条。

学校业务备注字段已经在解析脚本、JSON、CSV、云记录和文档中统一为 `remark`；云端旧 `note` 字段数量为 0。源画像中的范围说明字段另命名为 `scopeNote`，不再与学校备注混淆。重新构建后规范化 JSON 哈希未变化。

## 云端集合、权限与索引

目标环境在文档和报告中只以脱敏形式 `cloud1***6d8e` 记录。

`schools` 创建前确认不存在同名或相近用途集合。创建后：

- 集合权限：`ADMINONLY`
- 客户端直接读取：禁止
- 客户端直接写入：禁止
- 写入入口：仅受控导入和本地状态运维工具；没有公开管理员云函数
- 当前记录数：2952
- `pending`：2950
- `active`：2
- `inactive`：0
- `merged`：0
- 缺失三项服务端时间：0
- 云端重复 `officialCode`：0
- 云端重复 `_id`：0
- 两所 active 学校均具有服务端 `platformStatusUpdatedAt` 和 `activatedAt`

索引：

| 名称 | 字段 | 唯一 |
| --- | --- | --- |
| `_id_` | `_id` | 是 |
| `_openid_1` | `_openid` | 否 |
| `idx_officialCode_unique` | `officialCode` | 是 |
| `idx_platformStatus_nameNormalized_id` | `platformStatus, nameNormalized, _id` | 否 |
| `idx_platformStatus_province_nameNormalized_id` | `platformStatus, province, nameNormalized, _id` | 否 |

## schoolQuery

`schoolQuery` 已部署到正式云环境，运行时 Node.js 18.15，入口 `index.main`，只提供：

- `list`：只列出 `active + officialStatus: valid` 学校，支持省份筛选和稳定游标分页。
- `search`：支持规范化校名安全前缀搜索，或 10 位学校标识码精确搜索。
- `detail`：按内部 `_id` 返回公开详情；`pending`、`inactive` 或无效记录统一不可见。

最大页大小为 20。游标绑定查询动作、关键词和省份，并以 `nameNormalized + _id` 保证稳定顺序。正则搜索会先转义用户输入，避免正则注入和任意包含式全表扫描。

公开响应只包含：

```text
id, name, province, city, educationLevel, platformStatus, selectable
```

不会返回主管部门、源文件位置、批次、校验问题、内部时间或数据库字段。当前错误码包括 `INVALID_ACTION`、`INVALID_ARGUMENT`、`INVALID_KEYWORD`、`INVALID_PROVINCE`、`INVALID_PAGE_SIZE`、`SCHOOL_NOT_FOUND`、`SCHOOL_NOT_ACTIVE`、`QUERY_FAILED` 和 `SERVICE_UNAVAILABLE`。

激活收尾重新部署后的远程探针结果：

- 本地与云端 `index.js` SHA-256：`2c3fbc357c88ee8c1dc5f4fc0be0d45d31558d9350687747c8581acfa30ea7d7`，一致
- `list`：只返回上述两所 active 学校，顺序稳定，字段白名单正确
- 上海市、浙江省分别只返回对应学校；北京市返回空列表
- 两校名称前缀、完整名称和 officialCode 共 6 项搜索通过
- pending 学校搜索为空；特殊字符安全；超长关键词为 `INVALID_KEYWORD`
- 两校 detail 均成功且 `selectable: true`
- pending、缺失和非法详情分别为 `SCHOOL_NOT_ACTIVE`、`SCHOOL_NOT_FOUND`、`INVALID_ARGUMENT`
- `pageSize: 1` 两页无重复和遗漏，末页不再返回虚假游标
- 非法游标和跨省份作用域游标均为 `INVALID_ARGUMENT`

## 客户端服务层

`services/school-service.js` 封装 `list`、`search` 和 `detail`，负责参数规范化、超时和稳定错误映射。使用真实线上返回进行可控集成验证后，list 得到两所学校、两项 search 和两项 detail 均通过，pending 与超时分别映射为 `SCHOOL_NOT_ACTIVE` 和 `CLOUD_TIMEOUT`。客户端不直接访问 `schools`，本阶段也没有页面、AuthStore 或用户资料写入学校字段。

`data/schools/fixtures/active-schools.fixture.json` 只用于本地查询测试，使用虚拟学校与虚拟标识码，不进入云端。

## 测试与运维

学校专项验证覆盖：

1. 原始文件只读、结构、数量和画像；
2. 标准化、确定性主键、重复和异常校验；
3. dry-run 幂等、导入门禁和运营字段保护；
4. `schoolQuery` 的 active 隔离、搜索、分页、详情、错误码和公开字段；
5. 客户端服务层规范化和无直接数据库访问。

云函数依赖锁定为 `wx-server-sdk@4.0.2` 与 `ws@8.21.1`。依赖审计存在 1 个 moderate、5 个 high 的既有传递依赖告警；没有使用 `npm audit fix --force`，因为建议修复会降级 SDK 并破坏现有云函数兼容基线。该风险不阻塞阶段 15，阶段 23 继续跟踪上游 SDK。

## 回滚计划

只执行了回滚 dry-run，没有实际回滚：

```text
operationId: school-status-c24ea8ad4c9acf11525a3a87
from: active
to: pending
targets: 2
conflicts: 0
apply: false
```

回滚仍要求显式 `--apply --confirm school-status-c24ea8ad4c9acf11525a3a87`，并只会影响上述两所学校。本阶段保持两校 active。

## 第十六阶段进入条件

以下进入条件已经满足：

1. 产品负责人已明确两所真实测试学校；
2. 两所学校已通过受控运维操作改为 `active` 并留下激活审计；
3. 其他 2950 所学校仍为 `pending`；
4. `schoolQuery` 的线上 list、search、detail 和分页只公开两所 active 学校；
5. 字段统一、云端统计、客户端服务和回滚 dry-run 均已验证。

用户验收并发出第十六阶段新指令后才可以继续用户/商品 `schoolId`、选择页和学校市场隔离设计。用户验收前不创建 `phase-15-complete` 标签；当前也不宣称已经具备多学校业务闭环。
