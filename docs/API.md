# API

English · [简体中文](API.zh-CN.md) · [繁體中文](API.zh-TW.md)

Address serves a JSON API under `/api/v1`. A running instance also documents every parameter interactively at `/en/api/` and publishes `/api/v1/openapi.json`.

## Authentication

Every request except `/health`, `/ready`, and `/openapi.json` needs a Bearer token created under **API Tokens** in the admin console:

```http
Authorization: Bearer YOUR_API_TOKEN
```

Tokens can be limited by scope (read / generate), requests per minute, and expiry. Authentication failures return `401`; exceeding the rate limit returns `429` with `Retry-After: 60`.

## Quick examples

```bash
curl -fsS "https://address.example.com/api/v1/generate?country=US&city=Seattle" \
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

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness check |
| `GET` | `/ready` | Database readiness check |
| `GET` | `/openapi.json` | OpenAPI 3.1 document |
| `GET` | `/countries` | Supported countries with current address counts |
| `GET` | `/availability` | Countries that can generate right now |
| `GET` | `/client-context` | Resolve the caller's or a given IP to a country and area |
| `GET` | `/locations/search` | Search regions, cities, districts, and postcodes |
| `GET` | `/locations/hierarchy` | Browse administrative areas level by level |
| `GET` | `/generate` | Generate one address with matching test profile data |
| `POST` | `/generate/batch` | Generate up to 50 addresses |
| `GET` | `/addresses/{id}` | Look up a published address by ID |
| `GET` | `/coverage` | A country's three sync completion rules |
| `POST` | `/address-translation` | Translate an address into a display language |
| `GET` | `/data-health` | Address-pool coverage and readiness, for monitoring |

## Generate an address

`GET /generate`

| Parameter | Default | Description |
|---|---|---|
| `country` | `US` | Country code such as `US`, `CN`, `JP` |
| `region` / `city` / `district` / `postcode` | — | Filter by name, up to 300 characters each |
| `regionId` / `cityId` / `districtId` / `postcodeId` | — | Filter by IDs returned from `/locations/*`; preferred |
| `residential` | `true` for China, otherwise `false` | `true` returns only addresses with residential evidence; China is always residential |
| `mode` | — | `ip-region` generates within the area of an IP |
| `ip` | caller IP | Used with `mode=ip-region` |
| `seed` | random | The same seed selects the same record and test data, for reproducible results |
| `strategy` | `random` | `random` or `instant` |
| `requestId` | random UUID | Caller-defined correlation ID |

Filters are strict: when nothing qualifies in the selected area the API returns `NO_POOL_COVERAGE` instead of falling back to a nearby or parent area.

**Response** (abridged):

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
      "profile": { "…": "synthetic test data" }
    }
  }
}
```

| Field | Description |
|---|---|
| `address.matchLevel` | Precision: `street`, `premise`, or `subpremise` |
| `address.propertyType` | `residential` only with independent residential evidence; `unknown` for street-level records |
| `address.addressVariants` | Native, English, Simplified Chinese, and other renderings of the same facts |
| `address.evidence` | Source and verification evidence |
| `eligibleCount` | Qualifying addresses in the filtered area; returned on some request paths |
| `profile`, `card`, … | **Synthetic** person, card, employment, and network test data, unrelated to the real address |

All address fields come from the source; missing house numbers, buildings, or postcodes stay empty. The only synthetic address fields are the building, unit, floor, and room of Chinese addresses, and they are labelled `synthetic`.

## Batch generation

`POST /generate/batch`

```json
{
  "count": 20,
  "filters": { "country": "DE", "city": "Berlin" },
  "options": { "unique": true, "seed": "batch-2026", "strategy": "random" },
  "excludeAddressIds": []
}
```

- `count`: 1–50.
- `options.unique`: never return the same address twice.
- `excludeAddressIds`: up to 500 address IDs to skip.

When fewer qualifying addresses exist, the response contains what is available and sets `exhausted: true`.

## Location search

`GET /locations/search`

| Parameter | Default | Description |
|---|---|---|
| `country` | `US` | Country code |
| `field` | `city` | `region`, `city`, `district`, or `postcode` |
| `q` | — | Search text |
| `regionId` / `cityId` | — | Parent area ID |
| `residential` | `false` | `true` counts only addresses with residential evidence |
| `limit` | `100` | Page size, 20–200 |
| `cursor` | — | `nextCursor` from the previous page |

```bash
curl -fsS "https://address.example.com/api/v1/locations/search?country=GB&field=city&q=Man" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

Pass returned `id` values unchanged to the `*Id` parameters of `/generate`. Postcode options may have no catalog ID; pass their `value` as `postcode` instead. China district options also return their city (`parentValue`, `parentId`) and province (`regionValue`, `regionId`) because district names repeat across cities; a `districtId` alone selects that exact district.

Option lists are served from a per-country snapshot that is rebuilt in the background, so counts can trail newly published addresses by a few minutes.

`GET /locations/hierarchy` takes `country`, `parentType`, `parentId`, and `childType` to browse areas level by level.

## Address translation

`POST /address-translation`

```json
{ "addressId": "pool-v2-addr-0172af2a1d3cb634cf1e6fce35b298e511ced17f", "targetLocale": "ja" }
```

`targetLocale` is one of `en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `de`, `fr`, `es`, `pt`. House numbers, unit numbers, and postcodes are always preserved. When no valid translation exists the response is `fallback` or `unavailable`, and clients can show the original address.

## Other endpoints

- `GET /countries` – `addressCount` is the number of addresses that can be generated; `residentialCount` is the subset with residential evidence.
- `GET /availability` – `available` means addresses exist; `residentialAvailable` means residential addresses exist.
- `GET /client-context?ip=8.8.8.8` – Country, region, city, postcode, and coordinates for an IP. Behind a reverse proxy, set `TRUST_PROXY=true` in the deployment to see real client IPs.
- `GET /coverage?country=FR` – Progress on the total, administrative coverage, and per-level minimum rules.
- `GET /addresses/{id}` – Fetch an address that is still published.

## Errors

```json
{ "error": { "code": "INVALID_COUNTRY", "message": "Unknown country code: ZZ" } }
```

| Code | Meaning |
|---|---|
| `INVALID_COUNTRY` | Unsupported country code |
| `INVALID_FIELD` / `INVALID_LOCATION` | Invalid location parameter |
| `INVALID_RESIDENTIAL` | Invalid `residential` value |
| `INVALID_BATCH_REQUEST` | Invalid batch `count`, `filters`, or field name |
| `NO_POOL_COVERAGE` | No qualifying address in the selected area |
| `IP_LOCATION_UNAVAILABLE` | The IP could not be resolved to an area |

Handle errors by `error.code`; never parse `message`.
