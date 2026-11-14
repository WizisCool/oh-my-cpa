import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '../global.css';

export const metadata: Metadata = {
  title: 'Oh My CPA Documentation',
  description: 'Install, operate and extend Oh My CPA, the self-hosted AI gateway console.',
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
