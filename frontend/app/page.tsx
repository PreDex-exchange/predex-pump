import type { Metadata } from 'next';

import { FeedScreen } from '@/components/feed/FeedScreen';

export const metadata: Metadata = {
  title: 'Feed',
};

export default function FeedPage() {
  return <FeedScreen />;
}
