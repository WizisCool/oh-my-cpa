import React from 'react';
import XMarkdown from '@ant-design/x-markdown';
import { Button } from 'antd';
import { clsx } from 'clsx';
import { safeMarkdownComponents } from '../common/safeMarkdownComponents';
import { CodeBody } from '../common/CodeBody';
import { CodeFrame } from '../common/CodeFrame';
import { SandboxedDocument } from '../common/SandboxedDocument';
import { CodeOutlined, EyeOutlined } from '../icons';
import { useI18n } from '../../i18n';
import { isHTMLDocument } from '../../agent/htmlDocument';
import styles from './Workspace.module.css';

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
 * A whole HTML or SVG document is also a page, so it offers the page: the model sometimes answers
 * with the document as text instead of calling `present_html`, and the drawing is what was asked
 * for. It stays code until the reader asks, so a transcript is not changed by what it contains.
 */
export function CodeBlock({ lang, children, streamStatus }: CodeProps) {
  const { t } = useI18n();
  const [showsPage, setShowsPage] = React.useState(false);
  const code = textOf(children).replace(/\n$/, '');
  const name = (lang ?? '').trim().toLowerCase();
  const isDocument = streamStatus !== 'loading' && (name === '' || name === 'html' || name === 'htm' || name === 'svg') && isHTMLDocument(code);
  return (
    <CodeFrame
      code={code}
      label={name || 'text'}
      className={styles['code-block']}
      actions={isDocument && (
        <Button
          size="small"
          type="text"
          icon={showsPage ? <CodeOutlined /> : <EyeOutlined />}
          onClick={() => setShowsPage(page => !page)}
          data-testid="markdown-document-view"
        >
          {showsPage ? t('agent.html.code') : t('agent.html.preview')}
        </Button>
      )}
    >
      {showsPage ? (
        <SandboxedDocument document={code} title={t('agent.html.frame_title')} />
      ) : (
        <CodeBody code={code} lang={name} isStreaming={streamStatus === 'loading'} />
      )}
    </CodeFrame>
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

function StreamCaret() {
  return <span className={styles['stream-caret']} aria-hidden="true" />;
}

const STREAM_TAIL = { component: StreamCaret };

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
  // Arriving text fades in and a caret marks where the next words land. Both are tied
  // to the stream: with the animation left on, a stored answer would fade in as one block on mount.
  const streaming = React.useMemo(() => ({
    hasNextChunk: isStreaming,
    enableAnimation: isStreaming,
    tail: isStreaming ? STREAM_TAIL : false,
  }), [isStreaming]);
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
