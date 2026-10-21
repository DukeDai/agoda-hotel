import Link from 'next/link';
import { ArrowLeft, ArrowRight, SearchX } from 'lucide-react';
import type { HotelSummary, SearchResponse } from '@/lib/api';
import { searchHotels } from '@/lib/api';
import { formatDateWithWeekday, nightsBetween } from '@/lib/format';
import { parseSearchState, searchHref, SORT_OPTIONS, toApiQuery } from '@/lib/search-params';
import { SearchForm } from '@/components/SearchForm';
import { DESTINATIONS } from '@/lib/destinations';
import { HotelCard } from '@/components/HotelCard';
import { ErrorPanel, friendlyApiMessage } from '@/components/ErrorPanel';

export const dynamic = 'force-dynamic';

interface SearchPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Price comparison uses the integer minor units — never float arithmetic. */
function sortHotels(hotels: HotelSummary[], sort: string): HotelSummary[] {
  const copy = [...hotels];
  if (sort === 'recommended') return copy;
  const priceOf = (hotel: HotelSummary) => hotel.lowestStayTotal?.amount ?? Number.MAX_SAFE_INTEGER;
  copy.sort((a, b) => (sort === 'price_asc' ? priceOf(a) - priceOf(b) : priceOf(b) - priceOf(a)));
  return copy;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const params = await searchParams;
  const state = parseSearchState(params);

  if (!state.destination) {
    return (
      <div className="container-page py-16">
        <div className="mx-auto max-w-xl text-center">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">先告诉我们想去哪里</h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            选择目的地与入住日期，我们会实时拉取可售房型与含税价格。
          </p>
        </div>
        <div className="mx-auto mt-8 max-w-3xl">
          <SearchForm />
        </div>
        <div className="mx-auto mt-8 flex max-w-3xl flex-wrap justify-center gap-2">
          {DESTINATIONS.slice(0, 8).map((destination) => (
            <Link
              key={destination.value}
              href={`/search?destination=${encodeURIComponent(destination.value)}`}
              className="rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-sm text-slate-600 transition hover:border-brand-300 hover:text-brand-700"
            >
              {destination.label}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  let result: SearchResponse | null = null;
  let failure: unknown = null;
  try {
    result = await searchHotels(toApiQuery(state));
  } catch (error) {
    failure = error;
  }

  const nights = result?.nights ?? nightsBetween(state.checkIn, state.checkOut);
  const hotels = result ? sortHotels(result.hotels ?? [], state.sort) : [];
  const total = result?.total ?? 0;
  const totalPages = result ? Math.max(1, Math.ceil(total / state.pageSize)) : 1;

  return (
    <div className="pb-16">
      {/* Search summary bar */}
      <div className="border-b border-slate-200 bg-white">
        <div className="container-page py-5">
          <SearchForm
            variant="compact"
            initial={{
              destination: state.destination,
              checkIn: state.checkIn,
              checkOut: state.checkOut,
              rooms: state.rooms,
              adults: state.adults,
              childAges: state.childAges,
            }}
          />
        </div>
      </div>

      <div className="container-page pt-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              {state.destination} 的酒店
            </h1>
            <p className="mt-1.5 text-sm text-slate-500">
              {formatDateWithWeekday(state.checkIn)} — {formatDateWithWeekday(state.checkOut)} ·{' '}
              {nights} 晚 · {state.rooms} 间房 · {state.adults} 位成人
              {state.childAges.length > 0 ? ` · ${state.childAges.length} 位儿童` : ''}
            </p>
          </div>

          {result ? (
            <p className="text-sm text-slate-500">
              共 <span className="font-semibold text-slate-900">{total}</span> 家酒店
            </p>
          ) : null}
        </div>

        {failure ? (
          <div className="mt-8">
            <SearchErrorState error={failure} />
          </div>
        ) : hotels.length === 0 ? (
          <div className="mt-8">
            <EmptyState destination={state.destination} />
          </div>
        ) : (
          <>
            {/* Sort */}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-y border-slate-200 py-3">
              <p className="text-sm text-slate-500">按当前页排序</p>
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
                {SORT_OPTIONS.map((option) => {
                  const active = option.value === state.sort;
                  return (
                    <Link
                      key={option.value}
                      href={searchHref(state, { sort: option.value, page: 1 })}
                      className={
                        active
                          ? 'rounded-md bg-white px-3 py-1.5 text-sm font-semibold text-slate-900 shadow-sm'
                          : 'rounded-md px-3 py-1.5 text-sm font-medium text-slate-600 transition hover:text-slate-900'
                      }
                    >
                      {option.label}
                    </Link>
                  );
                })}
              </div>
            </div>

            <div className="mt-6 space-y-4">
              {hotels.map((hotel) => (
                <HotelCard
                  key={hotel.id}
                  hotel={hotel}
                  nights={nights}
                  stay={{
                    checkIn: state.checkIn,
                    checkOut: state.checkOut,
                    rooms: state.rooms,
                    adults: state.adults,
                    childAges: state.childAges,
                  }}
                />
              ))}
            </div>

            {totalPages > 1 ? (
              <nav className="mt-8 flex items-center justify-between gap-4" aria-label="分页">
                {state.page > 1 ? (
                  <Link
                    href={searchHref(state, { page: state.page - 1 })}
                    className="btn-secondary"
                  >
                    <ArrowLeft className="h-4 w-4" aria-hidden />
                    上一页
                  </Link>
                ) : (
                  <span className="btn-secondary pointer-events-none opacity-40">
                    <ArrowLeft className="h-4 w-4" aria-hidden />
                    上一页
                  </span>
                )}

                <p className="text-sm text-slate-500">
                  第 {state.page} / {totalPages} 页
                </p>

                {state.page < totalPages ? (
                  <Link href={searchHref(state, { page: state.page + 1 })} className="btn-secondary">
                    下一页
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </Link>
                ) : (
                  <span className="btn-secondary pointer-events-none opacity-40">
                    下一页
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </span>
                )}
              </nav>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

function SearchErrorState({ error }: { error: unknown }) {
  const { title, message, code } = friendlyApiMessage(error);
  const isOffline = code === 'NETWORK_ERROR';

  return (
    <ErrorPanel
      variant={isOffline ? 'offline' : 'error'}
      title={title}
      message={message}
      code={code}
      action={
        <Link href="/search" className="btn-secondary">
          重新搜索
        </Link>
      }
    />
  );
}

function EmptyState({ destination }: { destination: string }) {
  return (
    <div className="card px-6 py-14 text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
        <SearchX className="h-6 w-6" aria-hidden />
      </span>
      <h2 className="mt-4 text-lg font-semibold text-slate-900">
        没有找到「{destination}」的可用酒店
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-600">
        可能是日期区间内暂无库存，或目的地名称需要使用英文城市名。试试调整日期，或从下方热门城市开始。
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {DESTINATIONS.slice(0, 8).map((item) => (
          <Link
            key={item.value}
            href={`/search?destination=${encodeURIComponent(item.value)}`}
            className="rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-sm text-slate-600 transition hover:border-brand-300 hover:text-brand-700"
          >
            {item.label}
          </Link>
        ))}
      </div>
    </div>
  );
}
