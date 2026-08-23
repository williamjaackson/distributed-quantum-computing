// Top-level wiring for index.html. Everything reusable/testable lives in the
// other src/ modules (see their own file-level comments); this file is just
// the glue between those modules and the DOM, plus the one decision that
// has to happen somewhere: "am I the host or a joined peer?"
import { SignalingClient } from './signaling-client.js';
import { PeerMesh } from './mesh.js';
import { WorkerBridge } from './worker-bridge.js';
import { HostOrchestrator } from './host-orchestrator.js';
import { PeerRuntime } from './peer-runtime.js';

const $ = (id) => document.getElementById(id);
const log = (msg) => {
  const el = $('log');
  el.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
  el.scrollTop = el.scrollHeight;
};

const PRESETS = {
  bell: [{ name: 'h', qubits: [0] }, { name: 'cx', qubits: [0, 1] }],
  ghz4: [
    { name: 'h', qubits: [0] },
    { name: 'cx', qubits: [0, 1] },
    { name: 'cx', qubits: [1, 2] },
    { name: 'cx', qubits: [2, 3] },
  ],
  // 3-qubit QFT: H/controlled-phase decomposition, then the trailing swaps
  // to put outputs back in the usual bit order.
  qft3: [
    { name: 'h', qubits: [0] },
    { name: 'cp', qubits: [1, 0], params: [Math.PI / 2] },
    { name: 'cp', qubits: [2, 0], params: [Math.PI / 4] },
    { name: 'h', qubits: [1] },
    { name: 'cp', qubits: [2, 1], params: [Math.PI / 2] },
    { name: 'h', qubits: [2] },
    { name: 'swap', qubits: [0, 2] },
  ],
};

async function makeLocalEngine() {
  const worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
  const bridge = new WorkerBridge(worker);
  const info = await bridge.call('init-wasm', {});
  return { bridge, info };
}

function renderHistogram(histogram, nQubits) {
  const rows = [...histogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, 32);
  const total = [...histogram.values()].reduce((a, b) => a + b, 0);
  const width = Math.max(1, nQubits ?? Math.ceil(Math.log2(Math.max(...rows.map(([i]) => i), 1) + 1)));
  return rows
    .map(([index, count]) => {
      const bits = index.toString(2).padStart(width, '0');
      const pct = ((count / total) * 100).toFixed(1);
      const bar = '#'.repeat(Math.max(1, Math.round((count / total) * 40)));
      return `|${bits}>  ${String(count).padStart(8)}  ${pct.padStart(5)}%  ${bar}`;
    })
    .join('\n');
}

function parseCircuit(text) {
  const circuit = JSON.parse(text);
  if (!Array.isArray(circuit)) throw new Error('circuit must be a JSON array of {name, qubits, params?}');
  return circuit;
}

