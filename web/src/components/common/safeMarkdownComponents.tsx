
/**
 * safeMarkdownComponents builds the external-image suppression both model-output renderers
 * share.
 *
 * A model's answer and its reasoning are the same untrusted input from two channels, so they
 * get the same treatment: `openLinksInNewTab` keeps navigation out of the page, and an image
 * is rendered as a link rather than fetched. Without the second part a reply - or a reasoning
 * block - could make the operator's browser issue a request to any host the model chose,
 * which is a tracking pixel with extra steps and a reason the acceptance probe asserts that no
 * external origin is contacted at all.
 *
 * The label comes from the caller because it is user-visible copy, and copy belongs in the
 * dictionary rather than in a component.
 */
export function safeMarkdownComponents(externalImageLabel: string) {
  return {
    a: ({ href, children, domNode: _d, streamStatus: _s, ...props }: any) => (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
        {children}
      </a>
    ),
    img: ({ src, alt, domNode: _d, streamStatus: _s }: any) => (
      <a href={src} target="_blank" rel="noopener noreferrer">
        {alt ?? externalImageLabel}
      </a>
    ),
  };
}

