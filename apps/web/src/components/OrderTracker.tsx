'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Copy,
  Loader2,
  MapPin,
  RefreshCw,
  Users,
  XCircle,
} from 'lucide-react';
import type { CancelResponse, Order } from '@/lib/api';
import { cancelBooking, getBooking, isApiError } from '@/lib/api';
import { createIdempotencyKeyStore } from '@/lib/idempotency';
import { formatDateTime, formatDateWithWeekday, formatMoney, mealPlanLabel } from '@/lib/format';
import { isCancellableStatus, isPollingStatus } from '@/lib/status';
import { Money, PriceBreakdownView } from '@/components/Money';
import { OrderStatusDetail } from '@/components/OrderStatusBadge';
import { SmartImage } from '@/components/SmartImage';
import { ErrorPanel, friendlyApiMessage } from '@/components/ErrorPanel';

export interface OrderTrackerProps {
  orderNo: string;
}

const POLL_INTERVAL_MS = 3000;

export function OrderTracker({ orderNo }: OrderTrackerProps) {
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ title: string; message: string; code?: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('行程变更');
  const [cancelling, setCancelling] = useState(false);
  const [cancelResult, setCancelResult] = useState<CancelResponse['cancellation'] | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);

  const keys = useRef(createIdempotencyKeyStore()).current;

  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const data = await getBooking(orderNo);
        setOrder(data);
        setError(null);
      } catch (caught) {
        if (!silent) setError(friendlyApiMessage(caught));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [orderNo],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll while the supplier is still processing. The effect re-runs whenever
  // the status changes, so it stops as soon as a terminal state is reached.
  const status = order?.status;
  useEffect(() => {
    if (!isPollingStatus(status)) return;
    const timer = setInterval(() => {
      void refresh(true);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [status, refresh]);

  async function handleCancel() {
    setCancelling(true);
    setPolicyError(null);
    const body = { reason: reason.trim() || '行程变更' };
    // Stable key for the same cancellation request → no double refund.
    const idempotencyKey = keys.keyFor(`cancel:${orderNo}`, body);

    try {
      const response = await cancelBooking(orderNo, body.reason, idempotencyKey);
      setCancelResult(response.cancellation);
      setCancelOpen(false);
      await refresh(true);
    } catch (caught) {
      if (isApiError(caught) && caught.code === 'CANCEL_NOT_ALLOWED') {
        const details = caught.details as { policyDescription?: string; policyType?: string };
        setPolicyError(
          details?.policyDescription ??
            details?.policyType ??
            caught.message ??
            '该订单当前状态不允许取消。',
        );
        setCancelOpen(false);
      } else {
        setError(friendlyApiMessage(caught));
      }
    } finally {
      setCancelling(false);
    }
  }

  if (loading) {
    return (
      <div className="container-page flex min-h-[50vh] items-center justify-center py-16">
        <div className="flex items-center gap-3 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          <span className="text-sm">正在加载订单…</span>
        </div>
      </div>
    );
  }

  if (!order) {
    const message = error ?? {
      title: '订单不存在',
      message: '未能获取订单信息，请确认订单号是否正确。',
    };
    return (
      <div className="container-page py-16">
        <ErrorPanel
          variant={message.code === 'NETWORK_ERROR' ? 'offline' : 'error'}
          title={message.title}
          message={message.message}
          code={message.code}
          action={
            <button type="button" onClick={() => void refresh()} className="btn-secondary">
              <RefreshCw className="h-4 w-4" aria-hidden />
              重试
            </button>
          }
        />
      </div>
    );
  }

  const stay = order.stay;
  const polling = isPollingStatus(order.status);
  const cancellable = isCancellableStatus(order.status);

  return (
    <div className="container-page py-10">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Status header */}
        <div className="card p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">订单号</p>
              <p className="mt-1 font-mono text-lg font-semibold text-slate-900">{order.orderNo}</p>
            </div>
            <div className="flex items-center gap-2">
              {polling ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  自动刷新中
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                className="btn-ghost px-2.5 py-1.5 text-xs"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} aria-hidden />
                刷新
              </button>
            </div>
          </div>

          <div className="mt-5 border-t border-slate-100 pt-5">
            <OrderStatusDetail status={order.status} />
          </div>

          {order.status === 'BOOKING_SUBMITTED' ? (
            <div className="mt-4 flex items-start gap-3 rounded-lg border border-sky-200 bg-sky-50 p-3.5">
              <RefreshCw className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-sky-600" aria-hidden />
              <p className="text-sm text-sky-900">
                订单已提交给供应商，目前<strong className="font-semibold">确认中</strong>。
                只有收到供应商确认号后才会变为「预订成功」，请稍候。
              </p>
            </div>
          ) : null}

          {order.status === 'CONFIRMED' && order.confirmationNumber ? (
            <div className="mt-4 flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3.5">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-emerald-900">预订已确认</p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-emerald-800">
                  确认号
                  <span className="rounded bg-white px-2 py-0.5 font-mono font-semibold tracking-wide text-emerald-900">
                    {order.confirmationNumber}
                  </span>
                  <Copy className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
                </p>
              </div>
            </div>
          ) : null}

          {order.confirmationNumber && order.status !== 'CONFIRMED' ? (
            <p className="mt-4 text-sm text-slate-600">
              确认号：<span className="font-mono font-semibold text-slate-900">{order.confirmationNumber}</span>
            </p>
          ) : null}

          {cancelResult ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-sm text-slate-700">
              取消申请已受理
              {cancelResult.refundAmount ? (
                <span className="ml-1">
                  预计退款 <Money value={cancelResult.refundAmount} size="sm" />
                </span>
              ) : null}
              {cancelResult.penaltyAmount && cancelResult.penaltyAmount.amount > 0 ? (
                <span className="ml-1">
                  罚金 <Money value={cancelResult.penaltyAmount} size="sm" />
                </span>
              ) : null}
            </div>
          ) : null}

          {policyError ? (
            <div className="mt-4">
              <ErrorPanel
                variant="warning"
                title="当前不可取消"
                message={policyError}
                action={
                  <button type="button" onClick={() => setPolicyError(null)} className="btn-secondary">
                    知道了
                  </button>
                }
              />
            </div>
          ) : null}
        </div>

        {/* Stay + guest */}
        <div className="card overflow-hidden">
          {order.hotel?.thumbnail ? (
            <SmartImage
              src={order.hotel.thumbnail}
              alt=""
              className="h-40 w-full object-cover"
              fallbackClassName="h-40 w-full bg-slate-100"
            />
          ) : null}
          <div className="p-6">
            <h2 className="text-lg font-semibold text-slate-900">{order.hotel?.name}</h2>
            {order.hotel?.address ? (
              <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
                <MapPin className="h-3.5 w-3.5" aria-hidden />
                {[order.hotel.address.city, order.hotel.address.country].filter(Boolean).join(' · ')}
              </p>
            ) : null}

            <dl className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="flex items-start gap-2.5">
                <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                <div>
                  <dt className="text-xs text-slate-500">入住 — 离店</dt>
                  <dd className="mt-0.5 text-sm font-medium text-slate-900">
                    {formatDateWithWeekday(stay?.checkIn)} — {formatDateWithWeekday(stay?.checkOut)}
                  </dd>
                  <dd className="text-xs text-slate-500">
                    {stay?.nights} 晚 · {stay?.rooms} 间房 · {stay?.adults} 位成人
                    {stay?.childAges?.length ? ` · ${stay.childAges.length} 位儿童` : ''}
                  </dd>
                </div>
              </div>

              <div className="flex items-start gap-2.5">
                <Users className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                <div>
                  <dt className="text-xs text-slate-500">入住人</dt>
                  <dd className="mt-0.5 text-sm font-medium text-slate-900">
                    {order.guest?.lastName} {order.guest?.firstName}
                  </dd>
                  <dd className="text-xs text-slate-500">{order.guest?.email}</dd>
                  <dd className="text-xs text-slate-500">{order.guest?.phone}</dd>
                </div>
              </div>
            </dl>

            {order.items && order.items.length > 0 ? (
              <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
                {order.items.map((item) => (
                  <div
                    key={item.offerId}
                    className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
                  >
                    <span className="text-slate-700">
                      {item.roomTypeName}
                      {item.ratePlanName ? ` · ${item.ratePlanName}` : ''}
                      <span className="ml-2 text-xs text-slate-500">
                        {mealPlanLabel(item.mealPlan)} · {item.nights} 晚
                      </span>
                    </span>
                    <span className="tabular-nums font-semibold text-slate-900">
                      {formatMoney(item.total)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {order.specialRequests && order.specialRequests.length > 0 ? (
              <div className="mt-5 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                特殊要求：{order.specialRequests.join('；')}
              </div>
            ) : null}
          </div>
        </div>

        {/* Price */}
        <div className="card p-6">
          <h2 className="text-base font-semibold text-slate-900">费用明细</h2>
          <div className="mt-4">
            <PriceBreakdownView breakdown={order.price} totalLabel="订单总额" />
          </div>
          {order.price?.paid ? (
            <div className="mt-4 space-y-1.5 border-t border-slate-100 pt-4 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">已支付</span>
                <span className="tabular-nums text-slate-700">{formatMoney(order.price.paid)}</span>
              </div>
              {order.price.refunded ? (
                <div className="flex justify-between">
                  <span className="text-slate-500">已退款</span>
                  <span className="tabular-nums text-slate-700">
                    {formatMoney(order.price.refunded)}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Cancel */}
        {cancellable ? (
          <div className="card p-6">
            <h2 className="text-base font-semibold text-slate-900">取消订单</h2>
            <p className="mt-1.5 text-sm text-slate-500">
              取消将按订单的取消政策计算罚金，退款金额 = 实付 − 罚金。
            </p>

            {cancelOpen ? (
              <div className="mt-4 space-y-3">
                <div>
                  <label className="field-label" htmlFor="cancel-reason">
                    取消原因
                  </label>
                  <input
                    id="cancel-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    className="field-input"
                  />
                </div>
                <div className="flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={() => void handleCancel()}
                    disabled={cancelling}
                    className="btn-primary bg-rose-600 hover:bg-rose-700"
                  >
                    {cancelling ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <XCircle className="h-4 w-4" aria-hidden />}
                    确认取消订单
                  </button>
                  <button type="button" onClick={() => setCancelOpen(false)} className="btn-secondary">
                    再想想
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setCancelOpen(true)} className="btn-secondary mt-4">
                <AlertTriangle className="h-4 w-4 text-rose-500" aria-hidden />
                取消订单
              </button>
            )}
          </div>
        ) : null}

        <p className="text-center text-xs text-slate-400">
          创建于 {formatDateTime(order.createdAt)}
          {order.updatedAt ? ` · 更新于 ${formatDateTime(order.updatedAt)}` : ''}
        </p>
      </div>
    </div>
  );
}
