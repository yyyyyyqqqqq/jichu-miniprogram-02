# 第四阶段云商品配置与验收

## 1. 选择云环境

1. 在微信开发者工具顶部点击“云开发”。
2. 在云开发控制台左上角确认当前环境为：

```text
cloud1-d9gpdpv6p2db56d8e
```

3. 如果环境不一致，先切换环境，不要在其他环境创建集合或部署函数。

正常结果：控制台环境 ID 与 `config/cloud.js` 一致。

常见失败：看不到该环境通常表示当前微信账号没有该 AppID 或云环境权限。

## 2. 创建 products 集合

1. 进入“云开发 → 数据库”。
2. 点击“+”或“添加集合”。
3. 集合名称填写：

```text
products
```

4. 确认创建。

正常结果：数据库左侧集合列表出现 `products`。

常见失败：提示集合已存在时不要重复创建，直接进入现有集合核对字段和权限。

## 3. 设置集合权限

本阶段客户端不直接读写商品，所有公开读取都通过 `productQuery` 云函数完成。

1. 进入 `products` 集合的“权限设置”或“安全规则”。
2. 选择“自定义安全规则”。
3. 将客户端读写都设为拒绝。控制台若使用 JSON 规则，可填写：

```json
{
  "read": false,
  "write": false
}
```

4. 保存并确认规则已生效。

正常结果：小程序客户端无法通过 `wx.cloud.database()` 直接增删改查；云函数仍可使用服务端 SDK 查询。

常见失败：不要选择“所有用户可读写”。如果保存规则报格式错误，使用控制台提供的“所有用户不可读写”等价预设。

## 4. 部署 productQuery

### 开发者工具界面

1. 在项目文件树中找到 `cloudfunctions/productQuery`。
2. 右键该目录。
3. 选择“上传并部署：云端安装依赖”。
4. 环境选择 `cloud1-d9gpdpv6p2db56d8e`。
5. 等待部署完成。

### CLI

```powershell
& "D:\program\微信web开发者工具\cli.bat" cloud functions deploy `
  --env "cloud1-d9gpdpv6p2db56d8e" `
  --paths "D:\codex\jichu mini program02\cloudfunctions\productQuery" `
  --remote-npm-install `
  --project "D:\codex\jichu mini program02"
```

正常结果：云函数列表出现 `productQuery`，状态为 `Active`。

常见失败：

- `Creating`：部署仍在进行，稍后重新查询状态。
- `function not found`：尚未部署到当前环境，或函数名称不一致。
- 依赖安装失败：确认选择了“云端安装依赖”，并检查 `package.json`。

## 5. 初始化测试商品

初始化动作是显式、受保护且幂等的：固定 `_id` 使用 `set` 覆盖同名测试记录，不会重复插入。正式运行不会自动执行。

1. 在云函数 `productQuery` 的配置中新增环境变量：

```text
PRODUCT_SEED_ENABLED=true
```

2. 保存配置并等待函数更新完成。
3. 打开云函数“云端测试”或“测试”页。
4. 输入事件：

```json
{
  "action": "seed",
  "data": {
    "confirm": "SEED_PRODUCTS_V1"
  }
}
```

5. 执行测试。
6. 看到成功结果后，立即将环境变量改为：

```text
PRODUCT_SEED_ENABLED=false
```

或删除该环境变量。

正常返回：

```json
{
  "success": true,
  "code": "OK",
  "message": "",
  "data": {
    "count": 16,
    "mode": "idempotent-upsert"
  }
}
```

正常数据库结果：

- 16 条固定 ID 的测试商品。
- 15 条公开商品。
- 1 条 `offline` 商品不会出现在首页或详情公开查询。
- `createdAt`、`updatedAt` 为数据库日期类型。

常见失败：

- `SEED_DISABLED`：环境变量未设为字符串 `true`，或配置尚未生效。
- `DATABASE_ERROR`：`products` 集合未创建、云函数环境不正确，或数据库服务异常。
- 再次执行仍为 16 条：这是幂等覆盖的预期结果，不会创建重复记录。

## 6. 建议索引

云数据库在组合筛选和排序时可能要求复合索引。优先按实际控制台报错提供的链接创建索引。

建议准备以下字段组合：

1. 综合排序：

```text
status ASC
favoriteCount DESC
viewCount DESC
createdAt DESC
_id ASC
```

2. 最新排序：

```text
status ASC
createdAt DESC
_id ASC
```

3. 价格升序：

```text
status ASC
price ASC
createdAt DESC
_id ASC
```

4. 价格降序：

```text
status ASC
price DESC
createdAt DESC
_id ASC
```

分类查询若提示缺少索引，在上述索引的 `status` 后加入：

```text
categoryId ASC
```

正常结果：四种排序、分类与分页请求不再返回缺少索引错误。

## 7. 云函数接口测试

在 `productQuery` 的云端测试页分别执行：

### 第一页

```json
{
  "action": "list",
  "data": {
    "keyword": "",
    "categoryId": "all",
    "sortBy": "default",
    "page": 1,
    "pageSize": 6
  }
}
```

预期：`success=true`、`list` 为 6 条、`total=15`、`hasMore=true`。

### 第二页

将 `page` 改为 `2`。预期返回下一批商品，ID 不与第一页重复。

### 搜索有结果

```json
{
  "action": "list",
  "data": {
    "keyword": "机械 键盘",
    "categoryId": "all",
    "sortBy": "default",
    "page": 1,
    "pageSize": 10
  }
}
```

预期包含 `product-001`。

### 搜索无结果

将 `keyword` 改为一个不存在的词。预期 `success=true`、`list=[]`、`total=0`。

### 分类与排序

分别测试：

```text
categoryId: digital
sortBy: default / newest / priceAsc / priceDesc
```

预期仅返回数码分类，四种排序均成功。

### 有效详情

```json
{
  "action": "detail",
  "data": {
    "productId": "product-001"
  }
}
```

预期 `success=true`，返回 `_id=product-001`。

### 不存在详情

```json
{
  "action": "detail",
  "data": {
    "productId": "missing-product"
  }
}
```

预期 `success=false`、`code=PRODUCT_NOT_FOUND`、提示“商品不存在或已下架”。

### 参数缺失

```json
{
  "action": "detail",
  "data": {}
}
```

预期 `success=false`、`code=INVALID_PARAMS`。

## 8. 小程序验收

1. 清除编译缓存并重新编译。
2. 首页确认显示 6 条真实商品。
3. 下拉刷新，列表重新从第一页加载。
4. 上拉加载，确认第二页追加且不重复。
5. 测试搜索、分类和四种排序。
6. 点击商品进入详情；刷新或从分享路径进入时仍可独立加载。
7. 临时将 `config/cloud.js` 中函数名改错只用于本地异常测试，确认首页和详情出现错误态且可重试；测试后立即恢复。
8. 验证未登录浏览首页和详情正常。
9. 验证未登录点击发布进入登录页。
10. 验证登录、重启恢复、退出和登录后回跳仍正常。

不要把临时错误配置提交到 Git。
