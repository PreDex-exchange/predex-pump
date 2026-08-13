import { StatePanel } from '@/components/ui/StatePanel';

export default function Loading() {
  return (
    <main style={{ width: 'calc(100% - 32px)', maxWidth: 1300, margin: '48px auto' }}>
      <StatePanel
        message="The incubator is getting everything ready."
        showMascot={false}
        title="Warming the nest…"
      />
    </main>
  );
}
