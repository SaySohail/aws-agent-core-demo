import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Agent Launchpad',
  description: 'Agent Launchpad operator interface'
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" data-theme="light">
      <body suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
