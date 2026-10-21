# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 这是什么

C 端 OTA 酒店销售系统。供应商是 **Agoda Demand API**（我们拉 Agoda 库存再销售），履约与收款模型是 **Partner Fulfillment**（客户的钱我们收、我们退款，Agoda 只是我们的供应商）。

三个文档是仓库的「合同」，动代码前先读：

- `SPEC.md` —— **本仓库的合同**（v0.2）。任何代码改动若偏离规格，**必须先改 SPEC**。
- `docs/api-contract.md` —— 对外 HTTP 契约，前后端共同遵守；改接口要同时改它。
- `docs/acceptance.md` —— SPEC §8 的逐条验收对照与证据。

## 仓库结构（pnpm monorepo）

```
packages/core                领域内核：金额/日期/错误/状态机/重试熔断/StayContext 指纹/ID
packages/agoda-connectivity  供应商适配器：contract.ts（唯一供应商契约）+ live/ + mock/ + xml/
apps/api                     Fastify 5 后端（catalog / search / booking / payment / notify / admin）
apps/web                     Next.js 15 App Router C 端前台
```

分层依赖**单向，不得反向**：

```
web ──HTTP──> api ──> agoda-connectivity ──> core
```

- `core` 不依赖任何业务包，是**全仓唯一真源**；任何包不得重复定义金额、日期、错误、状态机。
- `agoda-connectivity` 不依赖 `api`；`api` 不依赖 `web`。
- `apps/web` **不 import** `@ota/core`：它通过 `NEXT_PUBLIC_API_BASE_URL`（默认 `http://localhost:3001`，API 侧 CORS 放开）走 HTTP，并在 `apps/web/src/lib/api.ts` 里**手抄**了一份 DTO 类型。改契约时这个文件要一起改。

## 命令

```bash
pnpm install
cp .env.example .env          # 至少改 DATABASE_URL
createdb ota_hotel
pnpm db:setup                  # prisma generate + db push + seed（12 家 mock 酒店）
pnpm dev                       # 并行起 API(:3001, /docs) 与 web(:3000)
```

| 命令 | 说明 |
|------|------|
| `pnpm build` | core → connectivity → api（tsc），再 web（next build）。**顺序由 pnpm 拓扑排序保证** |
| `pnpm test` | `pnpm -r test` —— **不含 web**（web 没有 test script） |
| `pnpm -r typecheck` | 全仓 `tsc --noEmit` |
| `pnpm --filter @ota/api db:setup` | generate + db push + seed |
| `pnpm --filter @ota/api db:reset` | 重建库并重新灌种子 |
| `pnpm smoke` / `node scripts/smoke.mjs` | 对**运行中**的 API 发真实 HTTP 的 16 步端到端冒烟 |
| `pnpm --filter @ota/api exec prisma db push --skip-generate` | 只建表不灌数据 |

改了 `packages/core` 后必须先 `pnpm --filter @ota/core build`：`@ota/*` 是 workspace 依赖 + `dist/` 消费，api 编译时读的是 `packages/core/dist`，不是源码。

### 跑单个测试文件

```bash
pnpm --filter @ota/core exec vitest run test/states.test.ts
pnpm --filter @ota/agoda-connectivity exec vitest run test/xml-codec.test.ts
pnpm --filter @ota/api exec vitest run test/booking-contract.test.ts
```

- `core`（money/date/errors/ids/retry/states/stay-context）与 `agoda-connectivity`（factory/mock-adapter/live-adapter/rate-limiter/xml-codec）**完全离线**。`packages/agoda-connectivity` 没有 vitest 配置文件，用 vitest 默认的 `test/**/*.test.ts`。
- `api`（catalog/search/booking-contract/booking-recovery/e2e/notify）需要**本机真实 PostgreSQL**：`test/global-setup.ts` 会 `createdb` + `prisma db push --force-reset` 建/重置 `ota_hotel_test`（可用 `TEST_DATABASE_URL` 覆盖），文件**串行**执行（`fileParallelism: false`）。`psql` / `createdb` 必须在 PATH 上。
- API 测试跑的是真实 Fastify + 真实 Postgres，刻意不 mock 事务与唯一约束 —— 那些约束正是这些测试存在的理由。改 Prisma schema 后要能一条 `prisma db push` 顶上来（没有 migrations 目录，用的是 `db push` 而非 `migrate deploy`）。

