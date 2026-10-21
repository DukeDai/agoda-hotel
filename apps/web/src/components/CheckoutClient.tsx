'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  BadgeCheck,
  BedDouble,
  CalendarDays,
  CreditCard,
  Loader2,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { Money as MoneyValue, Order, PrecheckInput, Quote } from '@/lib/api';
import { ApiError, createBooking, isApiError, payBooking, precheckQuote } from '@/lib/api';
import type { CheckoutState } from '@/lib/checkout-state';
import { createIdempotencyKeyStore } from '@/lib/idempotency';
import {
  cancellationLabel,
  formatDateWithWeekday,
  formatMoney,
  mealPlanLabel,
  moneyFromMinorUnits,
} from '@/lib/format';
import { Money, PriceBreakdownView } from '@/components/Money';
import { ErrorPanel, friendlyApiMessage } from '@/components/ErrorPanel';

export interface CheckoutClientProps {
  state: CheckoutState;
}

interface GuestForm {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  specialRequests: string;
}

const EMPTY_FORM: GuestForm = {
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  specialRequests: '',
};

/**
 * The price change the customer still has to confirm.
 *
 * `total` is the newest price we know, `acceptedAmount` is the **integer
 * minor unit** amount that goes into the booking request as `acceptedTotal`
 * (`null` while the API has not told us the new amount).
 */
interface PriceNotice {
  message: string;
  /** The price the customer saw before the change. */
  previous: MoneyValue | null;
  /** The new price the customer has to accept. */
  total: MoneyValue;
  /** Integer minor units to send as `acceptedTotal`. */
  acceptedAmount: number | null;
}

/**
 * The amount the customer must accept, taken from the API's
 * `PRICE_CHANGED` error details.
 *
 * Contract shape: `details.expected` is the integer minor unit amount and
 * `details.currency` the currency. Older supplier errors nest the amounts in
 * objects (`{ expected: { amount, currency } }`) — those are unwrapped too.
 */
function priceChangeTarget(details: Record<string, unknown> | undefined): {
  amount: number | null;
  currency: string | null;
} {
  const currency = typeof details?.currency === 'string' ? details.currency : null;
  const expected = details?.expected;

  if (typeof expected === 'number' && Number.isFinite(expected)) {
    return { amount: Math.trunc(expected), currency };
  }

  if (expected && typeof expected === 'object') {
    const nested = expected as { amount?: unknown; currency?: unknown };
    const actual = details?.actual;
    const actualAmount =
      actual && typeof actual === 'object'
        ? (actual as { amount?: unknown }).amount
        : undefined;
    const amount = typeof actualAmount === 'number' ? actualAmount : nested.amount;
    if (typeof amount === 'number' && Number.isFinite(amount)) {
      return {
        amount: Math.trunc(amount),
        currency: currency ?? (typeof nested.currency === 'string' ? nested.currency : null),
      };
    }
  }

  return { amount: null, currency: null };
}

/** Compare money by integer minor units — never by float. */
function sameTotal(a: { amount: number } | null | undefined, b: { amount: number } | null | undefined) {
  if (!a || !b) return false;
  return a.amount === b.amount;
}

