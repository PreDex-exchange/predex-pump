import type { Metadata } from 'next';

import { MarketScreen } from '@/components/market/MarketScreen';

export const metadata: Metadata = {
  title: 'Market',
};

export default async function MarketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <MarketScreen marketId={id} />;
}
