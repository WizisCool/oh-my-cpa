import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../global.css';

export const metadata: Metadata = {
  title: 'Oh My CPA Documentation',
  description: 'Self-hosted control plane and usage observability console for CLIProxyAPI v8+.',
  icons: {
    icon: '/docs/favicon.svg',
  },
};

export default function EntryRootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-fd-background text-fd-foreground antialiased">{children}</body>
    </html>
  );
}
