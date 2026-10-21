# API 契约 v1

所有接口前缀 `/api/v1`，请求/响应均为 `application/json`。
金额一律输出 `{ "amount": <整数最小单位>, "currency": "CNY", "major": 1234.56 }`。
日期一律 `YYYY-MM-DD` 字符串。

统一错误体：

```json
{
  "error": {
    "code": "ROOM_UNAVAILABLE",
    "message": "所选房型已售罄",
    "retryable": false,
    "details": {}
  }
}
```

所有 `POST` 接受 `Idempotency-Key` 请求头；同 key + 同 body 重放首次响应；同 key + 不同 body 返回 `409 IDEMPOTENCY_CONFLICT`。

| 接口 | `Idempotency-Key` |
|------|-------------------|
| `POST /api/v1/bookings` | 必填 |
| `POST /api/v1/bookings/:orderNo/pay` | 必填 |
| `POST /api/v1/bookings/:orderNo/cancel` | 必填 |
| `POST /api/v1/quotes/precheck` | 可选（带则幂等，不带则每次重新验价） |

> 幂等记录在**状态检查之前**开启：同 key + 不同 body 一律 409，即使订单已经付过款也一样。
> 否则客户端无法区分「已经付过了」和「这次请求内容不对」。

---

## 1. 酒店搜索

`GET /api/v1/hotels/search`

Query：

| 参数 | 必填 | 说明 |
|------|------|------|
| `destination` | 是 | 目的地：城市名 / 城市 ID / 国家码，前端默认传城市名 |
| `checkIn` | 是 | `YYYY-MM-DD` |
| `checkOut` | 是 | `YYYY-MM-DD` |
| `rooms` | 是 | 房数，默认 1 |
| `adults` | 是 | 成人数，默认 2 |
| `childAges` | 否 | 逗号分隔的儿童年龄，如 `5,8`；无则省略 |
| `currency` | 否 | 默认 `CNY` |
| `nationality` | 否 | 客人国籍 ISO-3166 alpha-2，默认 `CN` |
| `page` | 否 | 默认 1 |
| `pageSize` | 否 | 默认 20，上限 50 |

响应 `200`：

```json
{
  "checkIn": "2026-11-10",
  "checkOut": "2026-11-12",
  "nights": 2,
  "rooms": 1,
  "adults": 2,
  "currency": "CNY",
  "hotels": [
    {
      "id": "clx123",
      "supplierHotelId": "10884",
      "slug": "banyan-tree-phuket",
      "name": "Banyan Tree Phuket",
      "starRating": 5,
      "address": {
        "street": "33 Moo 4 Srisoonthorn Road",
        "city": "普吉",
        "country": "泰国",
        "countryCode": "TH",
        "postalCode": "83110"
      },
      "geo": { "latitude": 8.0105, "longitude": 98.2958 },
      "thumbnail": "https://pix8.agoda.net/.../0.jpg",
      "images": ["https://pix8.agoda.net/.../0.jpg"],
      "lowestNightlyTotal": { "amount": 90000, "currency": "CNY", "major": 900 },
      "lowestStayTotal": { "amount": 180000, "currency": "CNY", "major": 1800 },
      "reviewScore": 9.1,
      "reviewCount": 3200
    }
  ],
  "total": 42,
  "page": 1,
  "pageSize": 20
}
```

---

## 2. 酒店详情（静态资源）

`GET /api/v1/hotels/:id`

`:id` 为本地酒店 ID 或 slug（两者都支持）。

响应 `200`：

```json
{
  "id": "clx123",
  "supplierHotelId": "10884",
  "slug": "banyan-tree-phuket",
  "name": "Banyan Tree Phuket",
  "starRating": 5,
  "description": "……",
  "address": { "street": "…", "city": "普吉", "country": "泰国", "countryCode": "TH", "postalCode": "83110" },
  "geo": { "latitude": 8.0105, "longitude": 98.2958 },
  "checkInTime": "15:00",
  "checkOutTime": "12:00",
  "images": [{ "url": "https://…", "caption": "外观", "position": 0 }],
  "amenities": [{ "group": "设施", "name": "健身房" }],
  "policies": ["禁止携带宠物"],
  "roomTypes": [
    {
      "id": "clxrt1",
      "supplierRoomTypeId": "3122086",
      "name": "泳池别墅",
      "description": "…",
      "maxOccupancy": 2,
      "bedType": "特大床",
      "sizeSqm": 120,
      "imageUrls": ["https://…"]
    }
  ]
}
```

`404 HOTEL_NOT_FOUND` 表示该酒店尚未同步进库（此时应先跑内容同步）。

---

## 3. 房型库存与报价

`GET /api/v1/hotels/:id/availability`

Query：与搜索相同的日期/占住参数，外加 `currency`、`nationality` 可选。

响应 `200`：

