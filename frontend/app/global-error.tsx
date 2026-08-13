'use client';

import Link from 'next/link';

import { Button, buttonClassName } from '@/components/ui/Button';
import { StatePanel } from '@/components/ui/StatePanel';

import './globals.css';
import styles from './route-state.module.css';

interface GlobalErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function GlobalError({ reset }: GlobalErrorProps) {
  return (
    <html lang="en">
      <body className={styles.globalBody}>
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
            message="predex hit a shell-wide error. Retry once, or reopen the feed."
            showMascot={false}
            title="The incubator needs a reset"
          />
        </main>
      </body>
    </html>
  );
}
