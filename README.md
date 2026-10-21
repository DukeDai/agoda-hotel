# OTA 酒店销售系统（Agoda 库存分销）

面向 C 端客户的 OTA，从 **0 到 1** 打通「酒店静态资源 → 房间库存与价格 → 下单 → 支付 → 预订确认 → 退房/退订」全链路，供应商为 **Agoda Demand API**。

```
客户 ──付款──> 我们 ──下单──> Agoda ──确认──> 我们 ──通知──> 客户
  ▲                              │
  └──── 取消时按政策退款 ◀───────┘
```

> 本仓库的**合同**是 [`SPEC.md`](./SPEC.md)。改代码若偏离规格，必须先改规格。
> 接口细节见 [`docs/api-contract.md`](./docs/api-contract.md)。

---

## 1. 能力现状

| 能力 | 状态 | 落点 |
|------|------|------|
| 酒店静态资源同步（档案/房型/设施/图片/政策/时区），按 contentHash 增量幂等 | ✅ | `apps/api/src/modules/catalog` |
| 目的地+日期+占住 搜酒店、房型级库存与报价（含税/取消政策/早餐） | ✅ | `apps/api/src/modules/search` |
| 下单前验价（Precheck），能检出价格漂移 | ✅ | `apps/api/src/modules/search` |
| 涨价必须客户确认，**服务端强制**（不带 `acceptedTotal` 直接 409） | ✅ | `apps/api/src/modules/booking` |
| 创建订单、支付、幂等（全链路 `Idempotency-Key`，同 key 异 body 409） | ✅ | `apps/api/src/modules/booking` `.../payment` |
| 订单状态机强制落地（每次状态写入都断言 + 条件更新） | ✅ | `packages/core/src/states.ts` `.../booking/service.ts` |
| `processing` 状态处理：未确认绝不报成功，轮询至确认 | ✅ | `apps/api/src/modules/booking` |
| 支付成功但下单失败 → **自动全额退款** + 运营可见的审计记录 | ✅ | `apps/api/src/modules/booking` |
| 取消：按政策算罚金、释放房量、退款，退款幂等，截止按**物业当地时区** | ✅ | `apps/api/src/modules/booking` |
| 多通道通知（email/sms/webhook）+ 失败自动上报 | ✅ | `apps/api/src/modules/notify` |
| C 端前台（搜索→选房→结算→支付→订单状态） | ✅ | `apps/web` |
| Agoda 真实 XML 契约层（上线前换环境变量即可） | ✅ | `packages/agoda-connectivity/src/live` |
| 高保真 Mock（价格漂移/售罄/processing/429/重复拒单/超时） | ✅ | `packages/agoda-connectivity/src/mock` |

---

## 2. 快速开始

前置：Node ≥ 20、pnpm ≥ 10、PostgreSQL ≥ 14（Redis 可选，缺失时自动降级为进程内缓存）。

```bash
# 1. 安装依赖
pnpm install

# 2. 准备环境变量
cp .env.example .env
#   按本机情况改 DATABASE_URL，例如：
#   DATABASE_URL=postgresql://<user>@localhost:5432/ota_hotel?schema=public

# 3. 建库 + 灌静态资源（从 mock 供应商拉取 12 家酒店）
createdb ota_hotel
pnpm --filter @ota/api exec prisma db push --skip-generate
pnpm --filter @ota/api db:seed

# 4. 起服务
pnpm --filter @ota/api dev      # API  → http://localhost:3001  (文档 /docs)
pnpm --filter @ota/web dev      # 前台 → http://localhost:3000
```

打开 <http://localhost:3000>，搜「Phuket」，选房 → 下单 → 支付 → 看订单状态从「供应商确认中」变成「预订成功」。

---

## 3. 常用命令

