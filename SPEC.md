# SPEC — OTA 酒店销售系统（Agoda 库存分销）

> 本文件是**合同**。任何代码改动若偏离本文件，必须先改本文件。
> 状态：v0.2（MVP 全链路 + 验收加固）｜最后更新：2026-10-21

---

## 1. 目标与范围

我们是一家面向 C 端客户的 OTA。自有酒店库存不足以覆盖目的地与价格带，因此接入 **Agoda Demand API** 作为供应商，在自有前台完成「搜酒店 → 看房型报价 → 下单 → 支付 → 确认 → 退房/退订」的完整闭环。

### 1.1 本期交付（MVP）

| # | 能力 | 说明 |
|---|------|------|
| M1 | 酒店静态资源同步 | 从 Agoda 拉取酒店档案、房型、设施、图片、地址、星级，落库并可增量刷新 |
| M2 | 库存与价格 | 按目的地 + 入住/离店日期 + 房数 + 人数查询可售房型与报价（含税、取消政策、早餐、即时确认） |
| M3 | 下单与支付 | 我方收款（Partner Fulfillment），支付成功后向 Agoda 下单 |
| M4 | 预订确认 | 处理 Agoda `processing` 状态，轮询至确认，**未确认绝不告知客户已订到** |
| M5 | 退房 / 退订 | 按取消政策计算罚金，发起 Agoda 取消与本地退款，幂等 |
| M6 | 可靠性 | 幂等、重试、熔断、限流、outbox、多通道通知、失败自动上报 |
| M7 | C 端前台 | 搜索 → 酒店详情 → 选房 → 结算 → 支付 → 订单状态页 |

### 1.2 明确不在本期范围

会员体系、分销/代理、运营后台完整报表、供应商比价、发票税务、多币种结算对账、Agoda 供给侧（Supply/ARI）推送。

### 1.3 履约与收款模型

**Partner Fulfillment** —— 客户的钱由我们收，Agoda 是我们的供应商。

```
客户 ──付款──> 我们 ──下单──> Agoda ──确认──> 我们 ──通知──> 客户
  ▲                              │
  └──── 取消时按政策退款 ◀───────┘
```

推论（写进代码的硬约束）：
- 支付成功但下单失败 → **必须自动发起全额退款**，不允许静默吞单。
- 客人在未确认状态下收到「预订成功」= 线上事故（Agoda 官方流程图专门防这个）。
- 罚金由取消政策决定，退款金额 = 实付 − 罚金，罚金部分不开票/不退款。

---

## 2. 架构

```
┌─────────────────────────────────────────────────────────────┐
│  apps/web  (Next.js)  C 端前台                                │
│  搜索 / 酒店详情 / 选房 / 结算 / 支付 / 订单状态               │
└───────────────────────────┬─────────────────────────────────┘
                            │ REST / JSON
┌───────────────────────────▼─────────────────────────────────┐
│  apps/api  (Fastify)                                       │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐              │
│  │ catalog    │ │ search     │ │ booking    │              │
│  │ 静态资源    │ │ 库存/价格  │ │ 订单/支付  │              │
│  └────────────┘ └────────────┘ │ 取消/退款  │              │
│  ┌────────────┐ ┌────────────┐ └────────────┘              │
│  │ notify     │ │ outbox     │                              │
│  │ 多通道通知  │ │ 事件/重报   │                              │
│  └────────────┘ └────────────┘                              │
│         ↕ Prisma (PostgreSQL)  ↕ Redis (缓存/锁/限流)         │
└───────────────────────────┬─────────────────────────────────┘
                            │ SupplierAdapter 接口
┌───────────────────────────▼─────────────────────────────────┐
│  packages/agoda-connectivity                                │
│  live: Agoda Demand API (HTTPS + XML)                       │
│  mock: 高保真模拟器（价格漂移/售罄/processing/429/重复拒单）   │
└─────────────────────────────────────────────────────────────┘
```

`packages/core`：金额（整数最小单位）、日期（YYYY-MM-DD）、错误分类、状态机、重试/熔断、StayContext 指纹。**全仓唯一真源**，任何包不得重复定义。

### 2.1 分层依赖（单向，不得反向）

```
web → api → agoda-connectivity → core
```

`core` 不依赖任何业务包；`agoda-connectivity` 不依赖 `api`；`api` 不依赖 `web`。

---

## 3. 领域模型

### 3.1 金额

