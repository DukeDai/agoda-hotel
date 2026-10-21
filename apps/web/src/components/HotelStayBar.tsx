'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { RefreshCw, Users } from 'lucide-react';
import { addDays } from '@/lib/format';

export interface HotelStayBarProps {
  slug: string;
  checkIn: string;
  checkOut: string;
  rooms: number;
  adults: number;
  childAges: number[];
}

/** Lets the customer change dates / occupancy and reload the live quotes. */
export function HotelStayBar({
  slug,
  checkIn,
  checkOut,
  rooms,
  adults,
  childAges,
}: HotelStayBarProps) {
  const router = useRouter();
  const [localCheckIn, setLocalCheckIn] = useState(checkIn);
  const [localCheckOut, setLocalCheckOut] = useState(checkOut);
  const [localRooms, setLocalRooms] = useState(rooms);
  const [localAdults, setLocalAdults] = useState(adults);

  function apply() {
    const params = new URLSearchParams();
    params.set('checkIn', localCheckIn);
    params.set('checkOut', localCheckOut);
    params.set('rooms', String(localRooms));
    params.set('adults', String(localAdults));
    if (childAges.length > 0) params.set('childAges', childAges.join(','));
    router.push(`/hotels/${encodeURIComponent(slug)}?${params.toString()}`);
  }

  const fieldClass =
    'h-10 w-full rounded-lg border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-brand-600 focus:ring-2 focus:ring-brand-600/15';

  return (
    <div className="card p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="field-label" htmlFor="stay-check-in">
            入住
          </label>
          <input
            id="stay-check-in"
            type="date"
            value={localCheckIn}
            onChange={(event) => {
              setLocalCheckIn(event.target.value);
              if (event.target.value && localCheckOut <= event.target.value) {
                setLocalCheckOut(addDays(event.target.value, 1));
              }
            }}
            className={fieldClass}
          />
        </div>

        <div>
          <label className="field-label" htmlFor="stay-check-out">
            离店
          </label>
          <input
            id="stay-check-out"
            type="date"
            value={localCheckOut}
            min={localCheckIn}
            onChange={(event) => setLocalCheckOut(event.target.value)}
            className={fieldClass}
          />
        </div>

        <div>
          <label className="field-label" htmlFor="stay-rooms">
            房间
          </label>
          <select
            id="stay-rooms"
            value={localRooms}
            onChange={(event) => setLocalRooms(Number(event.target.value))}
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
          <label className="field-label" htmlFor="stay-adults">
            成人
          </label>
          <div className="relative">
            <Users
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden
            />
            <select
              id="stay-adults"
              value={localAdults}
              onChange={(event) => setLocalAdults(Number(event.target.value))}
              className={`${fieldClass} pl-8`}
            >
              {[1, 2, 3, 4, 5, 6].map((count) => (
                <option key={count} value={count}>
                  {count} 位
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <button type="button" onClick={apply} className="btn-primary mt-3 w-full">
        <RefreshCw className="h-4 w-4" aria-hidden />
        更新房型
      </button>
    </div>
  );
}
