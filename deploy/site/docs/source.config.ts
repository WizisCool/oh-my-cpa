import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { pageSchema } from 'fumadocs-core/source/schema';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    // `source` is the canonical repository file a page is synced from.
    schema: pageSchema.extend({ source: pageSchema.shape.title.optional() }),
  },
});

export default defineConfig();
