import Link from 'next/link';

export default function DocsEntryPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center px-6 py-16 text-center">
      <script
        dangerouslySetInnerHTML={{
          __html: `
            (function () {
              try {
                var saved = localStorage.getItem('omc-docs-locale');
                var lang = saved === 'zh' || saved === 'en'
                  ? saved
                  : ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');
                location.replace('/docs/' + lang + '/');
              } catch (e) {
                location.replace('/docs/en/');
              }
            })();
          `,
        }}
      />
      <noscript>
        <meta httpEquiv="refresh" content="0;url=/docs/en/" />
      </noscript>
      <h1 className="text-2xl font-semibold tracking-tight">Oh My CPA Documentation</h1>
      <p className="mt-2 text-sm text-fd-muted-foreground">
        Choose a documentation language to continue.
      </p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <Link
          href="/en"
          className="rounded-lg bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground"
        >
          English
        </Link>
        <Link
          href="/zh"
          className="rounded-lg border border-fd-border bg-fd-card px-4 py-2 text-sm font-medium text-fd-foreground"
        >
          简体中文
        </Link>
      </div>
    </main>
  );
}
