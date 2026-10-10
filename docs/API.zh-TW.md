# API

[English](API.md) · [简体中文](API.zh-CN.md) · 繁體中文

Address 在 `/api/v1` 下提供 JSON API。服務執行後，也可以在網頁 `/zh-CN/api/` 中檢視互動式參數說明，或下載 `/api/v1/openapi.json`。

## 鑑權

除 `/health`、`/ready` 和 `/openapi.json` 外，所有請求都需要在後臺「介面令牌」中建立的 Bearer 令牌：

```http
Authorization: Bearer YOUR_API_TOKEN
```

令牌可以限定許可權（讀取 / 生成）、每分鐘請求數和到期時間。鑑權失敗返回 `401`；超過限速返回 `429`，並帶 `Retry-After: 60`。

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

## 端點

| 方法 | 路徑 | 說明 |
|---|---|---|
| `GET` | `/health` | 程序存活檢查 |
| `GET` | `/ready` | 資料庫就緒檢查 |
| `GET` | `/openapi.json` | OpenAPI 3.1 描述 |
| `GET` | `/countries` | 支援的國家及當前地址數量 |
| `GET` | `/availability` | 當前可生成的國家 |
| `GET` | `/client-context` | 把請求 IP 或指定 IP 解析為國家和地區 |
| `GET` | `/locations/search` | 搜尋州省、城市、區縣和郵遞區號 |
| `GET` | `/locations/hierarchy` | 按上下級瀏覽行政區 |
| `GET` | `/generate` | 生成一條地址及配套測試資料 |
| `POST` | `/generate/batch` | 批次生成最多 50 條地址 |
| `GET` | `/addresses/{id}` | 按 ID 查詢已釋出的地址 |
| `GET` | `/coverage` | 查詢某國三項同步完成規則 |
| `POST` | `/address-translation` | 把地址翻譯成指定顯示語言 |
| `GET` | `/data-health` | 地址池覆蓋與就緒狀態，適合監控 |

## 生成地址

`GET /generate`

| 參數 | 預設值 | 說明 |
|---|---|---|
| `country` | `US` | 國家程式碼，如 `US`、`CN`、`JP` |
| `region` / `city` / `district` / `postcode` | — | 按名稱篩選，每項最多 300 字元 |
| `regionId` / `cityId` / `districtId` / `postcodeId` | — | 按 `/locations/*` 返回的 ID 篩選，優先使用 |
| `residential` | 中國 `true`，其他 `false` | `true` 時只返回有住宅證據的地址；中國始終為住宅地址 |
| `mode` | — | 設為 `ip-region` 時按 IP 所在地區生成 |
| `ip` | 請求方 IP | 與 `mode=ip-region` 配合使用 |
| `seed` | 隨機 | 相同種子會選中相同的記錄和測試資料，便於復現 |
| `strategy` | `random` | `random` 或 `instant` |
| `requestId` | 隨機 UUID | 呼叫方自定義的關聯 ID |

篩選是嚴格的：所選範圍內沒有合格地址時返回 `NO_POOL_COVERAGE`，不會改用附近或上級地區。

**響應**（已省略部分欄位）：

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
      "profile": { "…": "合成的測試資料" }
    }
  }
}
```

| 欄位 | 說明 |
|---|---|
| `address.matchLevel` | 地址精度：`street`（街道）、`premise`（門牌）、`subpremise`（門牌以下單元） |
| `address.propertyType` | 只有存在獨立住宅證據時為 `residential`，街道級地址為 `unknown` |
| `address.addressVariants` | 原文、英文、簡體中文等多語言版本，事實一致 |
| `address.evidence` | 資料來源與驗證證據 |
| `eligibleCount` | 當前篩選範圍內的合格地址數量，部分請求路徑會返回 |
| `profile` / `card` 等 | 人物、銀行卡、工作、網路等**合成**測試資料，與真實地址無關 |

地址欄位全部來自資料來源，缺失的門牌、樓棟或郵遞區號保持為空。中國地址的樓棟、單元、樓層、室號是唯一的合成欄位，並標記為 `synthetic`。

## 批次生成

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
- `options.unique`：為 `true` 時不重複返回同一地址；
- `excludeAddressIds`：最多 500 個需要排除的地址 ID。

合格地址不足時返回已有結果，並標記 `exhausted: true`。

## 地區搜尋

`GET /locations/search`

| 參數 | 預設值 | 說明 |
|---|---|---|
| `country` | `US` | 國家程式碼 |
| `field` | `city` | `region`、`city`、`district` 或 `postcode` |
| `q` | — | 搜尋文本 |
| `regionId` / `cityId` | — | 上級地區 ID |
| `residential` | `false` | `true` 時只統計有住宅證據的數量 |
| `limit` | `100` | 每頁數量，20–200 |
| `cursor` | — | 上一頁返回的 `nextCursor` |

```bash
curl -fsS "https://address.example.com/api/v1/locations/search?country=CN&field=city&q=南京" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

返回的 `id` 請原樣傳給 `/generate` 的 `*Id` 參數。郵遞區號選項可能沒有目錄 ID，此時把 `value` 作為 `postcode` 傳入即可。中國區縣選項同時返回所屬城市（`parentValue`、`parentId`）和省份（`regionValue`、`regionId`），因為區縣名會在不同城市重複；只傳 `districtId` 即可精確選中該區縣。

選項列表來自每個國家的快照，快照在背景重建，因此數量可能比剛發布的地址晚幾分鐘。

`GET /locations/hierarchy` 使用 `country`、`parentType`、`parentId`、`childType` 逐級瀏覽行政區。

## 地址翻譯

`POST /address-translation`

```json
{ "addressId": "pool-v2-addr-0172af2a1d3cb634cf1e6fce35b298e511ced17f", "targetLocale": "ja" }
```

`targetLocale` 可選 `en`、`zh-CN`、`zh-TW`、`ja`、`ko`、`de`、`fr`、`es`、`pt`。門牌號、單元號、郵遞區號等數字標識始終保持原樣。沒有可用譯文時返回 `fallback` 或 `unavailable`，客戶端可以直接顯示原文地址。

## 其他端點

- `GET /countries`：`addressCount` 為可生成的地址總數，`residentialCount` 為其中有住宅證據的部分。
- `GET /availability`：`available` 表示有可生成地址，`residentialAvailable` 表示有住宅地址。
- `GET /client-context?ip=8.8.8.8`：返回 IP 對應的國家、州省、城市、郵遞區號和座標。服務位於反向代理之後時，需在部署配置中設定 `TRUST_PROXY=true` 才能獲取真實客戶端 IP。
- `GET /coverage?country=FR`：分別返回總量、行政區覆蓋率、各級最低數量三項規則的完成情況。
- `GET /addresses/{id}`：重新查詢某條仍在釋出的地址。

## 錯誤

```json
{ "error": { "code": "INVALID_COUNTRY", "message": "Unknown country code: ZZ" } }
```

| 程式碼 | 含義 |
|---|---|
| `INVALID_COUNTRY` | 不支援的國家程式碼 |
| `INVALID_FIELD` / `INVALID_LOCATION` | 地區參數無效 |
| `INVALID_RESIDENTIAL` | `residential` 取值無效 |
| `INVALID_BATCH_REQUEST` | 批次請求的 `count`、`filters` 或欄位名無效 |
| `NO_POOL_COVERAGE` | 所選範圍內沒有合格地址 |
| `IP_LOCATION_UNAVAILABLE` | 無法根據 IP 確定地區 |

請根據 `error.code` 處理錯誤，不要依賴 `message` 文本。
