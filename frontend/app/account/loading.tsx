import { StatePanel } from '@/components/ui/StatePanel';

export default function AccountLoading() {
  return (
    <main style={{ width: 'calc(100% - 32px)', maxWidth: 960, margin: '48px auto' }}>
      <StatePanel
        message="Restoring the saved session and account snapshot."
        showMascot={false}
        state="loading"
        title="Opening your account…"
      />
    </main>
  );
}
