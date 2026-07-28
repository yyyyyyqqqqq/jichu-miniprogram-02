# 学校基础数据

本目录保存教育部学校名单的可复现规范化产物，不保存原始 Excel 附件。

## 来源

- 发布机构：中华人民共和国教育部
- 页面标题：全国高等学校名单
- 页面发布日期：2026-06-18
- 数据统计时点：截至 2026-06-17
- 官方页面：<https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/202606/t20260618_1441074.html>
- 本阶段附件：附件 1“全国普通高等学校名单”
- 附件地址：<https://www.moe.gov.cn/jyb_xxgk/s5743/s5744/202606/W020260618416094865984.xls>
- 原文件 SHA-256：`863404a90d6faed6ea2ea4c45df0c9e44e42378933893a9be7594d084a32d437`
- 解析器版本：`school-parser-v1`

教育部页面公布全国高等学校共 3196 所，其中普通高等学校 2952 所、成人高等学校 244 所；本目录只解析附件 1，因此产物为 2952 所普通高等学校。原始附件的独立许可条款未在页面中明确列出，对外再分发前应另行核对使用条件。

## 复现

将官方附件放到项目根目录并保持文件名为 `list of universities.xls`。该原始文件被精确忽略，不进入 Git。

```powershell
npm ci
npm run schools:build
npm run schools:verify
```

构建过程会在读前、读后核对原文件校验和，且不会修改源文件。规范化 JSON 的 SHA-256 为 `cf69adbecbeda6d7de3150a8fc19616bd09c2d9cdc2d0fac5e90d55ae2a2fcd3`。

## 产物

- `generated/schools.normalized.json`：导入和差异计算使用的规范化记录。
- `generated/schools.normalized.csv`：便于人工抽查的 UTF-8 CSV。
- `generated/manifest.json`：源文件、解析器、记录数和产物哈希。
- `../../reports/schools/`：源结构、异常、校验、dry-run 和导入报告。

规范化产物继续把所有记录声明为导入默认值 `platformStatus: pending`，年度重建不会覆盖云端运营状态。2026-07-28 经人工明确并通过受控状态工具激活上海工程技术大学、上海财经大学浙江学院；当前云端为 active 2、pending 2950。

状态工具默认 dry-run、最多两所学校，正式操作需要确认与目标、状态和原因绑定的操作 ID：

```powershell
npm run schools:set-status -- `
  --school-id <schoolId> `
  --status active `
  --reason "明确原因" `
  --dry-run
```

学校原始“备注”字段从解析、规范化、CSV 到云端统一命名为 `remark`，不存在同义的业务 `note` 字段。激活审计、线上验证和回滚计划见 `../../reports/schools/phase-15-*.json`。
