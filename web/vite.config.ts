import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // `rock` is a wasm-pack output linked with `file:`. Excluding it from dep
  // pre-bundling keeps the generated `new URL('rock_bg.wasm', import.meta.url)`
  // pointing at the real file instead of an esbuild-rewritten copy.
  optimizeDeps: { exclude: ['rock'] },
});
