import { StatePanel } from '@/components/ui/StatePanel';

export default function MarketLoading() {
  return (
    <main style={{ width: 'calc(100% - 32px)', maxWidth: 960, margin: '48px auto' }}>
      <StatePanel
        message="Loading the market snapshot."
        showMascot={false}
        title="Checking this market…"
      />
    </main>
  );
}