## 关键不变量

这些是「看起来可以随便改，改了就线上事故」的地方。

### 1. 金额：一律整数最小单位

- 存储和运算都是**整数最小单位**（分/元/铢/日元），禁止 float 参与金额计算。`Money = { amount: number, currency: Currency }`。
- 跨层用 `toDTO()` / `fromDTO()`（`packages/core/src/money.ts`），**不要硬编码 `/100`**：JPY/KRW/VND/IDR 是零小数币种，`decimalsFor(currency)` 才是正确来源。
- 单币种下单，跨币种不做隐式换算。

### 2. 日期：一律 LocalDate + UTC 算术

- 入住日期是 `LocalDate`（`YYYY-MM-DD` 字符串），**不是时间戳**。`nights = 离店日 − 入住日`，入住日算第 1 晚。
- 日期算术一律走 UTC（`toUtcMillis`/`fromUtcMillis`），规避夏令时与时区漂移。房晚分段是 `[入住日, 离店日)`。
- **取消截止按物业当地时区判定**：用 `localDateInZone(now, hotel.timeZone)`，不是 UTC。曼谷当地已是次日时，用 UTC 判定会错一整天，导致免费取消被拒。`Hotel.timeZone` 缺失回退 `UTC`（不猜）。

### 3. 状态机：每次写入都要断言 + 条件更新

- 迁移表集中在 `packages/core/src/states.ts`（`BOOKING_STATUS` / `PAYMENT_STATUS` / `REFUND_STATUS` / `DELIVERY_STATUS`）。非法迁移直接抛错。
- **每一次状态写入都必须**：先 `assertBookingTransition(from, to)`，再用带当前状态条件的 UPDATE（`where: { id, status: from }`）。条件不匹配即视为状态已变化、拒绝写入 —— 这是让轮询器和运营请求无法并发推进同一订单的唯一机制。
- `CONFIRMED` 是**唯一**可以对客户宣称「已订到」的状态。终态（`REFUNDED`/`CANCELLED`/`EXPIRED`）不会被迟到的供应商确认复活。
- `PROCESSING` 不是订单状态，是供应商侧状态，体现在 `Booking.supplierStatus` 上。
- 未支付订单被取消直接进 `CANCELLED`，不进 `REFUND_PENDING`。

### 4. StayContext 指纹：Search / Precheck / Book 三段必须一致

- Agoda 会因参数漂移直接拒单。做法：`fingerprintStayContext(ctx)`（SHA-256 稳定序列化）算一次，三次调用携带同一指纹，订单落库存档，指纹不符直接拒单（`VALIDATION_ERROR`）。
- `StayContext` = `supplierHotelId, checkIn, checkOut, rooms, adults, childAges[], currency, nationality`。
- 同一 `offerId` 可能有多行报价，**下单取 `createdAt` 最新的一行**（旧行是旧价，会被判价格变化）。

### 5. `processing: true` = 只锁了房量，尚未确认

- 订单停在 `BOOKING_SUBMITTED`，每 15s 轮询 Booking Detail，**最长 30 分钟**（`BOOKING_POLL_INTERVAL_SECONDS` / `BOOKING_POLL_MAX_MINUTES`）。
- 轮询期间对客户只能说「确认中」。这条是整套系统正确性的核心。
- 30 分钟仍未确认 → `FAILED` + 自动全额退款 + 运营告警。

### 6. 涨价必须客户确认，且**服务端强制**