```json
{
  "hotelId": "clx123",
  "checkIn": "2026-11-10",
  "checkOut": "2026-11-12",
  "nights": 2,
  "currency": "CNY",
  "quotes": [
    {
      "offerId": "off_abc123",
      "roomTypeId": "clxrt1",
      "roomTypeName": "泳池别墅",
      "ratePlanId": "clxrp1",
      "ratePlanName": "不可取消",
      "bedType": "特大床",
      "maxOccupancy": 2,
      "nights": 2,
      "nightly": {
        "net":   { "amount": 45000, "currency": "CNY", "major": 450 },
        "taxes": { "amount": 9000,  "currency": "CNY", "major": 90 },
        "total": { "amount": 54000, "currency": "CNY", "major": 540 }
      },
      "stayTotal": {
        "net":   { "amount": 90000,  "currency": "CNY", "major": 900 },
        "taxes": { "amount": 18000,  "currency": "CNY", "major": 180 },
        "total": { "amount": 108000, "currency": "CNY", "major": 1080 }
      },
      "mealPlan": "BREAKFAST_INCLUDED",
      "payAtHotel": false,
      "instantConfirmation": true,
      "allotment": 4,
      "taxesIncluded": true,
      "cancellationPolicy": {
        "type": "FULL_REFUND",
        "refundable": true,
        "freeCancellationUntil": "2026-11-08",
        "penaltyAmount": null,
        "penaltyPercent": null,
        "description": "入住前 2 天可免费取消"
      }
    }
  ]
}
```

`mealPlan` 取值：`NO_BREAKFAST` | `BREAKFAST_AVAILABLE` | `BREAKFAST_INCLUDED` | `HALF_BOARD` | `FULL_BOARD` | `ALL_INCLUSIVE`。
`cancellationPolicy.type` 取值：`FULL_REFUND` | `PARTIAL_REFUND` | `NON_REFUNDABLE`。

---

## 4. 下单前验价（Precheck）

`POST /api/v1/quotes/precheck`

```json
{
  "hotelId": "clx123",
  "offerId": "off_abc123",
  "checkIn": "2026-11-10",
  "checkOut": "2026-11-12",
  "rooms": 1,
  "adults": 2,
  "childAges": [],
  "currency": "CNY",
  "nationality": "CN"
}
```

响应 `200`：

```json
{
  "offerId": "off_abc123",
  "priceChanged": false,
  "available": true,
  "quote": { "…同 §3 的 quote 结构…" },
  "total": { "amount": 108000, "currency": "CNY", "major": 1080 }
}
```

`priceChanged: true` 表示供应商重新定价，前端必须让客户看到新价格再继续。

Header：`Idempotency-Key: <uuid>`（可选；带则同 key + 同 body 重放首次响应）。

---

## 5. 创建订单

`POST /api/v1/bookings`

Header：`Idempotency-Key: <uuid>`

```json
{
  "hotelId": "clx123",
  "offerId": "off_abc123",
  "checkIn": "2026-11-10",
  "checkOut": "2026-11-12",
  "rooms": 1,
  "adults": 2,
  "childAges": [],
  "currency": "CNY",
  "nationality": "CN",
  "guest": {
    "firstName": "张",
    "lastName": "三",
    "email": "zhangsan@example.com",
    "phone": "+8613800000000"
  },
  "specialRequests": ["延迟退房"],
  "acceptedTotal": 108000
}
```

`acceptedTotal` 可选，**整数最小单位**。当供应商在客户选定房型之后又涨价时必填，
值必须与服务端要求的金额完全一致，否则返回 `409 PRICE_CHANGED`：

```json
{
  "error": {
    "code": "PRICE_CHANGED",
    "message": "价格已变动，请确认最新价格后继续下单",
    "retryable": false,
    "details": { "expected": 108000, "actual": null, "currency": "CNY" }
  }
}
```

`details.expected` 是客户必须接受的金额（整数最小单位）。客户端展示新价格、
客户确认后，把 `acceptedTotal` 设为 `details.expected` 重新提交即可。

响应 `201`（见 §7 订单对象）。

---

## 6. 支付

`POST /api/v1/bookings/:orderNo/pay`

Header：`Idempotency-Key: <uuid>`

```json
{ "method": "mock_card" }
```

响应 `200`（订单对象 + `payment` 字段）：

```json
{
  "orderNo": "OTA-20261020-8F3KQ2",
  "status": "PAID",
  "payment": {
    "status": "CAPTURED",
    "amount": { "amount": 108000, "currency": "CNY", "major": 1080 },
    "provider": "mock",
    "clientSecret": null,
    "redirectUrl": null
  },
  "booking": { "…订单对象…" }
}
```

顶层 `status` 与 `booking.status` 始终一致；完整订单对象在 `booking` 里。

支付成功后系统会向供应商下单；订单状态可能先是 `BOOKING_SUBMITTED`（供应商处理中），再变成 `CONFIRMED`。

---

## 7. 订单对象