async function main() {
  // A shared room link carries the signaling server address as `?signal=`
  // specifically so a joining machine doesn't need to already know it (see
  // where the link is built below) — read it back out here, before anything
  // else uses `signalUrl`'s value, or a joining machine would silently fall
  // back to the field's default (localhost) and never reach the host.
  const params = new URLSearchParams(location.search);
  if (params.get('signal')) {
    $('signalUrl').value = params.get('signal');
  } else if (!$('signalUrl').value || $('signalUrl').value === 'ws://localhost:8787') {
    // Default to whatever host this page itself was loaded from (same port
    // the signaling server listens on by default). This is what makes
    // opening the page via a LAN IP "just work" without hand-editing this
    // field first: if you reached this page at http://192.168.x.x:8080/,
    // the signaling server — normally run on the same machine — is almost
    // certainly reachable at ws://192.168.x.x:8787 too. Note this field is
    // only read once, right here, at page load: changing it afterward
    // requires reloading the page for the new value to actually take effect
    // for the connection and any room link this tab creates.
    $('signalUrl').value = `ws://${location.hostname}:8787`;
  }

  const wsUrl = $('signalUrl').value;
  const signaling = new SignalingClient(wsUrl);

  // Load the local engine in the background rather than awaiting it before
  // anything else: it needs engine/pkg/qsim.js to exist and to be reachable
  // from wherever this page is served (see engine/README.md's build step and
  // the "serve the repo root, not web/" note below) — a slow or failed load
  // must never block creating/joining a room, which doesn't need the engine
  // at all, or leave the page looking inert with no explanation. Room
  // handlers below `await` this promise only once they actually need a
  // working local worker.
  const localEnginePromise = makeLocalEngine().then(
    ({ bridge, info }) => {
      log(`engine ready: qsim v${info.engineVersion}, max ${info.maxShardQubits} qubits/shard`);
      return bridge;
    },
    (err) => {
      log(
        `engine failed to load: ${err.message} — check that engine/pkg/qsim.js exists ` +
          `(run engine/build.sh) and that you're serving the repo root, not web/, so ` +
          `/engine/pkg/... resolves. See docs/DISTRIBUTED_ENTANGLEMENT_PLAN.md §6.1.`
      );
      throw err;
    }
  );

  let mesh = null;
  let orchestratorOrRuntime = null;
  let isHost = false;

  const connectToKnownPeers = (peerIds) => {
    for (const peerId of peerIds) {
      mesh.connectTo(peerId);
      mesh.waitUntilReady(peerId).then(
        () => log(`connected to peer ${peerId}`),
        () => {}
      );
    }
  };

  function wireMeshDiagnostics() {
    mesh.addEventListener('peer-connected', (e) => log(`mesh: peer ${e.detail.peerId} ready`));
    mesh.addEventListener('peer-disconnected', (e) => log(`mesh: peer ${e.detail.peerId} disconnected${e.detail.error ? ` (${e.detail.error.message})` : ''}`));
    mesh.addEventListener('peer-error', (e) => log(`mesh: error with ${e.detail.peerId}: ${e.detail.error.message}`));
  }

  signaling.addEventListener('room-created', async (e) => {
    isHost = true;
    $('roomCode').textContent = e.detail.room;
    $('shareLink').value = `${location.origin}${location.pathname}?room=${e.detail.room}&signal=${encodeURIComponent(wsUrl)}`;
    mesh = new PeerMesh(signaling, e.detail.peerId);
    wireMeshDiagnostics();
    log(`room ${e.detail.room} created — you are the host`);
    try {
      const localBridge = await localEnginePromise;
      orchestratorOrRuntime = new HostOrchestrator({ mesh, localWorkerBridge: localBridge, selfId: e.detail.peerId });
      $('runButton').disabled = false;
    } catch {
      // Already logged by localEnginePromise's rejection handler above;
      // the room still exists and peers can still join, they just can't
      // run anything until the engine issue is fixed and the page reloaded.
    }
  });

  signaling.addEventListener('joined', async (e) => {
    isHost = false;
    mesh = new PeerMesh(signaling, e.detail.peerId);
    wireMeshDiagnostics();
    connectToKnownPeers(e.detail.peers.map((p) => p.peerId));
    log(`joined room as a peer; connecting to ${e.detail.peers.length} existing peer(s)`);
    try {
      const localBridge = await localEnginePromise;
      orchestratorOrRuntime = new PeerRuntime({ mesh, localWorkerBridge: localBridge });
    } catch {
      // Already logged; this peer stays connected to the mesh but can't
      // answer the host's work requests until the engine issue is fixed.
    }
  });

  signaling.addEventListener('peer-joined', (e) => {
    log(`peer ${e.detail.peerId} joined the room`);
    connectToKnownPeers([e.detail.peerId]);
  });

  signaling.addEventListener('join-failed', (e) => log(`join failed: ${e.detail.reason}`));
  signaling.addEventListener('server-error', (e) => log(`signaling error: ${e.detail.message}`));

  // Disabled until the signaling socket actually reaches OPEN — clicking
  // before then would throw (WebSocket.send on a still-CONNECTING socket).
  $('createRoomBtn').disabled = true;
  $('joinRoomBtn').disabled = true;
  $('createRoomBtn').addEventListener('click', () => signaling.createRoom());
  $('joinRoomBtn').addEventListener('click', () => signaling.joinRoom($('roomInput').value.trim()));

  for (const [name, circuit] of Object.entries(PRESETS)) {
    document.querySelector(`[data-preset="${name}"]`)?.addEventListener('click', () => {
      $('circuit').value = JSON.stringify(circuit, null, 2);
    });
  }

  $('runButton').addEventListener('click', async () => {
    if (!isHost) return log('only the host starts a run');
    const mode = $('mode').value;
    const circuit = parseCircuit($('circuit').value);
    const includeSelf = $('includeSelf').checked;
    $('results').textContent = '';
    const started = performance.now();
    try {
      if (mode === 'shots') {
        const nQubits = Number($('qubits').value);
        const totalShots = Number($('totalShots').value);
        log(`running shots mode: ${nQubits} qubits, ${totalShots} shots across ${mesh.connectedPeerIds().length + (includeSelf ? 1 : 0)} machine(s)`);
        const result = await orchestratorOrRuntime.runShotsMode({ circuit, nQubits, totalShots, includeSelf });
        log(`done in ${((performance.now() - started) / 1000).toFixed(1)}s — ${result.participantsUsed} participant(s), ${result.shotsShortfallRecovered} shots recovered from a dropped peer`);
        $('results').textContent = renderHistogram(result.histogram, nQubits);
      } else {
        const globalQubits = Number($('qubits').value);
        const maxShardQubits = Number($('maxShardQubits').value);
        const totalShotsToSample = Number($('totalShots').value);
        const assignments = orchestratorOrRuntime.defaultAssignment(
          1 << Math.max(0, globalQubits - maxShardQubits),
          { includeSelf }
        );
        log(`running expand mode: ${globalQubits} global qubits, ${assignments.length} shard(s) needed`);
        const result = await orchestratorOrRuntime.runExpandMode({ circuit, globalQubits, maxShardQubits, assignments, totalShotsToSample });
        log(`done in ${((performance.now() - started) / 1000).toFixed(1)}s — ${result.shards} shards x ${result.localQubits} local qubits`);
        $('results').textContent = renderHistogram(result.histogram, globalQubits);
      }
    } catch (err) {
      log(`run failed: ${err.message}`);
    }
  });

  await signaling.connect();
  log(`connected to signaling server at ${wsUrl}`);
  $('createRoomBtn').disabled = false;
  $('joinRoomBtn').disabled = false;

  // Auto-join if the page was opened via a shared room link (`params` was
  // read at the top of main(), before it was used to override signalUrl).
  if (params.get('room')) {
    $('roomInput').value = params.get('room');
    signaling.joinRoom(params.get('room'));
  }
}

main().catch((err) => log(`fatal: ${err.message}`));
