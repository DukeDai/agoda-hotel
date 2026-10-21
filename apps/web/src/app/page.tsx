import Link from 'next/link';
import {
  ArrowUpRight,
  BadgeCheck,
  CalendarCheck,
  Headset,
  Search,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { SearchForm } from '@/components/SearchForm';
import { DESTINATIONS } from '@/lib/destinations';

export const dynamic = 'force-dynamic';

const FEATURES = [
  {
    icon: BadgeCheck,
    title: '直连供应商库存',
    description: '房量与价格来自 Agoda 实时库存接口，所见即所得。',
  },
  {
    icon: CalendarCheck,
    title: '确认状态透明',
    description: '供应商处理中会明确显示「确认中」，只有真正确认后才算预订成功。',
  },
  {
    icon: ShieldCheck,
    title: '取消政策写清楚',
    description: '每个价格都附带免费取消截止日与罚金规则，付款前一目了然。',
  },
  {
    icon: Headset,
    title: '订单全程可追踪',
    description: '从下单、支付到确认、取消，订单状态页 3 秒自动刷新。',
  },
];

const STEPS = [
  { step: '01', title: '搜索目的地', description: '选择城市、入住与离店日期、房间与人数。' },
  { step: '02', title: '挑选房型', description: '对比床型、面积、早餐与取消政策，选定合适报价。' },
  { step: '03', title: '下单并支付', description: '填写入住人信息，验价通过后提交订单并完成支付。' },
];

export default function LandingPage() {
  const popular = DESTINATIONS.slice(0, 8);

  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden bg-brand-950 text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'radial-gradient(circle at 18% 22%, #7fcdc3 0, transparent 42%), radial-gradient(circle at 82% 12%, #4bb2a6 0, transparent 38%)',
          }}
        />
        <div className="container-page relative pb-28 pt-16 sm:pb-32 sm:pt-24">
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-brand-100 ring-1 ring-inset ring-white/15">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              全球直连库存 · 实时报价
            </span>
            <h1 className="mt-5 text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              找到理想酒店，
              <br className="hidden sm:block" />
              价格与房量都看得见
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-brand-100/90 sm:text-lg">
              我们直连全球酒店供应系统，搜索即可看到含税总价、早餐与取消政策。
              下单后订单状态全程可查，确认号第一时间送达。
            </p>
          </div>
        </div>
      </section>

      {/* Search card overlapping the hero */}
      <section className="container-page relative -mt-20 pb-4 sm:-mt-24">
        <SearchForm />
      </section>

      {/* Why us */}
      <section className="container-page py-16 sm:py-20">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold uppercase tracking-wider text-brand-700">为什么选择我们</p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            把预订里最容易出问题的环节说清楚
          </h2>
        </div>

        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="card p-6">
              <span className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
                <feature.icon className="h-5 w-5" aria-hidden />
              </span>
              <h3 className="mt-4 text-base font-semibold text-slate-900">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Steps */}
      <section className="border-y border-slate-200 bg-white">
        <div className="container-page py-16 sm:py-20">
          <div className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-wider text-brand-700">预订流程</p>
              <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
                三步完成预订
              </h2>
              <p className="mt-4 text-sm leading-relaxed text-slate-600">
                每一步都会展示下一步会发生什么，以及当前价格是否仍然有效。
              </p>
            </div>
            <ol className="grid gap-5 sm:grid-cols-3">
              {STEPS.map((item) => (
                <li key={item.step} className="rounded-xl border border-slate-200 bg-slate-50 p-5">
                  <span className="font-mono text-sm font-semibold text-brand-700">{item.step}</span>
                  <h3 className="mt-2 text-base font-semibold text-slate-900">{item.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{item.description}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* Popular destinations */}
      <section className="container-page py-16 sm:py-20">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-brand-700">热门目的地</p>
            <h2 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              大家最近在订这些城市
            </h2>
          </div>
          <Link href="/search" className="btn-secondary">
            <Search className="h-4 w-4" aria-hidden />
            浏览全部房源
          </Link>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {popular.map((destination) => (
            <Link
              key={destination.value}
              href={`/search?destination=${encodeURIComponent(destination.value)}`}
              className="group flex items-center justify-between rounded-xl border border-slate-200 bg-white p-5 transition hover:border-brand-300 hover:bg-brand-50/50"
            >
              <span>
                <span className="block text-base font-semibold text-slate-900 group-hover:text-brand-800">
                  {destination.label.split(' · ')[0]}
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">{destination.value}</span>
              </span>
              <span className="text-slate-300 transition group-hover:text-brand-600">
                <ArrowUpRight className="h-4 w-4" aria-hidden />
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
