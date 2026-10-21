'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin, Search, Users } from 'lucide-react';
import { DESTINATIONS } from '@/lib/destinations';
import { addDays, todayIso } from '@/lib/format';
import { cn } from '@/lib/cn';

export interface SearchFormValues {
  destination: string;
  checkIn: string;
  checkOut: string;
  rooms: number;
  adults: number;
  childAges: number[];
}

const DEFAULT_CHILD_AGE = 5;

export interface SearchFormProps {
  initial?: Partial<SearchFormValues>;
  variant?: 'hero' | 'compact';
  className?: string;
}

export function SearchForm({ initial, variant = 'hero', className }: SearchFormProps) {
  const router = useRouter();

  const [destination, setDestination] = useState(initial?.destination ?? '');
  const [checkIn, setCheckIn] = useState(initial?.checkIn ?? '');
  const [checkOut, setCheckOut] = useState(initial?.checkOut ?? '');
  const [rooms, setRooms] = useState(initial?.rooms ?? 1);
  const [adults, setAdults] = useState(initial?.adults ?? 2);
  const [childAges, setChildAges] = useState<number[]>(initial?.childAges ?? []);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState('');

  // Default dates depend on the browser's local calendar, so they are applied
  // after mount to keep server and client markup identical.
  useEffect(() => {
    const localToday = todayIso();
    setToday(localToday);
    if (!initial?.checkIn && !initial?.checkOut) {
      setCheckIn(addDays(localToday, 7));
      setCheckOut(addDays(localToday, 9));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isHero = variant === 'hero';

  function setChildCount(count: number) {
    setChildAges((previous) => {
      const next = previous.slice(0, count);
      while (next.length < count) next.push(DEFAULT_CHILD_AGE);
      return next;
    });
  }

  function updateChildAge(index: number, value: number) {
    setChildAges((previous) => previous.map((age, i) => (i === index ? value : age)));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!destination.trim()) {
      setError('请选择目的地');
      return;
    }
    if (!checkIn || !checkOut) {
      setError('请选择入住与离店日期');
      return;
    }
    if (checkOut <= checkIn) {
      setError('离店日期必须晚于入住日期');
      return;
    }
    setError(null);

    const params = new URLSearchParams();
    params.set('destination', destination.trim());
    params.set('checkIn', checkIn);
    params.set('checkOut', checkOut);
    params.set('rooms', String(rooms));
    params.set('adults', String(adults));
    if (childAges.length > 0) params.set('childAges', childAges.join(','));
    params.set('currency', 'CNY');
    params.set('nationality', 'CN');

    router.push(`/search?${params.toString()}`);
  }

  const fieldClass = cn(
    'h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition',
    'focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15',
  );

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        isHero
          ? 'card space-y-4 p-5 shadow-pop sm:p-6'
          : 'card grid items-end gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[1.2fr_1.5fr_1.2fr_auto]',
        className,
      )}
      noValidate
    >
      <div className={cn(isHero ? 'space-y-4' : 'contents')}>
        <div>
          <label className="field-label" htmlFor="destination">
            目的地
          </label>
          <div className="relative">
            <MapPin
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <input
              id="destination"
              name="destination"
              list="destination-options"
              autoComplete="off"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder="城市名，例如 Phuket"
              className={cn(fieldClass, 'pl-9')}
            />
            <datalist id="destination-options">
              {DESTINATIONS.map((option) => (
                <option key={option.value} value={option.value} label={option.label} />
              ))}
            </datalist>
          </div>
        </div>

        <div className={cn('grid gap-4', isHero ? 'grid-cols-2' : 'grid-cols-2')}>
          <div>
            <label className="field-label" htmlFor="checkIn">
              入住
            </label>
            <input
              id="checkIn"
              name="checkIn"
              type="date"
              min={today}
              value={checkIn}
              onChange={(event) => {
                setCheckIn(event.target.value);
                if (checkOut && event.target.value && event.target.value >= checkOut) {
                  setCheckOut(addDays(event.target.value, 1));
                }
              }}
              className={fieldClass}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="checkOut">
              离店
            </label>
            <input
              id="checkOut"
              name="checkOut"
              type="date"
              min={checkIn || today}
              value={checkOut}
              onChange={(event) => setCheckOut(event.target.value)}
              className={fieldClass}
            />
          </div>
        </div>

        <div className={cn('grid gap-4', isHero ? 'grid-cols-3' : 'grid-cols-3')}>
          <div>
            <label className="field-label" htmlFor="rooms">
              房间
            </label>
            <select
              id="rooms"
              name="rooms"
              value={rooms}
              onChange={(event) => setRooms(Number(event.target.value))}
              className={fieldClass}
            >
              {[1, 2, 3, 4, 5].map((count) => (
                <option key={count} value={count}>
                  {count} 间
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="adults">
              成人
            </label>
            <select
              id="adults"
              name="adults"
              value={adults}
              onChange={(event) => setAdults(Number(event.target.value))}
              className={fieldClass}
            >
              {[1, 2, 3, 4, 5, 6].map((count) => (
                <option key={count} value={count}>
                  {count} 位
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="children">
              儿童
            </label>
            <select
              id="children"
              name="children"
              value={childAges.length}
              onChange={(event) => setChildCount(Number(event.target.value))}
              className={fieldClass}
            >
              {[0, 1, 2, 3, 4].map((count) => (
                <option key={count} value={count}>
                  {count} 位
                </option>
              ))}
            </select>
          </div>
        </div>

        {childAges.length > 0 ? (
          <div className={cn('rounded-lg bg-slate-50 p-3', !isHero && 'sm:col-span-2 lg:col-span-4')}>
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-600">
              <Users className="h-3.5 w-3.5" aria-hidden />
              请填写儿童年龄（入住时）
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {childAges.map((age, index) => (
                <label key={index} className="block">
                  <span className="sr-only">儿童 {index + 1} 的年龄</span>
                  <input
                    type="number"
                    min={0}
                    max={17}
                    value={age}
                    onChange={(event) =>
                      updateChildAge(index, Math.min(17, Math.max(0, Number(event.target.value))))
                    }
                    className={cn(fieldClass, 'h-10')}
                  />
                  <span className="mt-1 block text-[11px] text-slate-500">儿童 {index + 1} 岁</span>
                </label>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className={cn(isHero ? 'flex flex-col gap-3' : 'flex flex-col justify-end gap-3')}>
        {error ? <p className="field-error">{error}</p> : null}
        <button type="submit" className={cn('btn-primary', isHero ? 'w-full py-3' : 'w-full lg:w-auto')}>
          <Search className="h-4 w-4" aria-hidden />
          搜索酒店
        </button>
      </div>
    </form>
  );
}