- 全部以 **整数最小单位** 存储与运算（分/元/铢/日元）。
- 币种用 ISO 4217 三字母码；JPY/KRW/VND/IDR 为零小数币种。
- 禁止 float 参与金额计算；跨币种不做隐式换算（本期单币种下单）。

### 3.2 入住日期

- 一律用 `LocalDate`（`YYYY-MM-DD` 字符串），**不是时间戳**。
- `nights = 离店日 − 入住日`；入住日当天算第 1 晚，不含离店当天。
- 算术一律 UTC，规避夏令时与时区漂移。
- 房晚分段：`[入住日, 离店日)`。

### 3.3 StayContext（参数一致性的载体）

```ts
interface StayContext {
  supplierHotelId, checkIn, checkOut, rooms, adults, childAges[],
  currency, nationality
}
```

`fingerprintStayContext(ctx)` = SHA-256 稳定序列化。订单上存 `contextFingerprint`。
Search / Precheck / Book 三次调用必须携带同一指纹；指纹不一致 → 拒绝下单（`VALIDATION_ERROR`）。

### 3.4 状态机

```
PENDING_PAYMENT ──付款成功──> PAID ──发起下单──> BOOKING_SUBMITTED
      │                          │                        │
      │支付失败                    │下单失败                 │确认
      ▼                          ▼                        ▼
    FAILED               FAILED(→自动全额退款)      CONFIRMED
      │                                                   │
      │超时                                                 ├─> CHECKED_IN ─> CHECKED_OUT
      ▼                                                   └─> REFUND_PENDING ─> REFUNDED
   EXPIRED                                                       │
                                                       (取消政策判定不可退)
                                                                ▼
                                                            CANCELLED
```

规则：
- 状态迁移集中定义在 `packages/core/src/states.ts`，非法迁移直接抛错，不允许「随便改个状态」。
- **每一次状态写入都必须经过状态机**：`assertBookingTransition(from, to)` 先断言迁移合法，
  再用带当前状态条件的 UPDATE 执行（`where: { id, status: from }`）。
  条件更新让两个并发写者（轮询器与运营请求）无法同时把同一订单往前推；
  条件不匹配即视为状态已变化，拒绝写入。
- `CONFIRMED` 是唯一可以对外宣称「已订到」的状态。
- `PROCESSING` 不是订单状态，是**供应商侧状态**，体现在 `Booking.supplierStatus` 上；订单停留在 `BOOKING_SUBMITTED` 直到拿到确认号。
- 未支付订单被取消时直接进入 `CANCELLED`（无房可退、无款可退），不进入 `REFUND_PENDING`。

### 3.5 取消政策

| 类型 | 含义 | 退款 |
|------|------|------|
| `FULL_REFUND` | 离店前可免费取消（截止日 `freeCancellationUntil`） | 全额 |
| `PARTIAL_REFUND` | 取消扣固定金额或百分比 | 实付 − 罚金 |
| `NON_REFUNDABLE` | 不可退 | 0 |

判定输入：当前时间 vs `freeCancellationUntil`（**物业当地时区**）、供应商罚金、政策类型。

- 物业时区来自供应商档案（`SupplierAddress.timeZone`，落库为 `Hotel.timeZone`），判定「今天」用
  `localDateInZone(now, hotel.timeZone)`，**不是 UTC**。曼谷当地时间已是次日时，
  用 UTC 判定会有一整天的时间窗错误地拒绝免费取消。
- 物业时区缺失时回退 `UTC`，并按 UTC 判定（不猜）。

---

## 4. Agoda 对接规范

### 4.1 方向

**Demand**。我们拉 Agoda 的库存并再销售。
Supply/ARI 方向（`supplyota.agoda.com`、`OTA_HotelAvailNotifRQ`、`OTA_HotelRatePlanNotifRQ`）**不在本期范围**。

### 4.2 三段式调用链

```
Search  ──►  Precheck  ──►  Book
（找酒店）   （验价验房）    （下单）
```

**硬规则：三次调用的日期、房数、占住、币种、国籍必须完全一致。**
Agoda 会因参数漂移（parameter drift）直接拒单。我们的实现方式：
1. 生成 `StayContext` → 算指纹；
2. Search/Precheck/Book 全程携带同一指纹；
3. 下单前校验指纹一致，不一致直接拒绝并记录审计日志。

**报价行的选择规则**：同一 `offerId` 可能存在多行（供应商重新发布同一 offer）。
下单时取 `createdAt` 最新的一行——旧行反映的是旧价格，用它下单会被供应商判为价格变化。

### 4.3 超时（禁止统一成一个值）

