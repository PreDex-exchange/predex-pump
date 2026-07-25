'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { IndexerLagIndicator } from './IndexerLagIndicator';
import { WalletBar } from './WalletBar';
import styles from './AppHeader.module.css';

const NAV_ITEMS = [
  { href: '/', label: 'Feed' },
  { href: '/create', label: 'Create' },
  { href: '/portfolio', label: 'Portfolio' },
] as const;

function BrandMark() {
  return (
    <svg aria-hidden="true" className={styles.brandMark} viewBox="0 0 38 38">
      <rect fill="#ffc24b" height="35" rx="12" stroke="#2b2440" strokeWidth="2.5" width="35" x="1.5" y="1.5" />
      <circle cx="13.5" cy="15.5" fill="#2b2440" r="2.2" />
      <circle cx="24.5" cy="15.5" fill="#2b2440" r="2.2" />
      <path d="m15 21 8 0-4 5z" fill="#ff6b57" stroke="#2b2440" strokeLinejoin="round" strokeWidth="1.5" />
    </svg>
  );
}

export function AppHeader() {
  const pathname = usePathname();

  return (
    <header className={styles.header}>
      <Link aria-label="predex feed" className={styles.brand} href="/">
        <BrandMark />
        <span>predex</span>
      </Link>
      <nav aria-label="Primary navigation" className={styles.nav}>
        {NAV_ITEMS.map((item) => {
          const active =
            item.href === '/' ? pathname === '/' || pathname.startsWith('/market/') : pathname.startsWith(item.href);
          return (
            <Link
              aria-current={active ? 'page' : undefined}
              className={`${styles.navLink} ${active ? styles.active : ''}`}
              href={item.href}
              key={item.href}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className={styles.actions}>
        <IndexerLagIndicator />
        <WalletBar />
      </div>
    </header>
  );
}
