import Link from 'next/link';
import { parseCheckoutState, CHECKOUT_PARAM } from '@/lib/checkout-state';
import { CheckoutClient } from '@/components/CheckoutClient';
import { ErrorPanel } from '@/components/ErrorPanel';

export const dynamic = 'force-dynamic';

interface CheckoutPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function CheckoutPage({ searchParams }: CheckoutPageProps) {
  const params = await searchParams;
  const raw = params[CHECKOUT_PARAM];
  const state = parseCheckoutState(typeof raw === 'string' ? raw : undefined);

  if (!state) {
    return (
      <div className="container-page py-16">
        <ErrorPanel
          variant="warning"
          title="没有找到所选房型"
          message="结算链接已失效或信息不完整，请返回酒店页面重新选择房型后再下单。"
          action={
            <Link href="/search" className="btn-secondary">
              返回搜索酒店
            </Link>
          }
        />
      </div>
    );
  }

  return <CheckoutClient state={state} />;
}
