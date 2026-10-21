import type { Money as MoneyValue, PriceBreakdown } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/cn';

type MoneySize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASSES: Record<MoneySize, string> = {
  sm: 'text-sm font-semibold',
  md: 'text-base font-semibold',
  lg: 'text-xl font-bold tracking-tight',
  xl: 'text-3xl font-bold tracking-tight',
};

export interface MoneyProps {
  value: MoneyValue | null | undefined;
  size?: MoneySize;
  className?: string;
}

/**
 * Renders a money amount from the API's `major` value.
 * No float arithmetic happens anywhere in this component.
 */
export function Money({ value, size = 'md', className }: MoneyProps) {
  return (
    <span className={cn(SIZE_CLASSES[size], 'text-slate-900 tabular-nums', className)}>
      {formatMoney(value)}
    </span>
  );
}

export interface PriceBreakdownViewProps {
  breakdown: PriceBreakdown | null | undefined;
  /** Label for the "total" row — e.g. 住宿总计. */
  totalLabel?: string;
  className?: string;
  emphasizeTotal?: boolean;
}

/** net / taxes / total breakdown used on the checkout and order pages. */
export function PriceBreakdownView({
  breakdown,
  totalLabel = '订单总额',
  className,
  emphasizeTotal = true,
}: PriceBreakdownViewProps) {
  if (!breakdown) return null;

  return (
    <dl className={cn('space-y-2 text-sm', className)}>
      <div className="flex items-baseline justify-between gap-4">
        <dt className="text-slate-500">房费小计</dt>
        <dd className="tabular-nums text-slate-700">
          {formatMoney(breakdown.net)}
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-4">
        <dt className="text-slate-500">税费及服务费</dt>
        <dd className="tabular-nums text-slate-700">
          {formatMoney(breakdown.taxes)}
        </dd>
      </div>
      <div
        className={cn(
          'flex items-baseline justify-between gap-4 border-t border-slate-200 pt-3',
          emphasizeTotal && 'mt-3',
        )}
      >
        <dt className="font-semibold text-slate-900">{totalLabel}</dt>
        <dd>
          <Money value={breakdown.total} size="lg" />
        </dd>
      </div>
    </dl>
  );
}
