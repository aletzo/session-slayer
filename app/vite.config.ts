import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API server picks a free port and writes it here; read it per request because it may start after Vite.
const instanceFile = path.join(process.env.SESSION_SLAYER_DIR ?? path.join(os.homedir(), '.session-slayer'), 'instance.json');
const apiTarget = () => {
  try {
    return `http://127.0.0.1:${JSON.parse(fs.readFileSync(instanceFile, 'utf8')).port}`;
  } catch {
    return 'http://127.0.0.1:45300';
  }
};

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { port: 5173, proxy: {
      '/api': {
        target: 'http://127.0.0.1:45300',
        router: apiTarget,
        // The API server accepts only its own Host and Origin.
        changeOrigin: true,
        configure: (proxy: { on: (e: string, f: (r: { removeHeader: (h: string) => void }) => void) => void }) => proxy.on('proxyReq', (r) => r.removeHeader('origin')),
      },
    } },
  test: { root: '.', include: ['test/**/*.test.ts'], env: { SHELL: 'zsh' } },
} as never);
