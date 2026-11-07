import React from 'react';
import { createLowlight } from 'lowlight';
import type { LanguageFn } from 'highlight.js';
import styles from './CodeBody.module.css';

/**
 * The languages the console highlights, keyed by every fence name a model or a page writes.
 *
 * The value is a highlight.js language id. A name outside this map is not highlighted at all:
 * the grammar is loaded from its own chunk, so an arbitrary fence would be a network and CPU cost
 * for a language nobody asked for, and the block reads as monospaced text either way.
 */
const LANGUAGES: Record<string, string> = {
  json: 'json', jsonc: 'json',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  yaml: 'yaml', yml: 'yaml',
  javascript: 'javascript', js: 'javascript', mjs: 'javascript', jsx: 'javascript',
  typescript: 'typescript', ts: 'typescript', tsx: 'typescript',
  python: 'python', py: 'python',
  go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust',
  java: 'java',
  sql: 'sql',
  diff: 'diff', patch: 'diff',
  markdown: 'markdown', md: 'markdown',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  css: 'css',
  http: 'http',
  // highlight.js has no TOML grammar; its INI grammar reads the same key/value shape.
  toml: 'ini',
  ini: 'ini',
  dockerfile: 'dockerfile', docker: 'dockerfile',
};

/** One loader per grammar, so Vite gives each language its own chunk. */
const LOADERS: Record<string, () => Promise<{ default: LanguageFn }>> = {
  json: () => import('highlight.js/lib/languages/json'),
  bash: () => import('highlight.js/lib/languages/bash'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'),
  go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'),
  java: () => import('highlight.js/lib/languages/java'),
  sql: () => import('highlight.js/lib/languages/sql'),
  diff: () => import('highlight.js/lib/languages/diff'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  xml: () => import('highlight.js/lib/languages/xml'),
  css: () => import('highlight.js/lib/languages/css'),
  http: () => import('highlight.js/lib/languages/http'),
  ini: () => import('highlight.js/lib/languages/ini'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
};

/**
 * Grammars a document embeds. An HTML page's `<style>` and `<script>` are only highlighted when
 * those grammars are registered, so a page brings them along.
 */
const EMBEDDED: Record<string, readonly string[]> = { xml: ['css', 'javascript'] };

/** The grammar a fence name means, or an empty string for text the console leaves plain. */
export function languageOf(lang: string | undefined): string {
  return LANGUAGES[(lang ?? '').trim().toLowerCase()] ?? '';
}

/** The one tokenizer the console shares; grammars are registered into it as they load. */
const lowlight = createLowlight();
const loading = new Map<string, Promise<boolean>>();

function loadOne(id: string): Promise<boolean> {
  if (lowlight.registered(id)) return Promise.resolve(true);
  const started = loading.get(id);
  if (started) return started;
  const load = LOADERS[id];
  if (!load) return Promise.resolve(false);
  const pending = load()
    .then(module => {
      lowlight.register({ [id]: module.default });
      return true;
    })
    .catch(() => {
      // A grammar that failed to load leaves its code as plain text; a transcript does not fail.
      loading.delete(id);
      return false;
    });
  loading.set(id, pending);
  return pending;
}

/** Loads a grammar and anything it embeds, and reports whether the code can be highlighted. */
async function loadLanguage(id: string): Promise<boolean> {
  const ids = [id, ...(EMBEDDED[id] ?? [])];
  const loaded = await Promise.all(ids.map(loadOne));
  return loaded.every(Boolean);
}

/** The tree lowlight produces: text and elements carrying `hljs-` classes, nothing else. */
interface HighlightNode {
  type: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HighlightNode[];
}

function renderNodes(nodes: readonly HighlightNode[]): React.ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.value;
    if (node.type !== 'element' || !node.children) return null;
    const classes = node.properties?.className;
    return (
      <span key={index} className={Array.isArray(classes) ? classes.join(' ') : undefined}>
        {renderNodes(node.children)}
      </span>
    );
  });
}

export interface CodeBodyProps {
  code: string;
  /** The fence's language, as the model or the page wrote it. */
  lang?: string;
  /** True while the code is still arriving, so it is not tokenised on every publish tick. */
  isStreaming?: boolean;
}

/**
 * A block of code as the console draws it: tokenised by highlight.js, styled by the console's own
 * palette, and plain monospaced text when its language has no grammar.
 *
 * This is the one place the console highlights code, so a fenced block in an answer, a call's
 * arguments and a page the model drew all read the same. highlight.js owns the tokenising and the
 * class names (`hljs-*`); the console owns the frame, the type and the colours.
 *
 * A block still arriving stays plain: a grammar re-tokenises the whole block on every change, and a
 * block that grows a line at a time would otherwise be highlighted on every publish tick for text
 * the reader cannot use yet.
 */
export function CodeBody({ code, lang, isStreaming = false }: CodeBodyProps) {
  const id = isStreaming ? '' : languageOf(lang);
  const [tree, setTree] = React.useState<readonly HighlightNode[] | null>(null);
  React.useEffect(() => {
    setTree(null);
    if (!id) return undefined;
    let cancelled = false;
    void loadLanguage(id).then(ready => {
      if (cancelled || !ready) return;
      try {
        const root = lowlight.highlight(id, code) as unknown as { children: HighlightNode[] };
        setTree(root.children);
      } catch {
        // A grammar that refuses the input leaves the code as text.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [id, code]);
  return (
    <pre className={styles['code-body']}>
      <code>{tree ? renderNodes(tree) : code}</code>
    </pre>
  );
}
