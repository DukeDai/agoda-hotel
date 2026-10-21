import Link from 'next/link';
import { BedDouble, Maximize2, ShieldCheck, Users, Utensils } from 'lucide-react';
import type { Quote, RoomType } from '@/lib/api';
import { buildCheckoutHref, type CheckoutStay } from '@/lib/checkout-state';
import { cancellationLabel, mealPlanLabel } from '@/lib/format';
import { Money } from '@/components/Money';

export interface RoomOfferCardProps {
  quote: Quote;
  roomType?: RoomType | null;
  hotel: {
    id: string;
    name: string;
    slug?: string | null;
    thumbnail?: string | null;
    city?: string | null;
  };
  stay: CheckoutStay;
}

export function RoomOfferCard({ quote, roomType, hotel, stay }: RoomOfferCardProps) {
  const href = buildCheckoutHref({ hotel, stay, quote });

  return (
    <article className="card overflow-hidden">
      <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900">{quote.roomTypeName}</h3>
            {quote.ratePlanName ? (
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                {quote.ratePlanName}
              </span>
            ) : null}
            {quote.instantConfirmation ? (
              <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700">
                即时确认
              </span>
            ) : null}
          </div>

          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-600">
            {quote.bedType ? (
              <span className="inline-flex items-center gap-1.5">
                <BedDouble className="h-4 w-4 text-slate-400" aria-hidden />
                {quote.bedType}
              </span>
            ) : null}
            {roomType?.sizeSqm ? (
              <span className="inline-flex items-center gap-1.5">
                <Maximize2 className="h-4 w-4 text-slate-400" aria-hidden />
                {roomType.sizeSqm} 平方米
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1.5">
              <Users className="h-4 w-4 text-slate-400" aria-hidden />
              最多 {quote.maxOccupancy ?? roomType?.maxOccupancy ?? 2} 位
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Utensils className="h-4 w-4 text-slate-400" aria-hidden />
              {mealPlanLabel(quote.mealPlan)}
            </span>
          </div>

          <p className="mt-3 inline-flex items-start gap-1.5 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            {cancellationLabel(quote.cancellationPolicy)}
          </p>
        </div>

        <div className="flex shrink-0 flex-row items-end justify-between gap-4 border-t border-slate-100 pt-4 sm:w-48 sm:flex-col sm:items-end sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
          <div className="text-left sm:text-right">
            <p className="text-xs text-slate-500">{quote.nights} 晚合计</p>
            <Money value={quote.stayTotal.total} size="lg" />
            <p className="mt-1 text-xs text-slate-500">
              每晚 <Money value={quote.nightly.total} size="sm" className="text-slate-600" />
            </p>
          </div>

          <Link href={href} className="btn-primary w-full sm:w-auto">
            选择
          </Link>
        </div>
      </div>
    </article>
  );
}
