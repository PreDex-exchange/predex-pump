import type { Metadata } from 'next';

import { CreateScreen } from '@/components/create/CreateScreen';

export const metadata: Metadata = {
  title: 'Create',
};

export default function CreatePage() {
  return <CreateScreen />;
}
