import type { Metadata, Viewport } from 'next';
import { DM_Mono, Fredoka, Nunito } from 'next/font/google';
import { headers } from 'next/headers';
import Script from 'next/script';
import type { ReactNode } from 'react';
import { cookieToInitialState } from 'wagmi';

import { AppHeader } from '@/components/layout/AppHeader';
import { TransactionRecoveryNotice } from '@/components/layout/TransactionRecoveryNotice';
import { AppProviders } from '@/components/providers/AppProviders';
import { getWagmiConfig } from '@/lib/chain/config';
import { PWA_COLORS } from '@/lib/pwa/palette';

import './globals.css';

const fredoka = Fredoka({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-fredoka',
  display: 'swap',
});

const nunito = Nunito({
  subsets: ['latin'],
  weight: ['400', '600', '700', '800'],
  variable: '--font-nunito',
  display: 'swap',
});

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-dm-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  applicationName: 'predex',
  title: {
    default: 'predex — Market incubator',
    template: '%s — predex',
  },
  description:
    'Launch a prediction market from zero, trade it on a bonding curve, and watch it graduate into an order book.',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'predex',
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    apple: [
      {
        sizes: '192x192',
        type: 'image/png',
        url: '/pwa/icon-192.png',
      },
    ],
    icon: [
      {
        sizes: '192x192',
        type: 'image/png',
        url: '/pwa/icon-192.png',
      },
      {
        sizes: '512x512',
        type: 'image/png',
        url: '/pwa/icon-512.png',
      },
    ],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: PWA_COLORS.background,
  viewportFit: 'cover',
};

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const initialState = cookieToInitialState(
    getWagmiConfig(),
    (await headers()).get('cookie'),
  );
  // next.config.ts sets this only for `next dev` with the explicit QA flag.
  // The injected-provider implementation is served by the local QA signer and
  // is never imported into (or copied into) the Next production bundle.
  const qaWalletScriptUrl = process.env.PREDEX_QA_WALLET_SCRIPT_URL;

  return (
    <html lang="en">
      <head>
        <meta content="yes" name="apple-mobile-web-app-capable" />
        {qaWalletScriptUrl ? (
          <Script src={qaWalletScriptUrl} strategy="beforeInteractive" />
        ) : null}
      </head>
      <body className={`${fredoka.variable} ${nunito.variable} ${dmMono.variable}`}>
        <AppProviders initialState={initialState}>
          <AppHeader />
          <TransactionRecoveryNotice />
          {children}
        </AppProviders>
      </body>
    </html>
  );
}
