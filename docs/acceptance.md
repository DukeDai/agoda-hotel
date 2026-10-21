# 验收对照表

`SPEC.md` §8 的 12 条 MVP 完成定义，逐条对应到可复现的证据。

验证环境：Node 24 / pnpm 11 / 本机 PostgreSQL 15，`AGODA_MODE=mock`（高保真模拟器，无需 Agoda 凭证与外网）。

> v0.2 记录：一轮独立验收（verifier）发现 5 个 MAJOR / 7 个 MINOR / 3 个 NIT，已全部修复并补上回归测试。
> 下表的第 9 条在修复前是 ❌（取消接口忽略 `Idempotency-Key`），现为 ✅。

---

| # | 验收标准 | 结论 | 证据 |
|---|---------|------|------|
| 1 | `pnpm install && pnpm build && pnpm db:setup && pnpm dev` 一键起全栈 | ✅ | 见 README §2；`prisma db push` + `tsx prisma/seed.ts` 拉取 12 家酒店入库；API `:3001`、前台 `:3000` 均已实跑 |
| 2 | 静态资源同步幂等，二次同步不产生重复 | ✅ | `apps/api/test/e2e.test.ts` → "M1: syncs the supplier catalog and is idempotent on re-run"：第二次 `created === 0` 且 `skipped > 0`，酒店总数不变 |
| 3 | 搜索返回按日期/占住计算的价格，同条件两次一致 | ✅ | e2e "M2: searches hotels…"（默认 `priceDriftRate=0` 报价稳定）+ 冒烟脚本第 4 步 |
| 4 | Precheck 能检出价格漂移 | ✅ | `apps/api/test/search.test.ts` 18 例含漂移用例；mock 侧 `decideDrift(offerId, fingerprint, rate)` 可注入漂移，`priceChanged` 由线上 XML 的 `OriginalTotal` 推导 |
| 5 | 下单返回 `processing: true` 时订单**不是** `CONFIRMED`，轮询后才变 | ✅ | e2e "M4: does NOT report the booking as confirmed…"：断言 `status !== 'CONFIRMED'`、`confirmationNumber === null`；"M4: confirms the booking once the supplier settles it" 轮询后拿到确认号。浏览器实操同样看到「供应商确认中」→「预订成功」 |
| 6 | 支付成功 + 下单失败 → 自动生成全额退款 | ✅ | `apps/api/test/booking-recovery.test.ts` → "refunds the customer in full when the supplier rejects the booking after payment"：注入 `rejected` 后订单失败、生成金额等于实付的 `SUCCEEDED` 退款记录 |
| 7 | 取消按政策返回正确罚金，重复取消不重复退 | ✅ | e2e "M5: cancels…"（罚金 0、退款=实付）+ "M5: a second cancellation does not refund twice"（409 `CANCEL_NOT_ALLOWED`，退款记录数不变）；`booking-contract.test.ts` 另验证同 key 重放返回同一结果且退款记录仍为 1 条 |
| 8 | 某通知通道故障时其他通道仍送达，耗尽后自动上报 | ✅ | `apps/api/test/notify.test.ts` 34 例（通道独立重试、退避、升级去重键）；`pump.ts` 升级路径写 `AuditLog` + `notification.escalated` outbox 事件（`dedupeKey=escalated:<deliveryId>`），只投运营通道 |
| 9 | 所有 `POST` 幂等：同 key 只产生一个订单/支付/退款 | ✅ | e2e "M3: creates an order and replays it…"（重放返回同 `orderNo`，库中订单数仍为 1）+ "M3: rejects the same Idempotency-Key with a different payload"（409 `IDEMPOTENCY_CONFLICT`）；`booking-contract.test.ts` 另覆盖**取消**重放与**支付**同 key 异 body 409；冒烟第 9/14 步 |
| 10 | 契约测试与集成测试全绿；`tsc --noEmit` 零错误 | ✅ | core 160/160、适配器 61/61、API 86/86，全仓 `pnpm -r typecheck` 无错误；`next build` 成功 |
| 11 | 涨价必须客户确认，且**由服务端强制** | ✅ | `booking-contract.test.ts` → "refuses to book a price the customer never accepted"：不带 `acceptedTotal` → 409 `PRICE_CHANGED`（`details.expected` = 必须接受的金额）；带对金额 → 下单成功且 `Booking.acceptedTotalAmount` = 该金额。浏览器实操（mock 开启 100% 漂移）原文：「价格已从 ¥3,398.35 变为 ¥3,670.20」→ 客户确认 → 订单按 ¥3,670.20 下单 |
| 12 | 状态机不可绕过；领域事件与状态变更同事务 | ✅ | `booking-contract.test.ts` → "never resurrects a terminal order when a late confirmation arrives"（`REFUNDED` 订单不会被迟到确认改回 `CONFIRMED`，无 `booking.confirmed` 事件）；"commits the notification event in the same transaction as the status change" 用 **Postgres 事务 ID 探针**验证：把事件写回事务外，该用例会立刻变红 |

---

## 额外验证（非 SPEC 必列，但属产品级底线）

