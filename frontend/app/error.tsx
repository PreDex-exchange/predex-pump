'use client';

import Link from 'next/link';

import { Button, buttonClassName } from '@/components/ui/Button';
import { StatePanel } from '@/components/ui/StatePanel';

import styles from './route-state.module.css';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function ErrorPage({ reset }: ErrorPageProps) {
  return (
    <main className={styles.page}>
      <StatePanel
        actions={
          <>
            <Button onClick={reset} variant="coral">
              Try again
            </Button>
            <Link className={buttonClassName('neutral')} href="/">
              Return to feed
            </Link>
          </>
        }
        message="predex could not finish opening this page. Retry it, or return to the feed."
        showMascot={false}
        state="error"
        title="Something cracked"
      />
    </main>
  );
}
