import type { Metadata } from 'next';

import { ActivityScreen } from '@/components/activity/ActivityScreen';

export const metadata: Metadata = {
  title: 'Agent activity',
  description: 'A live, on-chain timeline of human and autonomous market actions.',
};

export default function ActivityPage() {
  return <ActivityScreen />;
}
