'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';

export default function OrderLookupPage() {
  const router = useRouter();
  const [orderNo, setOrderNo] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = orderNo.trim();
    if (!trimmed) {
      setError('请输入订单号');
      return;
    }
    setError(null);
    router.push(`/orders/${encodeURIComponent(trimmed)}`);
  }

  return (
    <div className="container-page py-16">
      <div className="mx-auto max-w-md">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">查询订单</h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          输入订单号即可查看订单状态、确认号并办理取消。
        </p>

        <form onSubmit={submit} className="card mt-6 space-y-4 p-5" noValidate>
          <div>
            <label className="field-label" htmlFor="orderNo">
              订单号
            </label>
            <input
              id="orderNo"
              value={orderNo}
              onChange={(event) => {
                setOrderNo(event.target.value);
                setError(null);
              }}
              placeholder="OTA-20261020-8F3KQ2"
              className="field-input font-mono"
              autoComplete="off"
            />
            {error ? <p className="field-error">{error}</p> : null}
          </div>
          <button type="submit" className="btn-primary w-full">
            <Search className="h-4 w-4" aria-hidden />
            查询订单
          </button>
        </form>
      </div>
    </div>
  );
}