| 命令 | 作用 |
|------|------|
| `pnpm install` | 安装（离线可用） |
| `pnpm build` | 全量构建：core / connectivity / api（tsc）+ web（next build） |
| `pnpm dev` | 并行起 API(:3001) 与前台(:3000) |
| `pnpm test` | 跑全仓测试（core 160 + 适配器 61 + API 86） |
| `pnpm --filter @ota/api db:setup` | generate + db push + seed |
| `pnpm --filter @ota/api db:reset` | 重建库并重新灌种子 |
| `pnpm --filter @ota/api dev` | 单独启动 API（tsx watch） |
| `pnpm --filter @ota/web dev` | 单独启动前台 |
| `pnpm --filter @ota/api test` | API 测试（需本地 PostgreSQL） |
| `pnpm --filter @ota/core test` | 领域内核单元测试（纯离线） |
| `pnpm --filter @ota/agoda-connectivity test` | 适配器契约测试（纯离线） |
| `pnpm -r typecheck` | 全仓类型检查 |
| `node scripts/smoke.mjs` | 对运行中的 API 发真实 HTTP 的端到端冒烟（16 步） |

---

## 4. 目录结构

```
packages/core                 领域内核：金额/日期/错误/状态机/重试熔断/StayContext 指纹
  └─ test/                    160 个内核单元测试（金额/日期/状态机/指纹/重试）
packages/agoda-connectivity   供应商适配器
  ├─ src/contract.ts          唯一的供应商契约（业务层只认这一套 DTO）
  ├─ src/live/                真实 Agoda Demand API（HTTPS + XML）
  ├─ src/xml/schema.ts        ★ 所有 XML 元素名集中在此，onboarding 后只改这里
  └─ src/mock/                高保真模拟器（含 12 家酒店目录与定价引擎）
apps/api                      Fastify 后端
  ├─ src/modules/catalog      静态资源同步
  ├─ src/modules/search       搜索 / 库存 / 报价 / precheck
  ├─ src/modules/booking      订单 / 支付编排 / 取消 / 确认轮询
  ├─ src/modules/payment      支付通道端口 + mock / stripe 实现
  ├─ src/modules/notify       outbox 投递 + 多通道 + 失败升级上报
  ├─ src/modules/admin        运营接口
  ├─ prisma/schema.prisma     数据模型（金额一律 Int 最小单位）
  └─ test/                    86 个集成测试（含 booking-contract.test.ts 契约钉子）
apps/web                      Next.js 15 C 端前台
docs/api-contract.md          对外 API 契约（前后端共同遵守）
docs/acceptance.md            SPEC §8 逐条验收对照 + 证据
scripts/smoke.mjs             对运行中的 API 发真实 HTTP 的端到端冒烟
```

---

## 5. Agoda 对接要点（必读）

这些是**真实踩坑点**，代码里都按此实现：

1. **方向**：我们拉 Agoda 库存再销售 → 用 **Demand API**。Supply/ARI（我们推库存给 Agoda）不在范围内。
2. **三段式**：Search → Precheck → Book，三段的日期/房数/占住/币种/国籍必须**完全一致**。
   实现方式：`StayContext` 算 SHA-256 指纹，三次调用携带同一指纹，订单落库存档，指纹不符直接拒单。
3. **超时分端点**：普通 30s、**Precheck 60s、Book 120s**。不要合成一个值。
4. **`processing` 标志**：`processing: true` 表示只锁了房量、**尚未确认**。
   订单停在 `BOOKING_SUBMITTED`，每 15s 轮询 Booking Detail，**最长 30 分钟**；
   未确认前对客户只能说「确认中」。这条是整套系统正确性的核心。
5. **盲重试会重复下单**：传输层**禁止**自动重试 `book()`；业务层用同一 idempotency key 驱动重放。
6. **限流**：超配额返回 **429**；客户端自带限流器；内容接口不得高频轮询。
7. **重复单校验**：同姓名+同酒店+日期重叠会被上游判重拒单。我们固定传 `allowDuplication: true`，但仍需处理该错误。
8. **价格漂移**：搜索价不等于可订价，必须 Precheck；漂移时须让客户确认新价，不能静默改价。
9. **售罄竞争**：Search 看到 ≠ 能订到。售罄后自动重新报价一次；价格未变才自动重订。

**上线前必做**：拿到 Agoda welcome package 后，核对并修正 `packages/agoda-connectivity/src/xml/schema.ts` 里的元素名与端点路径（该文件是刻意集中的唯一映射点），并用 onboarding 下发的限流阈值替换 `.env` 中的默认值。

---

## 6. 可靠性设计

