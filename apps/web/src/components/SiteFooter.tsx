import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-slate-200 bg-white">
      <div className="container-page py-10">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <p className="text-sm font-bold text-slate-900">栖岸酒店</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-500">
              我们直连全球酒店库存，提供可核验的实时房价与即时确认服务。
              价格、房量与取消政策以下单时的最终确认为准。
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-10 gap-y-2 text-sm">
            <div className="space-y-2">
              <p className="font-semibold text-slate-900">预订</p>
              <Link href="/" className="block text-slate-500 hover:text-brand-700">
                搜索酒店
              </Link>
              <Link href="/search" className="block text-slate-500 hover:text-brand-700">
                热门目的地
              </Link>
            </div>
            <div className="space-y-2">
              <p className="font-semibold text-slate-900">帮助</p>
              <Link href="/orders" className="block text-slate-500 hover:text-brand-700">
                订单查询
              </Link>
              <span className="block text-slate-500">客服 400-800-0000</span>
            </div>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-2 border-t border-slate-100 pt-6 text-xs text-slate-400 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} 栖岸酒店 · 演示项目，非真实交易</p>
          <p>库存与价格数据来源：Agoda Demand API</p>
        </div>
      </div>
    </footer>
  );
}
