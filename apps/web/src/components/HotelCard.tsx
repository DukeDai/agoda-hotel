import Link from 'next/link';
import { Building2, MapPin } from 'lucide-react';
import type { HotelSummary } from '@/lib/api';
import { formatAddress, formatMoney } from '@/lib/format';
import { StarRating } from '@/components/StarRating';
import { SmartImage } from '@/components/SmartImage';
import { Money } from '@/components/Money';
import { cn } from '@/lib/cn';

export interface HotelCardProps {
  hotel: HotelSummary;
  /** Nights of the stay, used for the "每晚" line. */
  nights: number;
  /** Stay parameters, forwarded to the detail page so it can quote live rates. */
  stay: {
    checkIn: string;
    checkOut: string;
    rooms: number;
    adults: number;
    childAges: number[];
  };
  className?: string;
}

function hotelHref(
  hotel: HotelSummary,
  stay: HotelCardProps['stay'],
): string {
  const params = new URLSearchParams();
  params.set('checkIn', stay.checkIn);
  params.set('checkOut', stay.checkOut);
  params.set('rooms', String(stay.rooms));
  params.set('adults', String(stay.adults));
  if (stay.childAges.length > 0) params.set('childAges', stay.childAges.join(','));
  return `/hotels/${encodeURIComponent(hotel.slug || hotel.id)}?${params.toString()}`;
}

export function HotelCard({ hotel, nights, stay, className }: HotelCardProps) {
  const href = hotelHref(hotel, stay);
  const address = formatAddress(hotel.address);
  const nightly = hotel.lowestNightlyTotal;
  const stayTotal = hotel.lowestStayTotal;

  return (
    <article
      className={cn(
        'card group flex flex-col gap-4 p-4 transition hover:border-slate-300 hover:shadow-pop sm:flex-row sm:gap-5 sm:p-5',
        className,
      )}
    >
      <Link
        href={href}
        className="relative block shrink-0 overflow-hidden rounded-lg bg-slate-100 sm:h-40 sm:w-56"
        tabIndex={-1}
        aria-hidden
      >
        <SmartImage
          src={hotel.thumbnail}
          alt=""
          className="h-40 w-full object-cover transition duration-300 group-hover:scale-[1.03] sm:h-full sm:w-full"
          fallbackClassName="flex h-40 w-full items-center justify-center bg-slate-100 text-slate-300 sm:h-full"
          fallback={<Building2 className="h-8 w-8" />}
        />
      </Link>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <StarRating rating={hotel.starRating} />
          {typeof hotel.reviewScore === 'number' ? (
            <span className="rounded bg-brand-50 px-1.5 py-0.5 text-xs font-semibold text-brand-800">
              {hotel.reviewScore.toFixed(1)} 分
            </span>
          ) : null}
          {typeof hotel.reviewCount === 'number' ? (
            <span className="text-xs text-slate-400">{hotel.reviewCount} 条评价</span>
          ) : null}
        </div>

        <h3 className="mt-2 text-lg font-semibold leading-snug text-slate-900">
          <Link href={href} className="transition hover:text-brand-700">
            {hotel.name}
          </Link>
        </h3>

        {address ? (
          <p className="mt-1 flex items-center gap-1.5 text-sm text-slate-500">
            <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {address}
          </p>
        ) : null}

        <div className="mt-auto flex flex-wrap items-end justify-between gap-3 pt-4">
          <div>
            {nightly ? (
              <p className="text-xs text-slate-500">每晚 {formatMoney(nightly)}</p>
            ) : null}
            <p className="text-xs text-slate-500">共 {nights} 晚</p>
          </div>

          <div className="text-right">
            <Money value={stayTotal} size="lg" />
            <p className="mt-0.5 text-xs text-slate-500">含税总价</p>
          </div>
        </div>

        <div className="mt-4">
          <Link href={href} className="btn-secondary w-full sm:w-auto">
            查看房型
          </Link>
        </div>
      </div>
    </article>
  );
}
