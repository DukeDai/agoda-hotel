import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { SiteHeader } from '@/components/SiteHeader';
import { SiteFooter } from '@/components/SiteFooter';

export const metadata: Metadata = {
  title: {
    default: '栖岸酒店 · 全球酒店直连预订',
    template: '%s · 栖岸酒店',
  },
  description:
    '直连全球酒店库存，实时房量与可核验价格，搜索酒店、查看房型报价、在线下单支付并追踪订单状态。',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="flex min-h-screen flex-col bg-slate-50">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
