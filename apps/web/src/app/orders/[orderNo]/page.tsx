import { OrderTracker } from '@/components/OrderTracker';

export const dynamic = 'force-dynamic';

interface OrderPageProps {
  params: Promise<{ orderNo: string }>;
}

export default async function OrderPage({ params }: OrderPageProps) {
  const { orderNo } = await params;
  return <OrderTracker orderNo={decodeURIComponent(orderNo)} />;
}
