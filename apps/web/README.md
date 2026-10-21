# @ota/web — C 端前台

基于 Next.js 15 (App Router) + React 19 + Tailwind 3 的酒店预订前台。页面只消费
`docs/api-contract.md` 里冻结的 HTTP 契约，不直接依赖 `@ota/core` 或任何后端包。

## 运行

```bash
# API 默认在 http://localhost:3001
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001 pnpm --filter @ota/web dev   # http://localhost:3000
pnpm --filter @ota/web build
pnpm --filter @ota/web typecheck
```

`NEXT_PUBLIC_API_BASE_URL` 由 `next.config.ts` 注入，浏览器端与服务端通用；后端需允许跨域
（当前 API 对所有来源开放 CORS）。

## 页面

| 路由 | 类型 | 说明 |
|------|------|------|
| `/` | Server | 首页：搜索表单 + 卖点 + 热门目的地 |
| `/search` | Server (`force-dynamic`) | 搜索结果：排序、分页、空态/错误态 |
| `/hotels/[slug]` | Server (`force-dynamic`) | 酒店详情：图集、设施、政策、按日期的房型报价 |
| `/checkout` | Server 外壳 → Client | 入住人表单 → 验价 → 下单 → 支付 |
| `/orders/[orderNo]` | Server 外壳 → Client | 订单状态：轮询、确认号、取消 |
| `/orders` | Client | 按订单号查询订单 |

## 目录

```
src/
  app/                  路由与布局
  components/           展示组件（Money / OrderStatusBadge 为共享组件）
  lib/
    api.ts              唯一的后端访问层：类型 + ApiError + request()
    format.ts           日期/金额/文案格式化
    status.ts           订单状态文案与轮询/终态判定
    idempotency.ts      幂等键生成与复用
    checkout-state.ts   选房 → 结算 的 URL 传参
    search-params.ts    /search 查询串解析与链接构造
    destinations.ts     可选目的地
```

## 约定

- **金额**：一律使用 API 返回的 `major` + `Intl.NumberFormat` 展示；不对 `amount`
  （整数最小单位）做任何浮点运算。排序比较也用 `amount`。
- **日期**：API 返回 `YYYY-MM-DD`。展示时拆分字符串手动格式化，不使用
  `new Date('YYYY-MM-DD')`（会按 UTC 解析导致日期偏移）。
- **错误**：所有非 2xx 响应统一抛 `ApiError`（`code` / `message` / `retryable` / `details`）。
  页面按错误码给出人话：`PRICE_CHANGED`、`ROOM_UNAVAILABLE`、`CANCEL_NOT_ALLOWED`
  （取 `details.policyDescription`）、`HOTEL_NOT_FOUND`；连不上时显示「后端未启动」。
- **幂等**：所有 POST 走 `Idempotency-Key`。键按「作用域 + 请求体」缓存：同一提交重试复用同一把
  键（双击不会产生两个订单），请求体变化或用户明确确认新价格后换新键（避免
  `409 IDEMPOTENCY_CONFLICT`）。
- **订单状态**：`BOOKING_SUBMITTED` 展示「供应商确认中」，绝不显示「预订成功」；只有
  `CONFIRMED` 才展示确认号。轮询每 3 秒一次，进入终态即停止。
- **构建**：所有会取数的页面都标了 `export const dynamic = 'force-dynamic'`，因此
  `next build` 不会去连后端。
