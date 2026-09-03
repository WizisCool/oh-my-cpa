import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [react()],
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
    // Use a deterministic loopback address across platforms and fail clearly
    // instead of silently selecting a different port.
    host: '127.0.0.1',
    strictPort: true,
    proxy: {
      '/omc/api': {
        target: 'http://127.0.0.1:8080',
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
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-antd': ['antd', '@ant-design/icons'],
          'vendor-query': ['@tanstack/react-query'],
        },
      },
    },
  },
}));
