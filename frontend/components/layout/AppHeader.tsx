'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { IndexerLagIndicator } from './IndexerLagIndicator';
import { WalletBar } from './WalletBar';
import styles from './AppHeader.module.css';

const NAV_ITEMS = [
  { href: '/', icon: 'markets', label: 'Markets' },
  { href: '/activity', icon: 'activity', label: 'Activity' },
  { href: '/create', icon: 'create', label: 'Create' },
  { href: '/portfolio', icon: 'portfolio', label: 'Portfolio' },
  { href: '/account', icon: 'account', label: 'Account' },
] as const;

function NavIcon({ icon }: { icon: (typeof NAV_ITEMS)[number]['icon'] }) {
  if (icon === 'markets') {
    return (
      <svg aria-hidden="true" className={styles.navIcon} viewBox="0 0 24 24">
        <path d="M4 19V9l8-5 8 5v10H4Z" />
        <path d="M8 13h8M8 17h5" />
      </svg>
    );
  }
  if (icon === 'activity') {
    return (
      <svg aria-hidden="true" className={styles.navIcon} viewBox="0 0 24 24">
        <path d="M5 18V9M12 18V5M19 18v-6" />
      </svg>
    );
  }
  if (icon === 'create') {
    return (
      <svg aria-hidden="true" className={styles.navIcon} viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8v8M8 12h8" />
      </svg>
    );
  }
  if (icon === 'portfolio') {
    return (
      <svg aria-hidden="true" className={styles.navIcon} viewBox="0 0 24 24">
        <path d="M4 7h16v12H4zM7 7V5h10v2M8 13h8" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" className={styles.navIcon} viewBox="0 0 24 24">
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21c0-4 3-7 7-7s7 3 7 7" />
    </svg>
  );
}

function BrandMark() {
  return (
    <svg aria-hidden="true" className={styles.brandMark} viewBox="0 0 38 38">
      <rect fill="var(--reward)" height="35" rx="12" stroke="var(--ink)" strokeWidth="2.5" width="35" x="1.5" y="1.5" />
      <circle cx="13.5" cy="15.5" fill="var(--ink)" r="2.2" />
      <circle cx="24.5" cy="15.5" fill="var(--ink)" r="2.2" />
      <path d="m15 21 8 0-4 5z" fill="var(--brand)" stroke="var(--ink)" strokeLinejoin="round" strokeWidth="1.5" />
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
            item.href === '/'
              ? pathname === '/' || pathname.startsWith('/market/')
              : pathname.startsWith(item.href);
          return (
            <Link
              aria-current={active ? 'page' : undefined}
              className={`${styles.navLink} ${active ? styles.active : ''}`}
              href={item.href}
              key={item.href}
            >
              <NavIcon icon={item.icon} />
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