- 报价行有两个价格：`quotedTotalAmount`（客户最后看到的基准线）、`pendingTotalAmount`（供应商在客户选定房型后又涨价时写入）。
- Precheck 比对：变大 → `priceChanged: true` 并写 `pendingTotalAmount`；变小 → 不需要确认。
- 创建订单时 `pendingTotalAmount` 非空，请求**必须带 `acceptedTotal`**（整数最小单位）且与服务端期望值**完全相等**，否则 `409 PRICE_CHANGED`（`details.expected` / `details.actual`）。
- 不能只靠前端弹窗；订单落库记录 `Booking.acceptedTotalAmount` 作为审计痕迹。

### 7. 幂等：`Idempotency-Key`

- 创建订单 / 支付 / 取消**必填**；Precheck 可选。
- 同 key + 同 body → 重放首次响应（状态码与 body 一致）；同 key + **不同** body → `409 IDEMPOTENCY_CONFLICT`（即使订单已付过款也一样）。
- 实现在 `apps/api/src/lib/idempotency.ts`（`beginIdempotent` / `completeIdempotent` / `failIdempotent`）。

### 8. Outbox：事件与状态变更同事务

- 领域事件与状态变更在**同一个 `$transaction`** 里写「改状态 + 写 BookingEvent + 写 OutboxEvent」。不允许「先改状态再补事件」——中间崩溃就永久丢通知且无对账路径。
- 事件唯一键冲突**不算错误**，事件写入不得回滚业务事务（`emitEventIdempotent`）。
- `AuditLog` 与对应 `OutboxEvent` 同事务写入（`reportToOps()`），两者要么都成立要么都不成立。
- 投递器异步消费，每通道（email/sms/webhook）**独立**投递独立重试，互不阻塞；连续失败达 `NOTIFY_ESCALATION_THRESHOLD` → 标记 `escalatedAt` 并自动上报运营通道（`ops` channel）。
- 幂等靠 `dedupeKey` 唯一。
- 投递细节（`modules/notify/`）：pump 每轮取 50 条（`OUTBOX_BATCH_SIZE`），用 lease 抢占（outbox 5min / delivery 60s，lease 过期自动回收）；通道重试退避是**等抖动**指数退避（`RETRY_BASE_MS=5s`、`RETRY_MAX_MS=30min`，见 `notify/backoff.ts`）。

### 9. 供应商重试与退款

- **传输层禁止对 `book()` 自动重试** —— 盲重试会重复下单。业务层用**同一个** supplier idempotency key 驱动重放。
  （`cancel()` 相反：上游取消是幂等的，所以它**会**用 `withRetry` 重试。）
- `Booking.supplierAttempts` 上限 **5** 次。
- 瞬时故障（超时 / 429 / 5xx）→ 订单退回 `PAID` 交轮询器重放，**不退款**。
- 不可重试故障（拒单 / 重复单 / 价格变化）→ `FAILED` + **自动全额退款**（`autoRefund()`，独立幂等记录）。
- 支付成功但下单失败 → **必须自动全额退款**，不允许静默吞单。

### 10. 超时与限流（禁止合成一个值）

| 端点 | 默认超时 |
|------|----------|
| content / search / detail / cancel | 30s |
| **precheck** | **60s** |
| **booking** | **120s** |

客户端自带限流器（RPM + 突发），阈值从环境变量读，**上线前以 Agoda onboarding 下发的阈值为准**。内容类接口不得高频轮询。

### 11. XML 元素名集中在一个文件

`packages/agoda-connectivity/src/xml/schema.ts` 是**唯一的**供应商 XML 映射点。拿到 Agoda welcome package 后**只改这一个文件**。

## 架构要点

### Ports & adapters（不要自己再发明一套）

