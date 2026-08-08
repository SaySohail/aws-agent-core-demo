'use client';

import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import type { ReactNode } from 'react';

export function Providers({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Theme theme={neutralTheme} mode="system">
      {children}
    </Theme>
  );
}