export function CheckoutClient({ state }: CheckoutClientProps) {
  const router = useRouter();
  const keys = useRef(createIdempotencyKeyStore()).current;

  const [form, setForm] = useState<GuestForm>(EMPTY_FORM);
  const [quote, setQuote] = useState<Quote>(state.quote);
  const [stage, setStage] = useState<'form' | 'created'>('form');
  const [order, setOrder] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof GuestForm, string>>>({});
  const [error, setError] = useState<{ title: string; message: string; code?: string } | null>(null);
  const [priceNotice, setPriceNotice] = useState<PriceNotice | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  /** Integer minor units the customer explicitly accepted (null = not accepted yet). */
  const acceptedTotal = useRef<number | null>(null);

  const { hotel, stay } = state;

  function updateForm<K extends keyof GuestForm>(key: K, value: string) {
    setForm((previous) => ({ ...previous, [key]: value }));
    setFieldErrors((previous) => ({ ...previous, [key]: undefined }));
  }

  function validate(): boolean {
    const errors: Partial<Record<keyof GuestForm, string>> = {};
    if (!form.firstName.trim()) errors.firstName = '请填写名字';
    if (!form.lastName.trim()) errors.lastName = '请填写姓氏';
    if (!form.email.trim()) {
      errors.email = '请填写邮箱';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      errors.email = '邮箱格式不正确';
    }
    if (!form.phone.trim()) errors.phone = '请填写联系电话';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  function buildPrecheckBody(): PrecheckInput {
    return {
      hotelId: hotel.id,
      offerId: quote.offerId,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      rooms: stay.rooms,
      adults: stay.adults,
      childAges: stay.childAges,
      currency: stay.currency,
      nationality: 'CN',
    };
  }

  function buildBookingBody() {
    return {
      hotelId: hotel.id,
      offerId: quote.offerId,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      rooms: stay.rooms,
      adults: stay.adults,
      childAges: stay.childAges,
      currency: stay.currency,
      nationality: 'CN',
      guest: {
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
      },
      specialRequests: form.specialRequests
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    };
  }

  /**
   * The price the customer last saw or accepted.
   *
   * Once a price was accepted we only know its integer minor units, so the
   * display value is derived from them — the accepted amount itself always
   * stays an integer.
   */
  function lastKnownTotal(): MoneyValue {
    const accepted = acceptedTotal.current;
    if (accepted !== null) return moneyFromMinorUnits(accepted, stay.currency);
    return quote.stayTotal.total;
  }

  async function runPrecheck(
    body: PrecheckInput,
    idempotencyKey: string,
  ): Promise<{ ok: true } | { ok: false }> {
    try {
      const response = await precheckQuote(body, idempotencyKey);

      if (!response.available) {
        setUnavailable(true);
        setError(null);
        return { ok: false };
      }

      const previous = lastKnownTotal();
      if (response.quote) setQuote(response.quote);

      // The customer may have accepted this exact price already (integer minor
      // units) — then the re-price is not a surprise and we may continue.
      const accepted = acceptedTotal.current;
      const newTotal = response.total ?? null;
      const changed =
        response.priceChanged && !(accepted !== null && newTotal?.amount === accepted);

      if (changed && newTotal) {
        // The customer must see the new price and confirm it explicitly.
        acceptedTotal.current = null;
        setPriceNotice({
          message: `价格已从 ${formatMoney(previous)} 变为 ${formatMoney(newTotal)}，请确认新价格后继续下单。`,
          previous,
          total: newTotal,
          acceptedAmount: newTotal.amount,
        });
        setError(null);
        return { ok: false };
      }

      setPriceNotice(null);
      return { ok: true };
    } catch (caught) {
      const code = isApiError(caught) ? caught.code : '';
      if (code === 'ROOM_UNAVAILABLE') {
        setUnavailable(true);
        setError(null);
        return { ok: false };
      }
      if (code === 'PRICE_CHANGED') {
        // The supplier re-priced without telling us the new amount — ask for a
        // fresh quote instead of guessing.
        setPriceNotice({
          message: '供应商已调整价格，请获取最新报价后确认。',
          previous: quote.stayTotal.total,
          total: quote.stayTotal.total,
          acceptedAmount: null,
        });
        setError(null);
        return { ok: false };
      }
      setError(friendlyApiMessage(caught));
      return { ok: false };
    }
  }

  /**
   * Re-verify the price with a **new** precheck key.
   *
   * The key of the previous verification is stale: replaying it would hand us
   * the same old price again and the customer would keep accepting an outdated
   * amount. A new key forces a real re-quote at the supplier.
   */
  async function refreshLatestPrice(): Promise<MoneyValue | null> {
    keys.rotate('precheck');
    const body = buildPrecheckBody();
    const idempotencyKey = keys.keyFor('precheck', body);

    try {
      const response = await precheckQuote(body, idempotencyKey);
      if (!response.available) {
        setUnavailable(true);
        setError(null);
        return null;
      }
      if (response.quote) setQuote(response.quote);
      return response.total ?? null;
    } catch (caught) {
      if (isApiError(caught) && caught.code === 'ROOM_UNAVAILABLE') {
        setUnavailable(true);
        setError(null);
        return null;
      }
      return null;
    }
  }

  /**
   * The supplier re-priced the offer while we were booking: the API answered
   * `409 PRICE_CHANGED` and told us the amount the customer has to accept.
   *
   * We rotate the booking key (the attempt was rejected outright, so nothing
   * was created) and re-quote once with a fresh precheck key, so the customer
   * always confirms the *current* price instead of a stale one.
   */
  async function recoverFromPriceChange(apiError: ApiError): Promise<void> {
    keys.rotate('book');

    const previous = lastKnownTotal();
    const target = priceChangeTarget(apiError.details);
    const refreshed = await refreshLatestPrice();

    const total =
      refreshed ??
      (target.amount !== null
        ? moneyFromMinorUnits(target.amount, target.currency ?? stay.currency)
        : previous);

    // The customer has to confirm the new price again.
    acceptedTotal.current = null;

    if (!refreshed && target.amount === null) {
      // We could not learn the new amount at all → keep the plain wording and
      // let the customer pull a fresh quote.
      setPriceNotice({
        message: '下单时价格发生变化，请获取最新报价后确认再提交。',
        previous,
        total,
        acceptedAmount: null,
      });
      setError(null);
      return;
    }

    const message = sameTotal(total, previous)
      ? '供应商刚刚调整了价格，请确认最新价格后继续下单。'
      : `价格已从 ${formatMoney(previous)} 变为 ${formatMoney(total)}，请确认新价格后继续下单。`;

    setPriceNotice({
      message,
      previous,
      total,
      acceptedAmount: total.amount,
    });
    setError(null);
  }

  async function submitOrder() {
    if (!validate()) return;
    setBusy(true);
    setError(null);

    try {
      // A new user submission has to re-verify the price → new precheck key.
      // Inside one submission the key stays stable, so a retried request
      // replays the first answer instead of hitting the supplier twice.
      keys.rotate('precheck');
      const precheckBody = buildPrecheckBody();
      const precheckKey = keys.keyFor('precheck', precheckBody);

      const precheck = await runPrecheck(precheckBody, precheckKey);
      if (!precheck.ok) {
        setBusy(false);
        return;
      }

      const body = buildBookingBody();
      const accepted = acceptedTotal.current;
      const idempotencyKey = keys.keyFor('book', { ...body, acceptedTotal: accepted ?? null });

      try {
        const created = await createBooking(
          {
            hotelId: body.hotelId,
            offerId: body.offerId,
            checkIn: body.checkIn,
            checkOut: body.checkOut,
            rooms: body.rooms,
            adults: body.adults,
            childAges: body.childAges,
            currency: body.currency,
            nationality: body.nationality,
            guest: body.guest,
            specialRequests: body.specialRequests,
            acceptedTotal: accepted ?? undefined,
          },
          idempotencyKey,
        );
        setOrder(created);
        setStage('created');
      } catch (caught) {
        const apiError = caught as ApiError;
        if (isApiError(caught) && apiError.code === 'PRICE_CHANGED') {
          // Definite rejection → the previous attempt created nothing, so a
          // fresh idempotency key is safe for the next attempt.
          await recoverFromPriceChange(apiError);
          return;
        }
        if (isApiError(caught) && apiError.code === 'ROOM_UNAVAILABLE') {
          setUnavailable(true);
          setError(null);
          return;
        }
        if (isApiError(caught) && apiError.code === 'IDEMPOTENCY_CONFLICT') {
          keys.rotate('book');
          setError({
            title: '请求重复',
            message: '上一次提交使用了不同的内容，请再次点击「提交订单」。',
            code: apiError.code,
          });
          return;
        }
        setError(friendlyApiMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  /**
   * Explicit confirmation of a changed price, then continue with the order.
   *
   * The customer already accepted the displayed price, so we do **not** verify
   * the price again — we send the accepted amount (integer minor units) with
   * the booking request and let the API decide.
   */
  async function acceptNewPrice() {
    if (!priceNotice) return;
    const accepted = priceNotice.acceptedAmount;

    if (accepted === null) {
      // The API never told us the new amount → pull a fresh quote first.
      setBusy(true);
      setError(null);
      try {
        const total = await refreshLatestPrice();
        if (!total) {
          setPriceNotice({
            message: '下单时价格发生变化，请获取最新报价后确认再提交。',
            previous: priceNotice.previous,
            total: priceNotice.total,
            acceptedAmount: null,
          });
          return;
        }
        acceptedTotal.current = null;
        setPriceNotice({
          message: `价格已从 ${formatMoney(priceNotice.previous ?? total)} 变为 ${formatMoney(total)}，请确认新价格后继续下单。`,
          previous: priceNotice.previous ?? total,
          total,
          acceptedAmount: total.amount,
        });
      } finally {
        setBusy(false);
      }
      return;
    }

    acceptedTotal.current = accepted;
    setPriceNotice(null);
    keys.rotate('book');
    setBusy(true);
    setError(null);

    try {
      const body = buildBookingBody();
      const idempotencyKey = keys.keyFor('book', { ...body, acceptedTotal: accepted });

      try {
        const created = await createBooking(
          {
            hotelId: body.hotelId,
            offerId: body.offerId,
            checkIn: body.checkIn,
            checkOut: body.checkOut,
            rooms: body.rooms,
            adults: body.adults,
            childAges: body.childAges,
            currency: body.currency,
            nationality: body.nationality,
            guest: body.guest,
            specialRequests: body.specialRequests,
            acceptedTotal: accepted,
          },
          idempotencyKey,
        );
        setOrder(created);
        setStage('created');
      } catch (caught) {
        if (isApiError(caught) && (caught as ApiError).code === 'PRICE_CHANGED') {
          // The price moved again → re-quote with a new key, never reuse the
          // amount the customer just accepted.
          await recoverFromPriceChange(caught as ApiError);
          return;
        }
        setError(friendlyApiMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  }

  async function payOrder() {
    if (!order) return;
    setBusy(true);
    setError(null);

    const body = { method: 'mock_card' };
    // A fresh key for the payment step — it must never be the booking key.
    const idempotencyKey = keys.keyFor(`pay:${order.orderNo}`, body);

    try {
      const response = await payBooking(order.orderNo, body.method, idempotencyKey);
      // The endpoint answers `{ orderNo, status, payment, booking }` — the full
      // order lives in `booking`, the top level only carries the summary.
      if (response.booking) setOrder(response.booking);
      router.push(`/orders/${encodeURIComponent(order.orderNo)}`);
    } catch (caught) {
      setError(friendlyApiMessage(caught));
      setBusy(false);
    }
  }

  if (unavailable) {
    return (
      <div className="container-page py-16">
        <ErrorPanel
          variant="warning"
          title="该房型已售罄"
          message="很抱歉，所选房型在当前日期已订满。请返回酒店页面选择其它房型或调整日期。"
          action={
            <a href={`/hotels/${encodeURIComponent(hotel.slug || hotel.id)}`} className="btn-secondary">
              返回选择房型
            </a>
          }
        />
      </div>
    );
  }

  if (stage === 'created' && order) {
    return (
      <div className="container-page py-10">
        <div className="mx-auto max-w-2xl">
          <div className="card p-6 sm:p-8">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-50 text-amber-600">
                <CreditCard className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <h1 className="text-xl font-bold text-slate-900">订单已创建，等待支付</h1>
                <p className="text-sm text-slate-500">订单号 {order.orderNo}</p>
              </div>
            </div>

            <dl className="mt-6 space-y-3 rounded-lg bg-slate-50 p-4 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">酒店</dt>
                <dd className="text-right font-medium text-slate-900">{hotel.name}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">入住 — 离店</dt>
                <dd className="text-right font-medium text-slate-900">
                  {formatDateWithWeekday(stay.checkIn)} — {formatDateWithWeekday(stay.checkOut)}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">房型</dt>
                <dd className="text-right font-medium text-slate-900">{quote.roomTypeName}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">入住人</dt>
                <dd className="text-right font-medium text-slate-900">
                  {form.lastName} {form.firstName}
                </dd>
              </div>
            </dl>

            <div className="mt-6">
              <PriceBreakdownView breakdown={order.price} totalLabel="应付金额" />
            </div>

            {error ? (
              <div className="mt-6">
                <ErrorPanel title={error.title} message={error.message} code={error.code} />
              </div>
            ) : null}

            <button
              type="button"
              onClick={payOrder}
              disabled={busy}
              className="btn-primary mt-6 w-full py-3 text-base"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CreditCard className="h-4 w-4" aria-hidden />}
              支付 <Money value={order.price.total} size="md" className="text-white" />
            </button>

            <p className="mt-3 text-center text-xs text-slate-500">
              支付完成后将向供应商提交订单，可在订单页查看确认进度。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container-page py-10">
      <div className="grid gap-8 lg:grid-cols-[1.3fr_1fr]">
        {/* Guest form */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">填写入住人信息</h1>
          <p className="mt-1.5 text-sm text-slate-500">
            请填写与证件一致的姓名，入住时需出示。
          </p>

          <form
            className="card mt-6 space-y-5 p-5 sm:p-6"
            onSubmit={(event) => {
              event.preventDefault();
              void submitOrder();
            }}
            noValidate
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="field-label" htmlFor="lastName">
                  姓
                </label>
                <input
                  id="lastName"
                  value={form.lastName}
                  onChange={(event) => updateForm('lastName', event.target.value)}
                  className="field-input"
                  autoComplete="family-name"
                />
                {fieldErrors.lastName ? (
                  <p className="field-error">{fieldErrors.lastName}</p>
                ) : null}
              </div>
              <div>
                <label className="field-label" htmlFor="firstName">
                  名
                </label>
                <input
                  id="firstName"
                  value={form.firstName}
                  onChange={(event) => updateForm('firstName', event.target.value)}
                  className="field-input"
                  autoComplete="given-name"
                />
                {fieldErrors.firstName ? (
                  <p className="field-error">{fieldErrors.firstName}</p>
                ) : null}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="field-label" htmlFor="email">
                  邮箱
                </label>
                <input
                  id="email"
                  type="email"
                  value={form.email}
                  onChange={(event) => updateForm('email', event.target.value)}
                  className="field-input"
                  autoComplete="email"
                  placeholder="用于接收订单确认"
                />
                {fieldErrors.email ? <p className="field-error">{fieldErrors.email}</p> : null}
              </div>
              <div>
                <label className="field-label" htmlFor="phone">
                  联系电话
                </label>
                <input
                  id="phone"
                  type="tel"
                  value={form.phone}
                  onChange={(event) => updateForm('phone', event.target.value)}
                  className="field-input"
                  autoComplete="tel"
                  placeholder="+86 13800000000"
                />
                {fieldErrors.phone ? <p className="field-error">{fieldErrors.phone}</p> : null}
              </div>
            </div>

            <div>
              <label className="field-label" htmlFor="specialRequests">
                特殊要求（选填）
              </label>
              <textarea
                id="specialRequests"
                value={form.specialRequests}
                onChange={(event) => updateForm('specialRequests', event.target.value)}
                rows={3}
                className="field-input resize-y"
                placeholder="每行一条，例如：延迟退房、高楼层、婴儿床"
              />
            </div>

            {priceNotice ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-amber-900">价格已变动</p>
                    <p className="mt-1 text-sm text-amber-800">{priceNotice.message}</p>
                    {priceNotice.previous ? (
                      <p className="mt-2 text-sm text-amber-800">
                        原价格：<Money value={priceNotice.previous} size="sm" className="text-amber-800" />
                      </p>
                    ) : null}
                    <p className="mt-2 text-sm text-amber-900">
                      最新应付：<Money value={priceNotice.total} size="md" className="text-amber-900" />
                    </p>
                    <button
                      type="button"
                      onClick={() => void acceptNewPrice()}
                      disabled={busy}
                      className="btn-primary mt-3"
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                      {priceNotice.acceptedAmount === null
                        ? '重新获取最新价格'
                        : '我已知悉新价格，继续下单'}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {error ? (
              <ErrorPanel title={error.title} message={error.message} code={error.code} />
            ) : null}

            <button type="submit" disabled={busy} className="btn-primary w-full py-3 text-base">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ShieldCheck className="h-4 w-4" aria-hidden />}
              提交订单
            </button>

            <p className="text-center text-xs text-slate-500">
              提交订单前会自动验价，确认价格与房量无误后再向供应商下单。
            </p>
          </form>
        </div>

        {/* Offer summary */}
        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="card overflow-hidden">
            {hotel.thumbnail ? (
              <img src={hotel.thumbnail} alt="" className="h-36 w-full object-cover" />
            ) : null}
            <div className="p-5">
              <h2 className="text-base font-semibold text-slate-900">{hotel.name}</h2>
              {hotel.city ? <p className="mt-0.5 text-sm text-slate-500">{hotel.city}</p> : null}

              <dl className="mt-4 space-y-2.5 text-sm">
                <div className="flex items-center gap-2 text-slate-600">
                  <CalendarDays className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                  <span>
                    {formatDateWithWeekday(stay.checkIn)} — {formatDateWithWeekday(stay.checkOut)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-slate-600">
                  <Users className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                  <span>
                    {stay.nights} 晚 · {stay.rooms} 间房 · {stay.adults} 位成人
                    {stay.childAges.length > 0 ? ` · ${stay.childAges.length} 位儿童` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-slate-600">
                  <BedDouble className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                  <span>
                    {quote.roomTypeName}
                    {quote.bedType ? ` · ${quote.bedType}` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-slate-600">
                  <BadgeCheck className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                  <span>
                    {mealPlanLabel(quote.mealPlan)}
                    {quote.ratePlanName ? ` · ${quote.ratePlanName}` : ''}
                  </span>
                </div>
              </dl>

              <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-relaxed text-slate-600">
                {cancellationLabel(quote.cancellationPolicy)}
              </div>

              <div className="mt-5 border-t border-slate-200 pt-4">
                <PriceBreakdownView breakdown={quote.stayTotal} totalLabel="住宿总计" />
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
