#!/usr/bin/env node
/**
 * End-to-end smoke test against a RUNNING API.
 *
 * It walks the whole customer journey with real HTTP calls and prints a
 * readable trace, so the result can be pasted into a ticket or a review.
 *
 *   node scripts/smoke.mjs                       # against http://localhost:3001
 *   API_BASE_URL=http://host:3001 node scripts/smoke.mjs
 *
 * Exit code 0 = the whole chain worked.
 */
const BASE = process.env.API_BASE_URL ?? 'http://localhost:3001';

let step = 0;
const failures = [];

function log(ok, label, detail = '') {
  step += 1;
  const mark = ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m';
  console.log(`${mark} ${String(step).padStart(2, ' ')}. ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function uuid() {
  return `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function call(method, path, { body, idempotencyKey } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

function money(value) {
  return value ? `${value.major} ${value.currency}` : 'n/a';
}

function addDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log(`\nOTA 冒烟测试 → ${BASE}\n${'─'.repeat(56)}`);

  const health = await call('GET', '/health');
  if (health.status !== 200) {
    log(false, 'API 可用', `HTTP ${health.status}`);
    process.exit(1);
  }
  log(true, 'API 可用', `supplier=${health.body.supplier} mode=${health.body.supplierMode}`);

  // 1. static content sync
  const sync = await call('POST', '/api/v1/admin/sync/hotels', { body: { limit: 50 } });
  log(sync.status === 200, '静态资源同步', sync.status === 200
    ? `total=${sync.body.total} created=${sync.body.created} updated=${sync.body.updated} skipped=${sync.body.skipped}`
    : `HTTP ${sync.status} ${JSON.stringify(sync.body)}`);

  const sync2 = await call('POST', '/api/v1/admin/sync/hotels', { body: { limit: 50 } });
  log(sync2.status === 200 && sync2.body.created === 0, '同步幂等（二次不新增）',
    `created=${sync2.body?.created} skipped=${sync2.body?.skipped}`);

  // 2. search
  const checkIn = addDays(21);
  const checkOut = addDays(23);
  const q = `destination=Phuket&checkIn=${checkIn}&checkOut=${checkOut}&rooms=1&adults=2&currency=CNY&nationality=CN`;
  const search = await call('GET', `/api/v1/hotels/search?${q}`);
  const hotels = search.body?.hotels ?? [];
  log(search.status === 200 && hotels.length > 0, '搜索酒店', `${hotels.length} 家，最低 ${money(hotels[0]?.lowestStayTotal)}`);
  if (!hotels.length) {
    process.exit(1);
  }
  const hotel = hotels[0];

  // 3. hotel detail
  const detail = await call('GET', `/api/v1/hotels/${hotel.id}`);
  log(detail.status === 200, '酒店详情（静态资源）',
    `${detail.body?.name} · ${detail.body?.roomTypes?.length ?? 0} 个房型 · ${detail.body?.images?.length ?? 0} 张图`);

  // 4. availability
  const avail = await call('GET', `/api/v1/hotels/${hotel.id}/availability?${q}`);
  const quotes = avail.body?.quotes ?? [];
  log(avail.status === 200 && quotes.length > 0, '房型库存与报价', `${quotes.length} 个可售报价`);
  if (!quotes.length) {
    process.exit(1);
  }
  const quote = quotes[0];

  // 5. precheck
  const pre = await call('POST', '/api/v1/quotes/precheck', {
    body: {
      hotelId: hotel.id,
      offerId: quote.offerId,
      checkIn,
      checkOut,
      rooms: 1,
      adults: 2,
      childAges: [],
      currency: 'CNY',
      nationality: 'CN',
    },
  });
  log(pre.status === 200, '下单前验价', `priceChanged=${pre.body?.priceChanged} total=${money(pre.body?.total)}`);

  // 6. create order
  const guest = { firstName: '测试', lastName: '客人', email: 'smoke@example.com', phone: '+8613800000000' };
  const createKey = uuid();
  const createBody = {
    hotelId: hotel.id,
    offerId: quote.offerId,
    checkIn,
    checkOut,
    rooms: 1,
    adults: 2,
    childAges: [],
    currency: 'CNY',
    nationality: 'CN',
    guest,
    specialRequests: ['冒烟测试'],
  };
  const created = await call('POST', '/api/v1/bookings', { body: createBody, idempotencyKey: createKey });
  log(created.status === 201, '创建订单', `orderNo=${created.body?.orderNo} status=${created.body?.status} total=${money(created.body?.price?.total)}`);
  if (created.status !== 201) {
    console.log(JSON.stringify(created.body, null, 2));
    process.exit(1);
  }
  const orderNo = created.body.orderNo;

  const replay = await call('POST', '/api/v1/bookings', { body: createBody, idempotencyKey: createKey });
  log(replay.status === 201 && replay.body?.orderNo === orderNo, '幂等重放（同 key 同 body → 同订单）',
    `orderNo=${replay.body?.orderNo}`);

  // 7. pay
  const paid = await call('POST', `/api/v1/bookings/${orderNo}/pay`, {
    body: { method: 'mock_card' },
    idempotencyKey: uuid(),
  });
  log(paid.status === 200, '支付', `status=${paid.body?.status} supplierStatus=${paid.body?.booking?.supplierStatus}`);
  const paidView = paid.body?.booking ?? paid.body;
  log(paidView?.status !== 'CONFIRMED' || paidView?.confirmationNumber,
    '未确认不谎报成功（processing 安全）', `status=${paidView?.status} confirmation=${paidView?.confirmationNumber ?? 'null'}`);

  // 8. poll until confirmed
  let confirmed = false;
  for (let i = 0; i < 6 && !confirmed; i += 1) {
    await call('POST', '/api/v1/admin/bookings/poll');
    const cur = await call('GET', `/api/v1/bookings/${orderNo}`);
    if (cur.body?.status === 'CONFIRMED') {
      confirmed = true;
      log(true, '供应商确认', `confirmationNumber=${cur.body?.confirmationNumber}`);
    }
  }
  if (!confirmed) log(false, '供应商确认', '轮询 6 次仍未确认');

  // 9. cancel + refund
  const cancelKey = uuid();
  const cancel = await call('POST', `/api/v1/bookings/${orderNo}/cancel`, {
    body: { reason: '冒烟测试结束' },
    idempotencyKey: cancelKey,
  });
  log(cancel.status === 200, '取消订单', cancel.status === 200
    ? `罚金=${money(cancel.body?.cancellation?.penaltyAmount)} 退款=${money(cancel.body?.cancellation?.refundAmount)} status=${cancel.body?.booking?.status}`
    : `HTTP ${cancel.status} ${JSON.stringify(cancel.body)}`);

  // The very same request must be replayed, not refused.
  const cancelReplay = await call('POST', `/api/v1/bookings/${orderNo}/cancel`, {
    body: { reason: '冒烟测试结束' },
    idempotencyKey: cancelKey,
  });
  log(cancelReplay.status === 200
    && cancelReplay.body?.cancellation?.refundAmount?.amount === cancel.body?.cancellation?.refundAmount?.amount,
    '取消幂等重放（同 key 同 body → 同一结果，不重复退款）',
    `HTTP ${cancelReplay.status} refund=${money(cancelReplay.body?.cancellation?.refundAmount)}`);

  const cancel2 = await call('POST', `/api/v1/bookings/${orderNo}/cancel`, {
    body: { reason: '重复取消' },
    idempotencyKey: uuid(),
  });
  log(cancel2.status === 409, '重复取消被拒（不重复退款）', `HTTP ${cancel2.status} ${cancel2.body?.error?.code ?? ''}`);

  const finalOrder = await call('GET', `/api/v1/bookings/${orderNo}`);
  log(finalOrder.body?.price?.refunded?.amount > 0, '退款已记录',
    `已退 ${money(finalOrder.body?.price?.refunded)} / 实付 ${money(finalOrder.body?.price?.paid)}`);

  console.log(`${'─'.repeat(56)}`);
  if (failures.length) {
    console.log(`\u001b[31m${failures.length} 项失败：\u001b[0m ${failures.join('; ')}\n`);
    process.exit(1);
  }
  console.log('\u001b[32m全链路通过：静态资源 → 搜索 → 报价 → 验价 → 下单 → 支付 → 确认 → 取消 → 退款\u001b[0m\n');
}

main().catch((err) => {
  console.error('冒烟测试异常:', err);
  process.exit(1);
});
