import { defineConfig, type Plugin, type ViteDevServer, type PreviewServer } from 'vite';
import react from '@vitejs/plugin-react';
import { WebSocketServer } from 'ws';
import { attachRoomRelay, MAX_MESSAGE_BYTES } from '../net/signaling-server/relay.mjs';

/**
 * Serve the shared-session signaling relay on this server's own origin, at
 * `/ws`. Same origin is what keeps a share link down to `?j=CODE` — a viewer
 * that can load the page can reach the relay by construction, no address to
 * embed. Production setups serving the built app some other way run
 * `net/signaling-server` standalone instead (and links carry `?s=` for it).
 *
 * Vite's own HMR WebSocket lives on a different path, so only `/ws` upgrades
 * are claimed here.
 */
function signalingRelay(): Plugin {
  const attach = (httpServer: ViteDevServer['httpServer'] | PreviewServer['httpServer']) => {
    if (!httpServer) return;
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    attachRoomRelay(wss);
    httpServer.on('upgrade', (req, socket, head) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '', 'ws://relay').pathname;
      } catch {
        return;
      }
      if (pathname !== '/ws') return;
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  };
  return {
    name: 'qsim-signaling-relay',
    configureServer(server) {
      attach(server.httpServer);
    },
    configurePreviewServer(server) {
      attach(server.httpServer);
    },
  };
}

export default defineConfig({
  plugins: [react(), signalingRelay()],
  // `qsim` is a wasm-pack output linked with `file:`. Excluding it from dep
  // pre-bundling keeps the generated `new URL('qsim_bg.wasm', import.meta.url)`
  // pointing at the real file instead of an esbuild-rewritten copy.
  optimizeDeps: { exclude: ['qsim'] },
  // Listen on the LAN, not just localhost — a share link is for other machines.
  server: { host: true },
  preview: { host: true },
});
