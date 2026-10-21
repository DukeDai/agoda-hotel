import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="container-page flex min-h-[60vh] flex-col items-center justify-center py-16 text-center">
      <p className="font-mono text-sm font-semibold text-brand-700">404</p>
      <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">页面不存在</h1>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-600">
        你访问的内容可能已被移动或删除。回到首页重新搜索一次吧。
      </p>
      <Link href="/" className="btn-primary mt-6">
        返回首页
      </Link>
    </div>
  );
}
