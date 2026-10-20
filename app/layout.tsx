import type { ReactNode } from 'react';
import './globals.css';

// Pass-through root layout: <html lang> depends on the locale, so the real
// document shell lives in app/[locale]/layout.tsx (and app/page.tsx /
// app/not-found.tsx for the two locale-less pages).
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