| 端点 | 默认超时 |
|------|----------|
| content / search / detail / cancel | 30s |
| **precheck** | **60s** |
| **booking** | **120s** |

（依据 Agoda 官方建议：普通调用 30s、Precheck 60s、Booking 120s。）

### 4.4 processing 标志 —— 最高优先级正确性要求

Agoda 下单返回 `processing: true` 表示**仍在锁占房量，尚未确认**。

- `processing: false` + 确认号 → 订单转 `CONFIRMED`。
- `processing: true` → 订单停留 `BOOKING_SUBMITTED`，**每 15s 轮询 Booking Detail，最长 30 分钟**，直到 `BookingConfirmed` / `BookingCharged`。
- 轮询期间客户侧展示「确认中」，**不得**展示「预订成功」。
- 30 分钟仍未确认 → 订单转 `FAILED` 并自动全额退款 + 告警上报。

### 4.5 错误语义

| 场景 | 错误码 | 可重试 | 业务动作 |
|------|--------|--------|----------|
| 超时 | `SUPPLIER_TIMEOUT` | 是 | 指数退避重试（读接口）；下单接口不自动重试 |
| 触发限流 | `SUPPLIER_RATE_LIMITED` | 是 | 退避重试 + 客户端限流器 |
| 5xx / 上游错误 | `SUPPLIER_ERROR` | 是 | 同上 |
| 鉴权失败 | `SUPPLIER_AUTH_ERROR` | 否 | 告警，人工介入 |
| 房量售罄 | `ROOM_UNAVAILABLE` | 否 | 自动重新报价，若价格不变自动重订一次；价格变了转人工/告知客户 |
| 价格变化 | `PRICE_CHANGED` | 否 | 重新报价，差额 > 0 时**必须**客户确认后才继续 |
| 重复单校验 | `DUPLICATE_BOOKING` | 否 | 拒绝并提示（我们固定传 `allowDuplication: true`，但上游仍可能判定重复） |
| 上游拒绝 | `BOOKING_REJECTED` | 否 | 失败 + 自动退款 |

### 4.5.1 涨价确认在服务端强制（不可只靠前端）

「客户确认新价格」必须是**服务端**的硬约束，不能只是前端的一个弹窗：

1. 报价行有两个价格列：
   - `quotedTotalAmount`——客户**最后一次看到**的价格（基准线）。只有一次新的库存查询会刷新它。
   - `pendingTotalAmount`——供应商在客户选定房型**之后**又涨价时写入，等待客户确认。
2. Precheck 把供应商当前价与基准线比较：变大 → `priceChanged: true` 且写入 `pendingTotalAmount`；
   变小 → 价格对客户更有利，不需要确认（`pendingTotalAmount` 置空）。
3. 创建订单时，若 `pendingTotalAmount` 非空，请求必须带 `acceptedTotal`（整数最小单位）且与服务端期望值**完全相等**；
   否则返回 `409 PRICE_CHANGED`，`details.expected` 给出客户必须接受的金额，`details.actual` 回显客户端带来的值。
4. 订单落库时记录 `Booking.acceptedTotalAmount`，作为「客户同意了这个价」的审计痕迹。

### 4.6 幂等与重复下单

- **传输层禁止对 `book()` 自动重试**。盲重试会重复下单。
- 业务层重试必须带同一 `idempotencyKey`，且先查本地订单状态。
- 传给供应商的 `allowDuplication` 固定为 `true`（否则同姓名+同酒店+日期重叠会被判重拒单）。

### 4.7 限流

- 上游 429 → `SUPPLIER_RATE_LIMITED`。
- 客户端自带限流器（RPM + 突发），阈值从环境变量读，**上线前以 Agoda onboarding 给的阈值为准**。
- 内容类接口不得高频轮询（官方明确点名这是常见失败原因）。

### 4.8 内容同步

- 静态内容按 `contentHash` 增量：哈希未变不写库。
- 内容漂移是真实故障源（描述/房型/图片/设施在 Agoda 侧独立更新），同步任务需周期性跑。
- 同步频率与限流预算挂钩，不做高频全量。

### 4.9 字段映射（摘要）

| 供应商概念 | 我们的字段 | 位置 |
|-----------|-----------|------|
| 酒店 ID | `Hotel.supplierHotelId` | `Hotel` |
| 物业时区 | `Hotel.timeZone` | `Hotel` |
| 房型 | `RoomType.supplierRoomTypeId` | `RoomType` |
| 价计划 | `RatePlan.supplierRatePlanId` | `RatePlan` |
| 单次报价令牌 | `AvailabilityQuote.offerId` | `AvailabilityQuote` |
| 确认号 | `Booking.confirmationNumber` | `Booking` |
| 供应商订单号 | `Booking.supplierBookingId` | `Booking` |