| 关注点 | 手段 |
|--------|------|
| 幂等 | 创建/支付/取消走 `Idempotency-Key`；同 key 同 body 重放首次响应；同 key 不同 body 报 409 |
| 重复下单 | 业务层状态机（断言 + 条件更新）+ 供应商幂等键 + 禁止传输层重试 `book()` |
| 资金安全 | 支付成功但下单失败 → 自动创建退款记录并投递（独立幂等记录） |
| 消息不丢 | 领域事件与状态变更**同事务**写 outbox（Postgres 事务 ID 探针验证），后台异步投递 |
| 运营可见 | 供应商降级 / 订单失败 / 30 分钟未确认 / 自动退款 → `OutboxEvent` + `AuditLog` 同事务 |
| 通道独立 | email/sms/webhook 各自独立重试互不阻塞；耗尽后自动升级上报运营通道 |
| 供应商不稳 | 分端点超时、指数退避、熔断、429 限流器、参数指纹防漂移 |
| 自愈 | 进程崩溃后，已付款未下单的订单由轮询器自动补单；待处理退款自动重试 |
| 钱算得对 | 金额一律整数最小单位；零小数币种（JPY/KRW/VND/IDR）的 `major` 走 `toDTO`，不硬编码 /100 |

---

## 7. 测试

```bash
pnpm --filter @ota/core test                # 160 个领域内核单元测试，完全离线
pnpm --filter @ota/agoda-connectivity test   # 61 个契约测试，完全离线
pnpm --filter @ota/api test                  # 86 个集成测试，跑在真实 PostgreSQL 上
```

API 测试会自建 `ota_hotel_test` 库并重置 schema，覆盖：
静态资源同步幂等、搜索与报价、Precheck 价格漂移、下单幂等与冲突、
**processing 未确认不得报成功**、轮询后确认、取消与退款金额、重复取消不重复退、
支付失败不落单、供应商拒单自动全额退款、瞬时故障重试不退款。

`test/booking-contract.test.ts` 专门钉住最容易悄悄坏掉的契约：
取消幂等重放、支付同 key 异 body 409、支付响应形状、**终态订单不被迟到确认复活**、
涨价必须确认、失败必有审计记录、**事件与状态变更同事务**（用 Postgres 事务 ID 探针验证，
把事件挪出事务该用例会立刻变红）、取消截止按物业时区判定。

---

## 8. 当前边界

- 单币种下单（不做跨币种换算与结算对账）。
- 支付通道为 mock；`stripe` 通道已按 REST 形态实现但未接真实商户。
- 未做会员/分销/发票/运营报表。
- 前台为服务端渲染 + 少量客户端交互，未做移动端原生。
- Agoda 凭证需商务审批后下发；在拿到凭证前，系统跑在高保真 mock 上。

---

## 9. 环境变量

见 [`.env.example`](./.env.example)。关键项：

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | PostgreSQL 连接串（必填） |
| `REDIS_URL` | 留空则用进程内缓存/锁（仅限单机开发） |
| `AGODA_MODE` | `mock`（默认，无凭证可跑） / `live` |
| `AGODA_API_KEY` / `AGODA_USERNAME` / `AGODA_PASSWORD` | live 模式必填 |
| `AGODA_TIMEOUT_*_SECONDS` | 分端点超时，默认 30/30/60/120 |
| `AGODA_RATE_LIMIT_RPM` / `_BURST` | 客户端限流，onboarding 后按官方阈值改 |
| `AGODA_MOCK_PRICE_DRIFT_RATE` | 仅 mock 模式：供应商在 precheck 时改价的概率（0~1）。设成 1 可以在跑着的系统上演示「涨价 → 客户确认」链路 |
| `PAYMENT_PROVIDER` | `mock`（默认） / `stripe` |
| `PAYMENT_WEBHOOK_SECRET` | 支付回调验签密钥；**生产环境必须改**，否则拒绝启动 |
| `OPS_ALERT_WEBHOOK_SECRET` | 运营告警签名密钥；**生产环境必须改**，否则拒绝启动 |
| `NOTIFY_CHANNELS` | 逗号分隔，默认 `email,sms,webhook` |
| `NOTIFY_ESCALATION_THRESHOLD` | 连续失败多少次后自动升级上报 |
| `BOOKING_POLL_MAX_MINUTES` | 供应商确认轮询上限，默认 30 分钟 |
