import Link from 'next/link';
import { BedDouble, Globe2 } from 'lucide-react';

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="container-page flex h-16 items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-700 text-white">
            <BedDouble className="h-5 w-5" aria-hidden />
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-base font-bold tracking-tight text-slate-900">栖岸酒店</span>
            <span className="text-[11px] font-medium tracking-wide text-slate-500">
              AGODA 精选库存 · 直连预订
            </span>
          </span>
        </Link>

        <nav className="flex items-center gap-1 text-sm font-medium text-slate-600">
          <Link href="/" className="rounded-lg px-3 py-2 transition hover:bg-slate-100 hover:text-slate-900">
            首页
          </Link>
          <Link
            href="/search"
            className="hidden rounded-lg px-3 py-2 transition hover:bg-slate-100 hover:text-slate-900 sm:inline-block"
          >
            找酒店
          </Link>
          <span className="ml-1 hidden items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-600 md:inline-flex">
            <Globe2 className="h-3.5 w-3.5" aria-hidden />
            简体中文 · CNY
          </span>
        </nav>
      </div>
    </header>
  );
}
