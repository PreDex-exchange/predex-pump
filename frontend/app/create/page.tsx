import type { Metadata } from 'next';

import { CreateScreen } from '@/components/scaffold/CreateScreen';

export const metadata: Metadata = {
  title: 'Create',
};

export default function CreatePage() {
  return <CreateScreen />;
}
