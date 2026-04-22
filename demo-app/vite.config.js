import { defineConfig } from 'vite';

/**
 * `base` for asset URLs:
 * - Local dev + Capacitor: `./` (default) — relative paths inside `dist/`.
 * - GitHub project pages: `/repo-name/` — set `VITE_BASE_PATH=/repo-name`
 *   (leading slash required; trailing slash optional).
 */
function resolveBase() {
  const raw = process.env.VITE_BASE_PATH?.trim();
  if (!raw) return './';
  let p = raw.startsWith('/') ? raw : `/${raw}`;
  if (!p.endsWith('/')) p += '/';
  return p;
}

export default defineConfig({
  root: '.',
  base: resolveBase(),
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
});
