import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { resolveApiTarget } from '../scripts/api-target.mjs';
import { syncLobeIcons } from '../scripts/sync-lobe-icons.mjs';

const repoRoot = path.resolve(__dirname, '..');

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
  ],
  // Development has one browser entry at /omc/; Vite proxies only API calls
  // to Go. Production output stays relative so Go can embed it at any subpath.
  base: command === 'serve' ? '/omc/' : './',
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
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
  server: {
    port: 5173,
    // Bind all network interfaces (0.0.0.0) so LAN and Tailscale devices can access
    // the dev server, while keeping backend services bound safely to 127.0.0.1.
    host: '0.0.0.0',
    strictPort: true,
    proxy: {
      '/omc/api': {
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
        manualChunks: (id) => {
          // Vite's shared preload helper is called by every `React.lazy` route, so
          // wherever it lands becomes an eager dependency of the entry. Left to
          // Rollup it was merged into vendor-charts, which dragged the whole chart
          // runtime into the entry graph and modulepreloaded it on every route -
          // exactly the eager load the lazy import below is meant to avoid. Pinning
          // it to its own tiny chunk keeps the entry's static graph free of charts.
          if (id.includes('vite/preload-helper')) {
            return 'vendor-preload';
          }
          if (
            id.includes('node_modules/@antv/') ||
            id.includes('node_modules/@ant-design/charts') ||
            id.includes('node_modules/@ant-design/plots')
          ) {
            return 'vendor-charts';
          }
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/react-router-dom')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/@ant-design/icons') || id.includes('node_modules/antd')) {
            return 'vendor-antd';
          }
          if (id.includes('node_modules/@tanstack/react-query')) {
            return 'vendor-query';
          }
        },
      },
    },
  },
}));