| 项 | 证据 |
|----|------|
| 供应商瞬时故障不退款、不丢单 | `booking-recovery.test.ts` → "keeps the money and retries when the supplier fails transiently"：状态退回 `PAID`、无退款记录、产生 `supplier.degraded` 事件，轮询器用同一幂等键补单后确认成功 |
| 失败一定留下运营可见的记录 | `booking-contract.test.ts` → "leaves an operations record when a paid booking fails and is refunded"：`AuditLog` 同时出现 `booking.failed` 与 `booking.auto_refund`（与 OutboxEvent 同事务，SPEC §6.3） |
| 取消截止按**物业当地时区**判定 | `booking-contract.test.ts` → "evaluates the cancellation deadline in the property timezone"：同一时刻（曼谷已是 11 日、UTC 仍是 10 日）、同一截止日，曼谷酒店拒绝取消、UTC 酒店允许取消 |
| 通知真的送达（不是"标绿"） | e2e "M6: actually delivers the customer notification over the email channel"：断言 payload 带 `guestEmail`、投递记录 `status === SENT`、目的地正确 |
| Precheck 幂等键生效 | `booking-contract.test.ts` → "replays a repeated precheck instead of hitting the supplier twice"：同 key 同 body 重放同一响应；同 key 异 body 409 `IDEMPOTENCY_CONFLICT` |
| 通知日志不留明文 PII | `notify/channels.ts` 的 `maskDestination()`：JSONL 日志只写 `z***@example.com` 形式，pino 侧照常脱敏 |
| 内容同步不会拖垮下单链路 | 限流器改为**按端点分桶**（`packages/agoda-connectivity/src/live/rate-limiter.ts` + `test/rate-limiter.test.ts`）：内容同步 13 次调用不会让 booking 通道返回 429 |
| 传输层不盲重试下单 | `live/transport.ts` 对 `book` 置 `retryable:false` → 恰好一次尝试（`live-adapter.test.ts` 断言） |
| 分端点超时 | content/search 30s、precheck 60s、booking 120s（`live/transport.ts` 的 `timeouts` 映射） |
| 零小数币种金额显示正确 | 走 `toDTO()`（按币种小数位换算），不再硬编码 `/100`；`packages/core/test/money.test.ts` 覆盖 JPY/KRW/VND/IDR |
| 生产环境不跑默认密钥 | `config.ts`：`NODE_ENV=production` 且密钥仍是开发默认值时**拒绝启动** |
| 前端与 API 契约一致 | `apps/web/src/lib/api.ts` 逐字段对齐 `docs/api-contract.md`；浏览器实操：搜索 → 列表 → 详情(9 报价) → 结算 → **涨价确认** → 支付 → 订单页 → 取消退款 |
| C 端不会在未确认时看到"预订成功" | 浏览器实操订单页原文：「供应商正在确认房量，确认成功前暂不可视为预订成功」「只有收到供应商确认号后才会变为「预订成功」」 |

## 端到端冒烟

`node scripts/smoke.mjs`（对运行中的 API 发真实 HTTP）16 步全绿：

```
✓  1. API 可用 — supplier=agoda mode=mock
✓  2. 静态资源同步 — total=12 created=0 updated=12 skipped=0
✓  3. 同步幂等（二次不新增） — created=0 skipped=12
✓  4. 搜索酒店 — 2 家，最低 2392.43 CNY
✓  5. 酒店详情（静态资源） — Patong Bayview Resort · 4 个房型 · 4 张图
✓  6. 房型库存与报价 — 9 个可售报价
✓  7. 下单前验价 — priceChanged=false total=2718.67 CNY
✓  8. 创建订单 — orderNo=OTA-20261020-0YCEBA status=PENDING_PAYMENT total=2718.67 CNY
✓  9. 幂等重放（同 key 同 body → 同订单） — orderNo=OTA-20261020-0YCEBA
✓ 10. 支付 — status=BOOKING_SUBMITTED supplierStatus=PROCESSING
✓ 11. 未确认不谎报成功（processing 安全） — status=BOOKING_SUBMITTED confirmation=null
✓ 12. 供应商确认 — confirmationNumber=AGHUTBPE9315
✓ 13. 取消订单 — 罚金=0 CNY 退款=2718.67 CNY status=REFUNDED
✓ 14. 取消幂等重放（同 key 同 body → 同一结果，不重复退款） — HTTP 200 refund=2718.67 CNY
✓ 15. 重复取消被拒（不重复退款） — HTTP 409 CANCEL_NOT_ALLOWED
✓ 16. 退款已记录 — 已退 2718.67 CNY / 实付 2718.67 CNY
```

## 浏览器实操记录（涨价链路，mock 开启 100% 漂移）

搜索 Phuket → 酒店详情（9 个可售报价）→ 选 `Deluxe King Room - Flexible`（¥3,398.35）→ 填入住人 →
点「提交订单」→ 预检检出涨价，弹出：

```
价格已变动
价格已从 ¥3,398.35 变为 ¥3,670.20，请确认新价格后继续下单。
原价格：¥3,398.35      最新应付：¥3,670.20
```

点「我已知悉新价格，继续下单」→ 订单号 `OTA-20261020-W621BW`，落库 `totalAmount=367020 / acceptedTotalAmount=367020`
→ 支付 → 订单页「供应商确认中」→「预订成功」+ 确认号 `AGNLXGBM1449`
→ 取消订单 → 「已退款」，已退款 ¥3,670.20，库中**恰好 1 条**退款记录，6 条领域事件各 1 条。

## 已知边界（未做，不是缺陷）

- 单币种下单，无跨币种换算与供应商结算对账。
- 支付通道为 `mock`；`stripe` 通道已按 REST 形态实现但未接真实商户。
- 无会员 / 分销 / 发票 / 运营报表。
- Redis 未接入时锁与缓存是进程内的，多实例部署需要接 Redis。
- `packages/core` 的 `retry.ts` 在退避期间被 abort 时抛出的是 abort reason（原始错误只保留在 `onRetry` 回调里）——这是调用方主动取消的语义，未改。
- Agoda 的真实 XML 元素名在 `packages/agoda-connectivity/src/xml/schema.ts` 集中管理，**拿到 welcome package 后需逐项核对**。
- 限流阈值以 onboarding 官方下发为准，`.env` 中当前为默认值。
