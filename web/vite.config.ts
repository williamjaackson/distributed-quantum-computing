import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // `qsim` is a wasm-pack output linked with `file:`. Excluding it from dep
  // pre-bundling keeps the `?url` import of qsim_bg.wasm pointing at the real
  // file instead of an esbuild-rewritten copy.
  optimizeDeps: { exclude: ['qsim'] },
  worker: { format: 'es' },
});
