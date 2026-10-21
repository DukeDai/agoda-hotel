import type { SearchQuery } from './api';
import { addDays, todayIso } from './format';

export type SortKey = 'recommended' | 'price_asc' | 'price_desc';

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'recommended', label: '推荐' },
  { value: 'price_asc', label: '价格低 → 高' },
  { value: 'price_desc', label: '价格高 → 低' },
];

export const DEFAULT_PAGE_SIZE = 10;

export interface SearchState {
  destination: string;
  checkIn: string;
  checkOut: string;
  rooms: number;
  adults: number;
  childAges: number[];
  currency: string;
  nationality: string;
  page: number;
  pageSize: number;
  sort: SortKey;
}

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toChildAges(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((age) => Number.isFinite(age) && age >= 0 && age <= 17);
}

export function defaultStayDates(): { checkIn: string; checkOut: string } {
  const today = todayIso();
  return { checkIn: addDays(today, 7), checkOut: addDays(today, 9) };
}

/** Parse the `/search` query string into a validated state object. */
export function parseSearchState(params: RawParams): SearchState {
  const fallback = defaultStayDates();
  const sortRaw = first(params.sort);
  const sort: SortKey =
    sortRaw === 'price_asc' || sortRaw === 'price_desc' ? sortRaw : 'recommended';

  return {
    destination: (first(params.destination) ?? '').trim(),
    checkIn: first(params.checkIn) ?? fallback.checkIn,
    checkOut: first(params.checkOut) ?? fallback.checkOut,
    rooms: Math.min(5, Math.max(1, toInt(first(params.rooms), 1))),
    adults: Math.min(6, Math.max(1, toInt(first(params.adults), 2))),
    childAges: toChildAges(first(params.childAges)),
    currency: first(params.currency) ?? 'CNY',
    nationality: first(params.nationality) ?? 'CN',
    page: Math.max(1, toInt(first(params.page), 1)),
    pageSize: DEFAULT_PAGE_SIZE,
    sort,
  };
}

/** Build a `/search` href that keeps every parameter except the overrides. */
export function searchHref(
  state: SearchState,
  overrides: Partial<Pick<SearchState, 'page' | 'sort'>> = {},
): string {
  const params = new URLSearchParams();
  params.set('destination', state.destination);
  params.set('checkIn', state.checkIn);
  params.set('checkOut', state.checkOut);
  params.set('rooms', String(state.rooms));
  params.set('adults', String(state.adults));
  if (state.childAges.length > 0) params.set('childAges', state.childAges.join(','));
  params.set('currency', state.currency);
  params.set('nationality', state.nationality);
  params.set('page', String(overrides.page ?? state.page));
  if (overrides.sort ?? state.sort) {
    params.set('sort', overrides.sort ?? state.sort);
  }
  return `/search?${params.toString()}`;
}

/** Map the page state onto the API's search query. */
export function toApiQuery(state: SearchState): SearchQuery {
  return {
    destination: state.destination,
    checkIn: state.checkIn,
    checkOut: state.checkOut,
    rooms: state.rooms,
    adults: state.adults,
    childAges: state.childAges,
    currency: state.currency,
    nationality: state.nationality,
    page: state.page,
    pageSize: state.pageSize,
  };
}
