import React from 'react';
import XMarkdown from '@ant-design/x-markdown';
import { CodeHighlighter } from '@ant-design/x';
import { clsx } from 'clsx';
import { safeMarkdownComponents } from '../common/safeMarkdownComponents';
import { CopyButton } from './CopyButton';
import styles from './Workspace.module.css';

/**
 * The languages a fenced block is highlighted in, keyed by every name a model commonly writes.
 *
 * An allowlist rather than whatever the fence says: the highlighter loads each grammar as its own
 * chunk named after the fence, so a streaming fence (`js`, then `jso`, then `json`) or a made-up
 * name would each attempt a load. Anything else is shown as plain monospaced text, which is what
 * an unknown language is.
 */
const LANGUAGE_ALIASES: Record<string, string> = {
  json: 'json', jsonc: 'json',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  yaml: 'yaml', yml: 'yaml',
  javascript: 'javascript', js: 'javascript', mjs: 'javascript', jsx: 'jsx',
  typescript: 'typescript', ts: 'typescript', tsx: 'tsx',
  python: 'python', py: 'python',
  go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust',
  java: 'java',
  sql: 'sql',
  diff: 'diff', patch: 'diff',
  markdown: 'markdown', md: 'markdown',
  http: 'http',
  toml: 'toml',
  ini: 'ini',
  dockerfile: 'docker', docker: 'docker',
};

/** Token classes, not inline colours, so the code takes the resolved palette rather than a light theme. */
const HIGHLIGHT_PROPS = { useInlineStyles: false } as const;

interface CodeProps {
  className?: string;
  children?: React.ReactNode;
  lang?: string;
  block?: boolean;
  streamStatus?: 'loading' | 'done';
}

function textOf(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(textOf).join('');
  return children == null ? '' : String(children);
}

/**
 * A fenced block: its language, a copy action, and the code.
 *
 * A block still being streamed is drawn as plain text and highlighted once its fence closes. The
 * grammar re-tokenises the whole block on every change, and a block that grows a line at a time
 * would otherwise be re-highlighted on every publish tick for text the reader cannot use yet.
 */
export function CodeBlock({ lang, children, streamStatus }: CodeProps) {
  const code = textOf(children).replace(/\n$/, '');
  const name = (lang ?? '').trim().toLowerCase();
  const language = streamStatus === 'loading' ? undefined : LANGUAGE_ALIASES[name];
  return (
    <div className={styles['code-block']}>
      <div className={styles['code-head']}>
        <span className={styles['code-lang']}>{name || 'text'}</span>
        <CopyButton text={code} size="small" />
      </div>
      {language ? (
        <CodeHighlighter lang={language} header={false} highlightProps={HIGHLIGHT_PROPS} className={styles['code-body']}>
          {code}
        </CodeHighlighter>
      ) : (
        <pre className={styles['code-body']}><code>{code}</code></pre>
      )}
    </div>
  );
}

function Code(props: CodeProps) {
  if (props.block) return <CodeBlock {...props} />;
  return <code className={clsx(props.className, styles['inline-code'])}>{props.children}</code>;
}

/** The block renderer supplies its own frame, so the parser's `pre` wrapper is dissolved. */
function Pre({ children }: { children?: React.ReactNode }) {
  return <>{children}</>;
}

function Table({ children }: { children?: React.ReactNode }) {
  return <div className={styles['table-scroll']}><table>{children}</table></div>;
}

export interface ModelMarkdownProps {
  content: string;
  /** True while more of this text is still arriving, so an unfinished construct is not drawn as broken. */
  isStreaming?: boolean;
  externalImageLabel: string;
  className?: string;
}

/**
 * Model output, rendered safely: raw HTML is escaped, links open outside the console, and an
 * image is shown as a link rather than fetched (`safeMarkdownComponents`).
 *
 * The library's own element styles are switched off: they draw tables as blocks sized to their
 * content and set type in their own scale, and the console's styles below are the whole look.
 *
 * Memoised on its text, so a transcript that re-renders for a new token re-parses only the answer
 * that changed. The component table is built once per label for the same reason: a new table on
 * every render is a new prop, and a new prop re-parses the document.
 */
export const ModelMarkdown = React.memo(function ModelMarkdown({ content, isStreaming = false, externalImageLabel, className }: ModelMarkdownProps) {
  const components = React.useMemo(() => ({
    ...safeMarkdownComponents(externalImageLabel),
    code: Code,
    pre: Pre,
    table: Table,
  }), [externalImageLabel]);
  const streaming = React.useMemo(() => ({ hasNextChunk: isStreaming }), [isStreaming]);
  return (
    <XMarkdown
      content={content}
      components={components}
      streaming={streaming}
      escapeRawHtml
      openLinksInNewTab
      disableDefaultStyles
      className={clsx(styles['markdown'], className)}
    />
  );
});
