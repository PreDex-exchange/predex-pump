import type { Metadata } from 'next';

import { AccountScreen } from '@/components/account/AccountScreen';

export const metadata: Metadata = {
  title: 'Account',
  description: 'Your optional predex profile, watchlist, and indexed track record.',
};

export default function AccountPage() {
  return <AccountScreen />;
}