XML 元素名集中在 `packages/agoda-connectivity/src/xml/schema.ts`：**onboarding 拿到 welcome package 后，只改这一个文件。**

---

## 5. 对外 API 契约

统一前缀 `/api/v1`。错误统一形如：

```json
{ "error": { "code": "ROOM_UNAVAILABLE", "message": "...", "retryable": false, "details": {} } }
```

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/v1/hotels/search` | 目的地+日期+占住 → 酒店列表（含最低价） |
| GET | `/api/v1/hotels/:id` | 酒店详情（静态内容） |
| GET | `/api/v1/hotels/:id/availability` | 房型级库存与报价 |
| POST | `/api/v1/quotes/precheck` | 验价验房（返回最新报价 + 是否价格变动） |
| POST | `/api/v1/bookings` | 创建订单（幂等键必填） |
| POST | `/api/v1/bookings/:orderNo/pay` | 发起支付（幂等键必填） |
| GET | `/api/v1/bookings/:orderNo` | 订单详情与状态 |
| POST | `/api/v1/bookings/:orderNo/cancel` | 取消（按政策算罚金 + 退款） |
| POST | `/api/v1/payments/webhook` | 支付/退款异步回调 |
| POST | `/api/v1/webhooks/agoda` | 供应商侧回调（如后续开通） |
| POST | `/api/v1/admin/sync/hotels` | 手动触发内容同步 |
| GET | `/api/v1/admin/bookings` | 订单列表（运营） |

幂等：所有 `POST` 接受 `Idempotency-Key` 头；重放返回首次结果（状态码与 body 一致）。
- **创建订单 / 支付 / 取消**：`Idempotency-Key` 必填。同 key + 同 body 重放首次结果；
  同 key + **不同** body 返回 `409 IDEMPOTENCY_CONFLICT`（即使订单已经付过款也一样——
  否则客户端无法区分「已经付过了」和「这次请求内容不对」）。
- **Precheck**：可选。带 key 则同 key + 同 body 重放首次响应（避免重复打供应商）；
  不带则每次都重新验价。

---

## 6. 可靠性设计

### 6.1 分层防护

| 层 | 手段 |
|----|------|
| 传输层 | 超时分端点、退避+抖动重试、熔断、客户端限流 |
| 业务层 | 幂等键、状态机约束、outbox 事务消息 |
| 通知层 | 每通道独立重试队列 + 失败自动升级上报 |
| 数据层 | 唯一约束（offerId / idempotencyKey / supplierBookingId）、事务写库 |

### 6.2 Outbox + 多通道通知

- 领域事件与状态变更**同事务**写入 `OutboxEvent`（SPEC §6.2 的硬要求，不允许「先改状态再补事件」：
  两者之间一旦崩溃，客户通知就永久丢失，且没有对账路径）。
  实现上，订单状态的每一次变更都在一个 `$transaction` 里完成「改状态 + 写 BookingEvent + 写 OutboxEvent」。
- 事件的唯一键冲突（重复写）不视为错误：事件写入不得回滚业务事务。
- 投递器异步消费，每个通道（email / sms / webhook）**独立**投递、独立重试，互不阻塞。
- 某通道连续失败达阈值 → 标记 `escalatedAt` 并**自动上报到运营通道**（ops webhook / 日志告警）。
- 幂等：`dedupeKey` 唯一，重复投递不产生重复消息。

### 6.3 自动重报（auto re-report）

以下情况必须自动产生一条**运营可见**的记录（`OutboxEvent` + `AuditLog`），而不是只打日志：
- 供应商调用连续失败 ≥ 阈值；
- 通知通道重试耗尽；
- 订单 30 分钟未确认；
- 支付成功但下单失败 → 自动退款。

`AuditLog` 与对应的 `OutboxEvent` **同事务**写入：两者要么都成立，要么都不成立——
一份「状态是失败」但「运营记录缺失」的订单是最难排查的组合。
落库位置：`apps/api/src/modules/booking/service.ts` 的 `reportToOps()`。

### 6.4 库存竞争

Search 看到 ≠ 能订到。必须：
1. 下单前 Precheck；
2. Precheck 失败（售罄）→ 自动重新报价（同一房型/价计划，仅一次）；
3. 重新报价价格未变 → 自动重订一次；价格变了 → 失败并自动全额退款（不静默改价）。

### 6.5 供应商重试预算

- 下单尝试次数记在 `Booking.supplierAttempts`，上限 **5 次**。
- 每次重试使用**同一个** `supplierIdempotencyKey`，保证供应商侧是重放而不是新单。
- 瞬时故障（超时/429/5xx）→ 订单退回 `PAID`，由轮询器重放，**不退款**。
- 不可重试故障（拒单/重复单/价格变化）→ 订单失败并**自动全额退款**。
- `BOOKING_SUBMITTED` 超过 30 分钟仍未确认 → 判定超时，失败 + 自动全额退款。

---

## 7. 支付与退款

- 供应商：`PaymentProvider` 接口，MVP 内置 `mock`（可模拟成功/失败/超时/异步回调），预留 `stripe`。
- 状态：`PENDING → CAPTURED | FAILED`；退款 `PENDING → SUCCEEDED | FAILED`。
- 退款金额 = 实付 − 罚金。退款是**独立记录**，带幂等键，重放不重复退。
- 支付成功但下单失败 → 自动创建退款记录并投递，不依赖人工。

---

## 8. 验收标准（MVP 完成定义）

1. `pnpm install && pnpm build && pnpm db:setup && pnpm dev` 一键起全栈。
2. 静态资源同步能把 mock 目录里的酒店落库，且二次同步不产生重复（幂等）。
3. 搜索返回按日期/占住计算的价格，且同条件两次调用价格一致（mock 默认无漂移）。
4. Precheck 能检出价格漂移并标记 `priceChanged`。
5. 下单返回 `processing: true` 时订单**不是** `CONFIRMED`，轮询后才变 `CONFIRMED`。
6. 支付成功 + 下单失败 → 自动生成全额退款记录。
7. 取消按政策返回正确罚金，重复取消不重复退。
8. 通知在某一通道故障时，其他通道仍然送达，故障通道重试耗尽后自动上报。
9. 所有 `POST` 幂等：同 key 重复请求只产生一个订单/一笔支付/一笔退款；同 key 不同 body 返回 409。
10. 契约测试与集成测试全绿；`tsc --noEmit` 零错误。
11. 涨价必须客户确认，且**由服务端强制**：未带 `acceptedTotal` 时下单返回 `409 PRICE_CHANGED`，
    带对金额才放行，订单记录 `acceptedTotalAmount`。
12. 状态机不可绕过：终态订单（`REFUNDED` / `CANCELLED` / `EXPIRED`）不会被迟到的供应商确认改回 `CONFIRMED`；
    领域事件与状态变更落在同一个事务里。

---

## 9. 术语

| 术语 | 含义 |
|------|------|
| Demand API | 我们拉 Agoda 库存的接口方向 |
| Precheck | 下单前的验价验房 |
| processing | 供应商尚未确认，只锁了房量 |
| offerId | 一次具体报价的令牌（房型+价计划+日期+占住） |
| StayContext | 三段式调用必须保持一致的参数集合 |
| outbox | 与业务同事务写入的待投递事件表 |
| idempotency key | 客户端生成的幂等键 |

---

## 10. 变更记录

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-10-20 | v0.1 | 初版：MVP 全链路范围、Agoda 三段式契约、状态机、可靠性方案 |
| 2026-10-20 | v0.1.1 | 落地细节对齐：报价行取最新、供应商重试预算（≤5 次，同幂等键）、瞬时故障不退款 |
| 2026-10-21 | v0.2 | 独立验收后的加固：<br>① 状态机强制落地（每次状态写入都断言 + 带当前状态条件的 UPDATE）；<br>② 取消/支付的幂等键真正生效（同 key 同 body 重放首次结果，同 key 异 body 409）；<br>③ 领域事件与状态变更同事务写入 OutboxEvent；<br>④ 自动重报补 `AuditLog`（与 OutboxEvent 同事务）；<br>⑤ 取消截止按**物业当地时区**判定（新增 `Hotel.timeZone`）；<br>⑥ 涨价确认下沉到服务端（`acceptedTotal` + 409 `PRICE_CHANGED`）；<br>⑦ 支付响应回到契约形状 `{orderNo,status,payment,booking}`；<br>⑧ 零小数币种的 `major` 修正（走 `toDTO`，不再硬编码 /100）；<br>⑨ 生产环境拒绝使用开发默认密钥启动 |
