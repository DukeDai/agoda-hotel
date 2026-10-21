import type { OrderStatus } from '@/lib/api';
import { statusMeta } from '@/lib/status';
import { cn } from '@/lib/cn';

const TONE_CLASSES: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  processing: 'bg-sky-50 text-sky-800 ring-sky-600/20',
  success: 'bg-emerald-50 text-emerald-800 ring-emerald-600/20',
  neutral: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  danger: 'bg-rose-50 text-rose-700 ring-rose-600/20',
};

export interface OrderStatusBadgeProps {
  status: OrderStatus | null | undefined;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
  lg: 'px-3.5 py-1.5 text-base',
};

/**
 * Shared order-status badge. `BOOKING_SUBMITTED` renders as 「供应商确认中」
 * and never as 「预订成功」 — only `CONFIRMED` may claim a booking.
 */
export function OrderStatusBadge({ status, className, size = 'md' }: OrderStatusBadgeProps) {
  const meta = statusMeta(status);
  return (
    <span
      data-status={status ?? 'UNKNOWN'}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full font-semibold ring-1 ring-inset',
        TONE_CLASSES[meta.tone] ?? TONE_CLASSES.neutral,
        SIZE_CLASSES[size],
        className,
      )}
    >
      {meta.label}
    </span>
  );
}

export interface OrderStatusDetailProps {
  status: OrderStatus | null | undefined;
  className?: string;
}

/** Badge + the explanation line underneath it. */
export function OrderStatusDetail({ status, className }: OrderStatusDetailProps) {
  const meta = statusMeta(status);
  return (
    <div className={cn('space-y-1.5', className)}>
      <OrderStatusBadge status={status} size="lg" />
      <p className="text-sm text-slate-600">{meta.hint}</p>
    </div>
  );
}
