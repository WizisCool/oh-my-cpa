import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { resolveApiTarget, resolveBasePath } from '../scripts/api-target.mjs';
import { syncLobeIcons } from '../scripts/sync-lobe-icons.mjs';
import { bundleGraphPlugin } from '../scripts/bundle-graph.mjs';
import { bareBaseRedirectPlugin, devRuntimeConfigPlugin } from '../scripts/dev-base-redirect.mjs';
import { compactEnglishCatalogPlugin } from '../scripts/compact-locales.mjs';

const repoRoot = path.resolve(__dirname, '..');
const devBasePath = resolveBasePath(repoRoot);
const apiPrefix = `${devBasePath}api/`;
const apiProxyPattern = `^${apiPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [
    {
      name: 'sync-lobe-icons',
      enforce: 'pre',
      buildStart() {
        syncLobeIcons({ quiet: true });
      },
    },
    react(),
    bundleGraphPlugin(repoRoot),
    bareBaseRedirectPlugin(),
    devRuntimeConfigPlugin(devBasePath),
    compactEnglishCatalogPlugin(repoRoot),
  ],
  // Development follows OMCPA_BASE_PATH so an existing local environment and the
  // backend agree on the entry, runtime API paths and proxy. New environments use
  // the root. Production output stays relative so Go can embed it at either location.
  base: command === 'serve' ? devBasePath : './',
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // The official renderer mounts its own inspector widget in development builds. It is a
      // third-party overlay in the corner the composer's controls use (and the browser checks
      // click in), so the package resolves to a component that draws nothing; a production build
      // drops the import entirely.
      { find: '@openuidev/devtools', replacement: path.resolve(__dirname, './src/agent/openui/inspectorOff.tsx') },
      {
        find: /^monaco-editor$/,
        replacement: path.resolve(__dirname, './node_modules/monaco-editor/esm/vs/editor/editor.api.js'),
      },
      {
        find: /^monaco-editor\/esm\/vs\/(.*)/,
        replacement: path.resolve(__dirname, './node_modules/monaco-editor/esm/vs/$1'),
      },
    ],
  },
  // The worker imports CommonJS dependencies that the page's entry graph never visits.
  // Prebundle its dependency graph so development workers are as offline-safe as built ones.
  optimizeDeps: {
    // Optimizing the icon import map promotes thousands of lazy icons into shared
    // eager chunks. Keep this ESM map native so a workspace loads only its icons.
    exclude: ['lucide-react/dynamicIconImports.mjs'],
    include: [
      'monaco-yaml > @vscode/l10n',
      'monaco-yaml > jsonc-parser',
      'monaco-yaml > monaco-worker-manager/worker',
      'monaco-yaml > path-browserify',
      'monaco-yaml > prettier/plugins/estree',
      'monaco-yaml > prettier/plugins/yaml',
      'monaco-yaml > prettier/standalone',
      'monaco-yaml > vscode-languageserver-textdocument',
      'monaco-yaml > vscode-languageserver-types',
      'monaco-yaml > vscode-uri',
    ],
  },
  server: {
    port: 5173,
    // Bind all network interfaces (0.0.0.0) so LAN and Tailscale devices can access
    // the dev server, while keeping backend services bound safely to 127.0.0.1.
    host: '0.0.0.0',
    strictPort: true,
    proxy: {
      // A regex rather than the plain prefix '/api', because the dev server's
      // proxy matches string keys by prefix and would otherwise swallow the SPA
      // route '/api-keys'. The API surface is always '/api/<something>' (the Go
      // router hangs every route off '/api/'), so requiring the trailing slash
      // keeps the two apart.
      [apiProxyPattern]: {
        // Follow OMCPA_LISTEN_ADDR so a taken default port only needs a .env
        // change; OMCPA_API_TARGET overrides the resolved address.
        target: resolveApiTarget(repoRoot),
        // Keep the browser's Host so the backend's same-origin check still
        // matches the Origin header on login and other mutating requests.
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: (id, { getModuleInfo }) => {
          // Vite's shared preload helper is called by every `React.lazy` route, so
          // wherever it lands becomes an eager dependency of the entry. Left to
          // Rollup it can be merged into a chart chunk, dragging the whole chart
          // runtime into the entry graph and modulepreloaded it on every route -
          // exactly the eager load the lazy import below is meant to avoid. Pinning
          // it to its own tiny chunk keeps the entry's static graph free of charts.
          if (id.includes('vite/preload-helper')) {
            return 'vendor-preload';
          }
          // The SVG runtime shared by the dashboard and Insights stays lazy (ADR 0106).
          if (id.includes('node_modules/echarts/') || id.includes('node_modules/zrender/')) {
            return 'vendor-echarts';
          }
          // A workspace's dynamic icon directory is one deferred catalog, not thousands
          // of tiny files in the embedded binary. Statically imported console icons stay
          // with their consumers instead of joining that catalog.
          if (id.includes('node_modules/lucide-react/') && getModuleInfo(id)?.dynamicImporters.some(
            (importer) => /lucide-react\/.*dynamicIconImports/.test(importer),
          )) {
            return 'workspace-icons';
          }
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/react-router/') ||
            id.includes('node_modules/react-router-dom/')
          ) {
            return 'vendor-react';
          }
          // Let shared UI and icon modules follow their consumers. A package-wide chunk
          // promotes route-only controls and the Agent's icon catalog into every startup.
          if (id.includes('node_modules/@tanstack/react-query')) {
            return 'vendor-query';
          }
          // A deferred catalog keeps its language's name: the acceptance probes fail one language's
          // chunk by that name, which a shared `index-*` name cannot express.
          if (id.includes('/i18n/locales/zh-Hant/')) {
            return 'zh-Hant';
          }
          if (id.includes('/i18n/locales/ms/')) {
            return 'ms';
          }
        },
      },
    },
  },
}));
