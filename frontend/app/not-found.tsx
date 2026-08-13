import Link from 'next/link';

import { buttonClassName } from '@/components/ui/Button';
import { StatePanel } from '@/components/ui/StatePanel';

import styles from './route-state.module.css';

export default function NotFound() {
  return (
    <main className={styles.page}>
      <StatePanel
        actions={
          <Link className={buttonClassName('coral')} href="/">
            Return to feed
          </Link>
        }
        message="The address does not match a page in this incubator."
        showMascot={false}
        title="That page never hatched"
      />
    </main>
  );
}
