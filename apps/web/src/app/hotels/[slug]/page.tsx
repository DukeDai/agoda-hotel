import Link from 'next/link';
import { ArrowLeft, Building2, Clock, Info, MapPin } from 'lucide-react';
import type { AvailabilityResponse, HotelDetail } from '@/lib/api';
import { getAvailability, getHotel } from '@/lib/api';
import { formatDateWithWeekday, formatFullAddress, nightsBetween } from '@/lib/format';
import { parseSearchState } from '@/lib/search-params';
import { HotelGallery } from '@/components/HotelGallery';
import { HotelStayBar } from '@/components/HotelStayBar';
import { RoomOfferCard } from '@/components/RoomOfferCard';
import { StarRating } from '@/components/StarRating';
import { ErrorPanel, friendlyApiMessage } from '@/components/ErrorPanel';

export const dynamic = 'force-dynamic';

interface HotelPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function HotelPage({ params, searchParams }: HotelPageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const state = parseSearchState(query);

  const stay = {
    checkIn: state.checkIn,
    checkOut: state.checkOut,
    rooms: state.rooms,
    adults: state.adults,
    childAges: state.childAges,
    currency: state.currency,
    nationality: state.nationality,
  };

  const [detailResult, availabilityResult] = await Promise.allSettled([
    getHotel(slug),
    getAvailability(slug, stay),
  ]);

  if (detailResult.status === 'rejected') {
    const { title, message, code } = friendlyApiMessage(detailResult.reason);
    return (
      <div className="container-page py-16">
        <Link href="/search" className="btn-ghost -ml-3 mb-6">
          <ArrowLeft className="h-4 w-4" aria-hidden />
          返回搜索结果
        </Link>
        <ErrorPanel
          variant={code === 'NETWORK_ERROR' ? 'offline' : 'error'}
          title={title}
          message={message}
          code={code}
          action={
            <Link href="/search" className="btn-secondary">
              重新搜索酒店
            </Link>
          }
        />
      </div>
    );
  }

  const detail: HotelDetail = detailResult.value;
  const nights = nightsBetween(stay.checkIn, stay.checkOut);

  const availability: AvailabilityResponse | null =
    availabilityResult.status === 'fulfilled' ? availabilityResult.value : null;
  const availabilityError =
    availabilityResult.status === 'rejected' ? friendlyApiMessage(availabilityResult.reason) : null;

  const quotes = availability?.quotes ?? [];
  const roomTypeMap = new Map((detail.roomTypes ?? []).map((roomType) => [roomType.id, roomType]));

  const amenityGroups = new Map<string, string[]>();
  for (const amenity of detail.amenities ?? []) {
    const key = amenity.group ?? '酒店设施';
    const list = amenityGroups.get(key) ?? [];
    list.push(amenity.name);
    amenityGroups.set(key, list);
  }

  const thumbnail =
    detail.images?.[0]?.url ??
    detail.roomTypes?.find((roomType) => roomType.imageUrls?.length)?.imageUrls?.[0] ??
    null;

  const checkoutStay = {
    checkIn: stay.checkIn,
    checkOut: stay.checkOut,
    rooms: stay.rooms,
    adults: stay.adults,
    childAges: stay.childAges,
    currency: stay.currency,
    nights,
  };

  return (
    <div className="pb-16">
      <div className="border-b border-slate-200 bg-white">
        <div className="container-page py-6">
          <Link href="/search" className="btn-ghost -ml-3">
            <ArrowLeft className="h-4 w-4" aria-hidden />
            返回搜索结果
          </Link>

          <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-3">
                <StarRating rating={detail.starRating} size="md" />
                <span className="text-xs font-medium text-slate-500">{detail.starRating} 星级酒店</span>
              </div>
              <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-900">{detail.name}</h1>
              <p className="mt-2 flex items-center gap-1.5 text-sm text-slate-500">
                <MapPin className="h-4 w-4 shrink-0" aria-hidden />
                {formatFullAddress(detail.address) || '地址待补充'}
              </p>
            </div>

            <div className="flex flex-wrap gap-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
              <span className="inline-flex items-center gap-1.5 text-slate-600">
                <Clock className="h-4 w-4 text-slate-400" aria-hidden />
                入住 {detail.checkInTime ?? '—'} · 退房 {detail.checkOutTime ?? '—'}
              </span>
              <span className="inline-flex items-center gap-1.5 text-slate-600">
                <Info className="h-4 w-4 text-slate-400" aria-hidden />
                {formatDateWithWeekday(stay.checkIn)} — {formatDateWithWeekday(stay.checkOut)} ·{' '}
                {nights} 晚
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="container-page pt-8">
        <div className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
          <div className="space-y-8">
            <HotelGallery images={detail.images} fallbackThumbnail={thumbnail} alt={detail.name} />

            {detail.description ? (
              <section>
                <h2 className="text-lg font-semibold text-slate-900">酒店介绍</h2>
                <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-slate-600">
                  {detail.description}
                </p>
              </section>
            ) : null}

            {amenityGroups.size > 0 ? (
              <section>
                <h2 className="text-lg font-semibold text-slate-900">设施与服务</h2>
                <div className="mt-4 grid gap-6 sm:grid-cols-2">
                  {[...amenityGroups.entries()].map(([group, items]) => (
                    <div key={group}>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        {group}
                      </p>
                      <ul className="mt-2 space-y-1.5">
                        {items.map((item) => (
                          <li key={item} className="text-sm text-slate-600">
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            ) : null}

            {detail.policies && detail.policies.length > 0 ? (
              <section>
                <h2 className="text-lg font-semibold text-slate-900">酒店政策</h2>
                <ul className="mt-3 space-y-2">
                  {detail.policies.map((policy) => (
                    <li
                      key={policy}
                      className="flex items-start gap-2 rounded-lg bg-amber-50/70 px-3 py-2 text-sm text-amber-900"
                    >
                      <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
                      {policy}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
            <HotelStayBar
              slug={detail.slug || detail.id}
              checkIn={stay.checkIn}
              checkOut={stay.checkOut}
              rooms={stay.rooms}
              adults={stay.adults}
              childAges={stay.childAges}
            />

            <div className="card p-5">
              <h2 className="text-base font-semibold text-slate-900">可订房型</h2>
              {availabilityError ? (
                <div className="mt-3">
                  <ErrorPanel
                    variant={availabilityError.code === 'NETWORK_ERROR' ? 'offline' : 'warning'}
                    title={availabilityError.title}
                    message={availabilityError.message}
                    code={availabilityError.code}
                  />
                </div>
              ) : quotes.length === 0 ? (
                <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center">
                  <Building2 className="mx-auto h-6 w-6 text-slate-300" aria-hidden />
                  <p className="mt-2 text-sm font-medium text-slate-700">所选日期暂无可售房型</p>
                  <p className="mt-1 text-xs text-slate-500">试试更换日期、房间数或人数</p>
                </div>
              ) : (
                <p className="mt-1 text-xs text-slate-500">
                  共 {quotes.length} 个可订报价 · 价格含税，下单前会再次验价
                </p>
              )}
            </div>
          </aside>
        </div>

        <section className="mt-10">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="text-xl font-bold tracking-tight text-slate-900">选择房型</h2>
            {availability ? (
              <p className="text-sm text-slate-500">
                {nights} 晚 · {stay.rooms} 间房 · {stay.adults} 位成人
              </p>
            ) : null}
          </div>

          <div className="mt-5 space-y-4">
            {quotes.map((quote) => (
              <RoomOfferCard
                key={quote.offerId}
                quote={quote}
                roomType={roomTypeMap.get(quote.roomTypeId) ?? null}
                hotel={{
                  id: detail.id,
                  name: detail.name,
                  slug: detail.slug,
                  thumbnail,
                  city: detail.address?.city ?? null,
                }}
                stay={checkoutStay}
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