```json
{
  "id": "clxbooking1",
  "orderNo": "OTA-20261020-8F3KQ2",
  "status": "PENDING_PAYMENT | PAID | BOOKING_SUBMITTED | CONFIRMED | CHECKED_IN | CHECKED_OUT | REFUND_PENDING | REFUNDED | CANCELLED | EXPIRED | FAILED",
  "supplierStatus": "PROCESSING | CONFIRMED | null",
  "confirmationNumber": "AGD-99887766",
  "hotel": {
    "id": "clx123",
    "slug": "banyan-tree-phuket",
    "name": "Banyan Tree Phuket",
    "starRating": 5,
    "thumbnail": "https://…",
    "address": { "city": "普吉", "country": "泰国", "countryCode": "TH" }
  },
  "stay": {
    "checkIn": "2026-11-10",
    "checkOut": "2026-11-12",
    "nights": 2,
    "rooms": 1,
    "adults": 2,
    "childAges": []
  },
  "guest": {
    "firstName": "张",
    "lastName": "三",
    "email": "zhangsan@example.com",
    "phone": "+8613800000000"
  },
  "price": {
    "net":   { "amount": 90000,  "currency": "CNY", "major": 900 },
    "taxes": { "amount": 18000,  "currency": "CNY", "major": 180 },
    "total": { "amount": 108000, "currency": "CNY", "major": 1080 },
    "paid":  { "amount": 108000, "currency": "CNY", "major": 1080 },
    "refunded": { "amount": 0, "currency": "CNY", "major": 0 }
  },
  "items": [
    {
      "offerId": "off_abc123",
      "roomTypeName": "泳池别墅",
      "ratePlanName": "不可取消",
      "nights": 2,
      "nightlyTotal": { "amount": 54000, "currency": "CNY", "major": 540 },
      "total": { "amount": 108000, "currency": "CNY", "major": 1080 },
      "mealPlan": "BREAKFAST_INCLUDED",
      "payAtHotel": false,
      "cancellationPolicy": { "…同 §3…" }
    }
  ],
  "specialRequests": [],
  "payment": { "status": "CAPTURED", "amount": { "…": 0 }, "provider": "mock" },
  "refunds": [],
  "createdAt": "2026-10-20T12:00:00.000Z",
  "updatedAt": "2026-10-20T12:00:01.000Z",
  "confirmedAt": null,
  "cancelledAt": null
}
```

---

## 8. 查询订单

`GET /api/v1/bookings/:orderNo` → 订单对象（§7）。

---

## 9. 取消订单

`POST /api/v1/bookings/:orderNo/cancel`

Header：`Idempotency-Key: <uuid>`

```json
{ "reason": "行程变更" }
```

响应 `200`：

```json
{
  "booking": { "…订单对象…" },
  "cancellation": {
    "cancelled": true,
    "penaltyAmount": { "amount": 0, "currency": "CNY", "major": 0 },
    "refundAmount": { "amount": 108000, "currency": "CNY", "major": 1080 },
    "policyType": "FULL_REFUND"
  }
}
```

不可取消时返回 `409 CANCEL_NOT_ALLOWED`，`details` 带 `policyType` 与 `policyDescription`。

`Idempotency-Key` 生效：同 key + 同 body 重放**首次**的 200 响应（不会重复退款）；
同 key + 不同 body 返回 `409 IDEMPOTENCY_CONFLICT`；
换一个新 key 取消一个已取消的订单返回 `409 CANCEL_NOT_ALLOWED`。

取消截止时间按**物业当地时区**判定（`Hotel.timeZone`，如 `Asia/Bangkok`），不是 UTC。

---

## 10. 支付回调

`POST /api/v1/payments/webhook`

Body 为支付网关原始报文；由 `PAYMENT_WEBHOOK_SECRET` 验签。mock 网关会在创建支付后异步回调一次 `payment.succeeded`。

---

## 11. 运营接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/admin/sync/hotels` | 触发静态资源同步，body `{ "hotelIds": [], "limit": 100 }` |
| POST | `/api/v1/admin/sync/hotels/:supplierHotelId` | 同步单家酒店，响应 `{ jobId, total, created, updated, skipped, failed }` |
| GET | `/api/v1/admin/sync/jobs?limit=` | 最近的同步任务，响应 `{ "jobs": [{ id, type, status, total, processed, failed, error, startedAt, finishedAt }] }` |
| GET | `/api/v1/admin/bookings?status=&limit=` | 订单列表 |
| GET | `/api/v1/admin/outbox?status=&limit=` | 事件与投递状态 |
| POST | `/api/v1/admin/outbox/drain` | 立即处理待投递事件 |
| POST | `/api/v1/admin/bookings/poll` | 立即轮询处理中订单 |

---

## 12. 其它

- `GET /health` → `{ "status": "ok", "supplier": "agoda", "supplierMode": "mock", "time": "…" }`
- `GET /docs` → OpenAPI UI
