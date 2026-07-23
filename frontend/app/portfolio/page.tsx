import type { Metadata } from 'next';

import { PortfolioScreen } from '@/components/scaffold/PortfolioScreen';

export const metadata: Metadata = {
  title: 'Portfolio',
};

export default function PortfolioPage() {
  return <PortfolioScreen />;
}