| Port | 位置 | 实现 |
|------|------|------|
| `SupplierAdapter` | `packages/agoda-connectivity/src/contract.ts` | `AgodaLiveAdapter` / `AgodaMockAdapter` |
| `PaymentProvider` | `apps/api/src/lib/payment-provider.ts` | mock / stripe |
| `Cache` + `Lock` | `apps/api/src/lib/cache.ts` | Redis（有 `REDIS_URL`）/ 进程内（无 Redis 时降级） |
| `NotifyChannel` | `apps/api/src/modules/notify/types.ts` | email / sms / webhook / ops |
| `Logger` | `packages/core/src/logger.ts` | API 里是 pino 的适配 |

- **SupplierAdapter 是唯一的供应商词汇表**：接口与全部 DTO（`SupplierHotel` / `SupplierQuote` / `SupplierPrecheckInput` / `SupplierBookingInput` / `SupplierBookingDetail` / `SupplierCancelInput` …）都在 `contract.ts`。业务层只认这一套 DTO，不知道 XML、不知道 Agoda。`factory.ts` 按 `AGODA_MODE` 选 `live/` 或 `mock/`；live 构造时缺凭证直接抛 `CONFIG_ERROR`（fail fast）。
- **依赖注入靠 `AppContext`**（`apps/api/src/lib/context.ts`：`{ config, logger, prisma, cache, lock, supplier, payment, now }`），由 `lib/bootstrap.ts` 的 `createContext()` 组装。模块之间**不互相 import 内部实现**；payment ↔ booking 的循环依赖用 `lib/hooks.ts`（`PaymentHooks`）断开。
- **mock 是高保真的**：内含 12 家酒店目录与定价引擎（`mock/catalog.ts` / `mock/pricing.ts` / `mock/ledger.ts`）。**完全确定性** —— 随机数来自 seeded PRNG（`mock/prng.ts`，按 key 派生而非按调用顺序），不用 `Math.random()`。mock 说与 live **同一套 XML 方言**（响应也是编码成 XML 再解回来，编解码 bug 在开发期就会暴露）。可注入故障：价格漂移、售罄、`processing`、429、重复拒单、超时；`AGODA_MOCK_PRICE_DRIFT_RATE=1` 可对着跑起来的系统演示「涨价 → 客户确认」链路；`adapter.failNext(n, 'timeout' | 'rateLimit' | 'sellOut' | 'duplicate' | …)` 可手动排队故障。
- **下单主链路**（读代码时的顺序）：`modules/booking/index.ts`（路由）→ `service.ts:createBooking()` → `service.ts:payBooking()` → `submitToSupplier()` → `handleSupplierFailure()` / `confirmBooking()` / `failBookingAndRefund()` → `pollPendingBookings()`（后台轮询，`modules/booking/service.ts`）→ `modules/notify/` outbox 投递。
- **供应商调用在事务之外**：`submitToSupplier()` 不持有 DB 事务（120s 的网络调用绝不能把事务吊着）。状态写入一律经 `changeStatus(tx, bookingId, {from, to, data, eventType, eventData})` —— 断言 + 条件 `updateMany` + 写 `BookingEvent`。
- **路由注册**在 `apps/api/src/server.ts`，各模块导出 `registerXxxRoutes(app, ctx)`；`ctx` 由 `app.decorate('ctx', ctx)` 挂到 Fastify 实例上（类型见 `src/types/fastify.d.ts`）。
- **后台任务**在 `apps/api/src/index.ts` 启动：outbox worker（5s）+ `pollPendingBookings` 定时器（15s）。outbox 表是唯一真相源，进程重启不会丢活。轮询任务拿分布式锁 `poll-pending-bookings`。
- **幂等作用域**：`booking:create`、`booking:pay:<orderNo>`、`booking:cancel:<orderNo>`、`quote:precheck`。记录表 `IdempotencyRecord`（key 唯一 + scope + requestHash + state + responseStatus/responseBody + expiresAt）。
- **配置**全部走 `apps/api/src/config.ts` 的 zod env schema（`loadConfig()`，带缓存，`import 'dotenv/config'`）。生产环境若仍用开发默认密钥（`PAYMENT_WEBHOOK_SECRET` / `OPS_ALERT_WEBHOOK_SECRET`）**拒绝启动**。
- **Prisma** 只在 `apps/api` 用；数据模型在 `apps/api/prisma/schema.prisma`（金额一律 Int 最小单位，注释里写死「Never Decimal, never Float」）。Prisma 枚举与 core 状态机一一对应。**业务规则一律放 core / 纯函数**（如 `modules/booking/cancellation.ts` 的 `evaluateCancellation`），Prisma 只当持久化适配器。

