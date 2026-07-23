import type { Metadata } from 'next';

import { PortfolioScreen } from '@/components/portfolio/PortfolioScreen';

export const metadata: Metadata = {
  title: 'Portfolio',
};

export default function PortfolioPage() {
  return <PortfolioScreen />;
}
