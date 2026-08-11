import { StatePanel } from '@/components/ui/StatePanel';

export default function PortfolioLoading() {
  return (
    <main style={{ width: 'calc(100% - 32px)', maxWidth: 960, margin: '48px auto' }}>
      <StatePanel
        message="Loading indexed balances and positions."
        showMascot={false}
        title="Opening your portfolio…"
      />
    </main>
  );
}
