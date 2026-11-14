import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  basePath: '/docs',
  trailingSlash: true,
  // `next dev` would otherwise write and keep re-adding an AGENTS.md beside this app.
  agentRules: false,
  images: {
    unoptimized: true,
  },
};

export default withMDX(config);