### 前台（apps/web）

- Next 15 App Router，路径别名 `@/* → ./src/*`（**全仓唯一的 TS path alias**，服务端包一律相对路径 + `.js` 后缀）。
- 页面全是 `export const dynamic = 'force-dynamic'` 的异步 server component；客户端组件只有 `CheckoutClient.tsx`（客人表单 → precheck → 建单 → 支付，含涨价提示）、`OrderTracker.tsx`（轮询订单状态约 3s）、`SearchForm.tsx`、`HotelGallery.tsx`、`SmartImage.tsx`、`HotelStayBar.tsx`，以及 `app/orders/page.tsx`。
- **不 import `@ota/core`**，直接浏览器 fetch API（没有 Next 服务端代理；API 侧 CORS 对所有 origin 放开）。基础地址 `NEXT_PUBLIC_API_BASE_URL`（默认 `http://localhost:3001`）。DTO 类型在 `apps/web/src/lib/api.ts` 手抄了一份，与 `docs/api-contract.md` 对齐 —— **改契约要同时改这里**。
- 金额比较在前端也用整数最小单位（`lowestStayTotal.amount`），不碰 float。
- `src/lib/status.ts` 的 `ORDER_STATUS_META` 是文案真源：`BOOKING_SUBMITTED` 显示「供应商确认中」，**任何地方都不能显示「预订成功」**。

## 代码约定

- TypeScript strict：`noUncheckedIndexedAccess`、`noImplicitOverride`、`noFallthroughCasesInSwitch` 全部开启；ESM + `verbatimModuleSyntax`，**相对导入必须带 `.js` 后缀**；类型导入用 `import type`。
- 错误统一走 `AppError` / `toAppError()`（`packages/core/src/errors.ts`），错误码见 `AppErrorCode`（`VALIDATION_ERROR` / `PRICE_CHANGED` / `ROOM_UNAVAILABLE` / `IDEMPOTENCY_CONFLICT` / `INVALID_STATE` / `SUPPLIER_*` …）；HTTP 层在 `apps/api/src/lib/errors.ts` 的 `registerErrorHandler` 转成 `{ error: { code, message, retryable, details } }`。
  **逻辑只认 `code` 和 `retryable`，不要匹配 message 文案。** 非法状态迁移是 409 `INVALID_STATE`，不是 500。
- 时间/等待用 `@ota/core` 的 `sleep` / `withRetry` / `backoffDelay` / `CircuitBreaker`，不要自己造轮子。
- 日志用 pino（`@ota/core` 的 `Logger` 端口），不要 `console.log`；`authorization` / `x-api-key` / `password` / 客人 email / phone 在 logger 层已 redact。
- **仓库里没有任何 ESLint / Prettier / Biome 配置。** 唯一的 lint 脚本是 `apps/web` 的 `next lint`，而 `next.config.ts` 里 `eslint.ignoreDuringBuilds: true`（TS 错误仍然会让 `next build` 失败，`typescript.ignoreBuildErrors: false`）。格式跟随周边代码即可。
- 注释和文档在本仓库里用中文，跟随上下文语言；标识符与日志 key 用英文。模块文件头常有解释「为什么」的注释，常引用 `SPEC §x.y`。

## 当前边界

单币种下单；支付通道是 mock（`stripe` 通道已按 REST 形态实现但未接真实商户）；无会员/分销/发票/报表；前台是 SSR + 少量客户端交互；Agoda 凭证需商务审批后下发，在此之前系统跑在高保真 mock 上。
