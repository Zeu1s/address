# API

[English](API.md) · 简体中文 · [繁體中文](API.zh-TW.md)

Address 在 `/api/v1` 下提供 JSON API。服务运行后，也可以在网页 `/zh-CN/api/` 中查看交互式参数说明，或下载 `/api/v1/openapi.json`。

## 鉴权

除 `/health`、`/ready` 和 `/openapi.json` 外，所有请求都需要在后台“接口令牌”中创建的 Bearer 令牌：

```http
Authorization: Bearer YOUR_API_TOKEN
```

令牌可以限定权限（读取 / 生成）、每分钟请求数和到期时间。鉴权失败返回 `401`；超过限速返回 `429`，并带 `Retry-After: 60`。

## 快速示例

```bash
curl -fsS "https://address.example.com/api/v1/generate?country=CN&city=南京" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

```python
import json
from urllib.request import Request, urlopen

request = Request(
    "https://address.example.com/api/v1/generate?country=US",
    headers={"Authorization": "Bearer YOUR_API_TOKEN"},
)
with urlopen(request) as response:
    print(json.load(response)["data"]["result"]["address"]["formattedAddress"])
```

```javascript
const response = await fetch("https://address.example.com/api/v1/generate?country=JP", {
  headers: { Authorization: "Bearer YOUR_API_TOKEN" },
});
const { data } = await response.json();
console.log(data.result.address.formattedAddress);
```

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 进程存活检查 |
| `GET` | `/ready` | 数据库就绪检查 |
| `GET` | `/openapi.json` | OpenAPI 3.1 描述 |
| `GET` | `/countries` | 支持的国家及当前地址数量 |
| `GET` | `/availability` | 当前可生成的国家 |
| `GET` | `/client-context` | 把请求 IP 或指定 IP 解析为国家和地区 |
| `GET` | `/locations/search` | 搜索州省、城市、区县和邮编 |
| `GET` | `/locations/hierarchy` | 按上下级浏览行政区 |
| `GET` | `/generate` | 生成一条地址及配套测试资料 |
| `POST` | `/generate/batch` | 批量生成最多 50 条地址 |
| `GET` | `/addresses/{id}` | 按 ID 查询已发布的地址 |
| `GET` | `/coverage` | 查询某国三项同步完成规则 |
| `POST` | `/address-translation` | 把地址翻译成指定显示语言 |
| `GET` | `/data-health` | 地址池覆盖与就绪状态，适合监控 |

## 生成地址

`GET /generate`

| 参数 | 默认值 | 说明 |
|---|---|---|
| `country` | `US` | 国家代码，如 `US`、`CN`、`JP` |
| `region` / `city` / `district` / `postcode` | — | 按名称筛选，每项最多 300 字符 |
| `regionId` / `cityId` / `districtId` / `postcodeId` | — | 按 `/locations/*` 返回的 ID 筛选，优先使用 |
| `residential` | 中国 `true`，其他 `false` | `true` 时只返回有住宅证据的地址；中国始终为住宅地址 |
| `mode` | — | 设为 `ip-region` 时按 IP 所在地区生成 |
| `ip` | 请求方 IP | 与 `mode=ip-region` 配合使用 |
| `seed` | 随机 | 相同种子会选中相同的记录和测试资料，便于复现 |
| `strategy` | `random` | `random` 或 `instant` |
| `requestId` | 随机 UUID | 调用方自定义的关联 ID |

筛选是严格的：所选范围内没有合格地址时返回 `NO_POOL_COVERAGE`，不会改用附近或上级地区。

**响应**（已省略部分字段）：

```json
{
  "data": {
    "requestId": "359f92e7-6e9e-4166-9889-af6d6c54fcf0",
    "country": "US",
    "filters": { "city": "Seattle" },
    "filterMatchLevel": "exact",
    "result": {
      "address": {
        "id": "pool-v2-addr-0172af2a1d3cb634cf1e6fce35b298e511ced17f",
        "formattedAddress": "4019 Aikins Avenue Southwest, Seattle, WA, 98116",
        "matchLevel": "premise",
        "propertyType": "residential",
        "coordinates": { "latitude": 47.567944, "longitude": -122.40706 }
      },
      "profile": { "…": "合成的测试资料" }
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `address.matchLevel` | 地址精度：`street`（街道）、`premise`（门牌）、`subpremise`（门牌以下单元） |
| `address.propertyType` | 只有存在独立住宅证据时为 `residential`，街道级地址为 `unknown` |
| `address.addressVariants` | 原文、英文、简体中文等多语言版本，事实一致 |
| `address.evidence` | 数据来源与验证证据 |
| `eligibleCount` | 当前筛选范围内的合格地址数量，部分请求路径会返回 |
| `profile` / `card` 等 | 人物、银行卡、工作、网络等**合成**测试资料，与真实地址无关 |

地址字段全部来自数据源，缺失的门牌、楼栋或邮编保持为空。中国地址的楼栋、单元、楼层、室号是唯一的合成字段，并标记为 `synthetic`。

## 批量生成

`POST /generate/batch`

```json
{
  "count": 20,
  "filters": { "country": "DE", "city": "Berlin" },
  "options": { "unique": true, "seed": "batch-2026", "strategy": "random" },
  "excludeAddressIds": []
}
```

- `count`：1–50；
- `options.unique`：为 `true` 时不重复返回同一地址；
- `excludeAddressIds`：最多 500 个需要排除的地址 ID。

合格地址不足时返回已有结果，并标记 `exhausted: true`。

## 地区搜索

`GET /locations/search`

| 参数 | 默认值 | 说明 |
|---|---|---|
| `country` | `US` | 国家代码 |
| `field` | `city` | `region`、`city`、`district` 或 `postcode` |
| `q` | — | 搜索文本 |
| `regionId` / `cityId` | — | 上级地区 ID |
| `residential` | `false` | `true` 时只统计有住宅证据的数量 |
| `limit` | `100` | 每页数量，20–200 |
| `cursor` | — | 上一页返回的 `nextCursor` |

```bash
curl -fsS "https://address.example.com/api/v1/locations/search?country=CN&field=city&q=南京" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

返回的 `id` 请原样传给 `/generate` 的 `*Id` 参数。邮编选项可能没有目录 ID，此时把 `value` 作为 `postcode` 传入即可。中国区县选项同时返回所属城市（`parentValue`、`parentId`）和省份（`regionValue`、`regionId`），因为区县名会在不同城市重复；只传 `districtId` 即可精确选中该区县。

选项列表来自每个国家的快照，快照在后台重建，因此数量可能比刚发布的地址晚几分钟。

`GET /locations/hierarchy` 使用 `country`、`parentType`、`parentId`、`childType` 逐级浏览行政区。

## 地址翻译

`POST /address-translation`

```json
{ "addressId": "pool-v2-addr-0172af2a1d3cb634cf1e6fce35b298e511ced17f", "targetLocale": "ja" }
```

`targetLocale` 可选 `en`、`zh-CN`、`zh-TW`、`ja`、`ko`、`de`、`fr`、`es`、`pt`。门牌号、单元号、邮编等数字标识始终保持原样。没有可用译文时返回 `fallback` 或 `unavailable`，客户端可以直接显示原文地址。

## 其他端点

- `GET /countries`：`addressCount` 为可生成的地址总数，`residentialCount` 为其中有住宅证据的部分。
- `GET /availability`：`available` 表示有可生成地址，`residentialAvailable` 表示有住宅地址。
- `GET /client-context?ip=8.8.8.8`：返回 IP 对应的国家、州省、城市、邮编和坐标。服务位于反向代理之后时，需在部署配置中设置 `TRUST_PROXY=true` 才能获取真实客户端 IP。
- `GET /coverage?country=FR`：分别返回总量、行政区覆盖率、各级最低数量三项规则的完成情况。
- `GET /addresses/{id}`：重新查询某条仍在发布的地址。

## 错误

```json
{ "error": { "code": "INVALID_COUNTRY", "message": "Unknown country code: ZZ" } }
```

| 代码 | 含义 |
|---|---|
| `INVALID_COUNTRY` | 不支持的国家代码 |
| `INVALID_FIELD` / `INVALID_LOCATION` | 地区参数无效 |
| `INVALID_RESIDENTIAL` | `residential` 取值无效 |
| `INVALID_BATCH_REQUEST` | 批量请求的 `count`、`filters` 或字段名无效 |
| `NO_POOL_COVERAGE` | 所选范围内没有合格地址 |
| `IP_LOCATION_UNAVAILABLE` | 无法根据 IP 确定地区 |

请根据 `error.code` 处理错误，不要依赖 `message` 文本。
