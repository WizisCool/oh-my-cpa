import { fencedDocument } from '../../agent/htmlDocument';
import styles from './SandboxedDocument.module.css';

export interface SandboxedDocumentProps {
  /** The document as the model wrote it. */
  document: string;
  /** What the frame holds, for a reader who cannot see it. */
  title: string;
  /** The frame's height: a number of pixels, or any CSS length. */
  height?: number | string;
  testID?: string;
}

/**
 * A document the model wrote, drawn where the answer is.
 *
 * It is a frame rather than markup in the page because the page is the console: rendered as
 * markup, a document's styles would restyle the conversation around it, and its script would run
 * with the operator's session. The frame is the boundary - an opaque origin, since it is not given
 * `allow-same-origin` - and `fencedDocument` is what it is allowed to reach.
 */
export function SandboxedDocument({ document, title, height = 420, testID = 'sandboxed-document' }: SandboxedDocumentProps) {
  return (
    <iframe
      className={styles['frame']}
      style={{ height }}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={fencedDocument(document)}
      data-testid={testID}
    />
  );
}
