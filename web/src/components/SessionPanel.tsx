/**
 * The sidebar's session card(s), in all three roles.
 *
 * Solo: one button — share this session. Host: the room code, the link to
 * hand out, and how many machines are helping. Viewer: where this page is
 * connected, and what its machine is working on right now — the whole point
 * of joining being that your computer contributes shots while you watch.
 */
import { useRef, useState } from 'react';
import type { Session } from '../net/session';
import { shotCapacity } from '../net/capacity';
import { maxDistributedQubits, planDistributedShards } from '../net/expand-plan';
import { Info } from './Info';

export type DistributedMode = 'shots' | 'expand';

function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit++;
  }
  return `${Number.isInteger(n) ? n : n.toFixed(1)} ${units[unit]}`;
}

export function SessionPanel({
  session,
  mode,
  onMode,
  shots,
  qubitCeiling,
  maxShardQubits,
  localLayout,
  currentQubits,
}: {
  session: Session;
  mode: DistributedMode;
  onMode: (mode: DistributedMode) => void;
  shots: number;
  qubitCeiling: number;
  maxShardQubits: number | null;
  localLayout: string | null;
  currentQubits: number | null;
}) {
  const [copied, setCopied] = useState(false);
  const [roomCode, setRoomCode] = useState('');
  const roomCodeValid =
    roomCode === '' || /^(?=.{3,24}$)[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])$/.test(roomCode);
  const linkInput = useRef<HTMLInputElement>(null);

  const copyLink = async () => {
    if (!session.link) return;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(session.link);
        ok = true;
      }
    } catch {
      // Clipboard is unavailable on non-secure LAN origins; fall through to
      // the selection-based browser API that still works there.
    }
    if (!ok && linkInput.current) {
      linkInput.current.focus();
      linkInput.current.select();
      ok = document.execCommand('copy');
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  if (session.role === 'solo') {
    return (
      <section className="card">
        <h2 className="card-title">
          Share{' '}
          <Info about="shared sessions">
            Hosting opens a room on this page's server and gives you a link. Anyone who opens it
            watches your run live — read-only — and their machine takes a share of the measurement
            shots, so every viewer makes the histogram arrive faster.
          </Info>
        </h2>
        <label className="field">
          <span className="field-label">Room code</span>
          <input
            value={roomCode}
            maxLength={24}
            placeholder="leave blank for a random code"
            aria-label="Room code"
            aria-invalid={!roomCodeValid}
            onChange={(e) => setRoomCode(e.target.value.trimStart().toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && roomCodeValid) void session.share(roomCode || undefined);
            }}
          />
        </label>
        <button
          className="btn btn-primary"
          disabled={!roomCodeValid}
          onClick={() => void session.share(roomCode || undefined)}
        >
          Share this session
        </button>
        <p className="field-hint">
          3–24 letters, numbers, or hyphens. Leave blank for a random code.
        </p>
        {session.error && <p className="error">{session.error}</p>}
      </section>
    );
  }

  if (session.role === 'host') {
    const helpers = session.workers();
    const shot = shotCapacity(shots, helpers);
    const participants = session.expandParticipants();
    const contributedGiB = participants.reduce((sum, p) => sum + p.memoryGiB, 0);
    const roomQubits = maxDistributedQubits(
      participants.map(({ id, memoryGiB }) => ({ id, memoryGiB })),
      maxShardQubits ?? 26,
    );
    let liveExpand: ReturnType<typeof planDistributedShards> | null = null;
    let expandError: string | null = null;
    if (currentQubits !== null) {
      try {
        liveExpand = planDistributedShards(
          currentQubits,
          participants.map(({ id, memoryGiB }) => ({ id, memoryGiB })),
          maxShardQubits ?? 26,
        );
      } catch (e) {
        expandError = e instanceof Error ? e.message : String(e);
      }
    }
    return (
      <section className="card">
        <h2 className="card-title">Sharing</h2>
        <p className="session-room">
          Room <strong>{session.room}</strong>
        </p>
        <div className="share-row">
          <input
            ref={linkInput}
            readOnly
            value={session.link ?? ''}
            aria-label="Share link"
            onClick={(e) => e.currentTarget.select()}
          />
          <button
            className="btn"
            onClick={() => void copyLink()}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="note">
          {session.workers() === 0
            ? 'no one connected yet — send the link'
            : `${session.workers()} machine${session.workers() === 1 ? '' : 's'} helping with ${mode === 'expand' ? 'state-vector shards' : 'the shots'}`}
        </p>
        <label className="field">
          <span className="field-label">Distributed mode</span>
          <select value={mode} onChange={(e) => onMode(e.target.value as DistributedMode)}>
            <option value="shots">Shots — pooled measurement</option>
            <option value="expand">Expand — shared state-vector shards</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">This machine contributes</span>
          <select value={session.memoryGiB} onChange={(e) => session.setMemoryGiB(Number(e.target.value))}>
            {[0.25, 0.5, 1, 2, 4, 8, 16].map((gib) => (
              <option key={gib} value={gib}>{gib} GiB</option>
            ))}
          </select>
        </label>
        <dl className="capacity-list">
          <div>
            <dt>Machines</dt>
            <dd>{shot.machines} ({helpers} helping)</dd>
          </div>
          {mode === 'shots' ? (
            <>
              <div>
                <dt>Shot workload</dt>
                <dd>
                  {shots.toLocaleString()} total · {shot.smallestShare.toLocaleString()}
                  {shot.smallestShare === shot.largestShare
                    ? ''
                    : `–${shot.largestShare.toLocaleString()}`} each
                </dd>
              </div>
              <div>
                <dt>Per-machine register</dt>
                <dd>{qubitCeiling} qubits maximum</dd>
              </div>
              {localLayout && (
                <div>
                  <dt>Local worker shards</dt>
                  <dd>{localLayout}</dd>
                </div>
              )}
            </>
          ) : (
            <>
              <div>
                <dt>Room memory</dt>
                <dd>{contributedGiB} GiB contributed</dd>
              </div>
              <div>
                <dt>Memory capacity</dt>
                <dd>{roomQubits} qubits</dd>
              </div>
              <div>
                <dt>Runnable here</dt>
                <dd>
                  {Math.min(roomQubits, qubitCeiling)} qubits
                  {roomQubits > qubitCeiling ? ' (visualiser ceiling)' : ''}
                </dd>
              </div>
              {liveExpand && (
                <>
                  <div>
                    <dt>This register</dt>
                    <dd>{liveExpand.globalQubits} qubits · {bytes(liveExpand.totalBytes)}</dd>
                  </div>
                  <div>
                    <dt>Worker shards</dt>
                    <dd>{liveExpand.shards} × {bytes(liveExpand.bytesPerShard)}</dd>
                  </div>
                  <div>
                    <dt>Per machine</dt>
                    <dd>
                      {Object.entries(liveExpand.slotsByParticipant)
                        .map(([id, count]) => `${id === 'host' ? 'host' : id.slice(0, 6)}: ${count} shards`)
                        .join(' · ')}
                    </dd>
                  </div>
                </>
              )}
            </>
          )}
        </dl>
        {mode === 'expand' && expandError && <p className="error">{expandError}</p>}
        {session.error && <p className="error">{session.error}</p>}
      </section>
    );
  }

  // Viewer.
  const working = session.working;
  return (
    <>
      <section className="card">
        <h2 className="card-title">Session</h2>
        <p className="session-room">
          Room <strong>{session.room}</strong>
        </p>
        <p className="note">
          {session.error
            ? session.error
            : session.hostLost
              ? 'the host disconnected — what you see is the last shared run'
              : 'watching the host, read-only'}
        </p>
        <label className="field">
          <span className="field-label">Contribute to Expand</span>
          <select value={session.memoryGiB} onChange={(e) => session.setMemoryGiB(Number(e.target.value))}>
            {[0.25, 0.5, 1, 2, 4, 8, 16].map((gib) => (
              <option key={gib} value={gib}>{gib} GiB</option>
            ))}
          </select>
        </label>
      </section>
      <section className="card">
        <h2 className="card-title">
          Contributing{' '}
          <Info about="contributing">
            When the host measures, this machine is handed a share of the shots, runs the same
            circuit with its own seed, and sends back only the counts. Nothing else leaves this
            computer.
          </Info>
        </h2>
        {working ? (
          <>
            <p className="note">
              taking {working.shots.toLocaleString()} shots of <strong>{working.programId}</strong>
              {working.done > 0
                ? ` — ${working.done.toLocaleString()} done`
                : working.step > 0
                  ? ` — building the circuit, step ${working.step}`
                  : ' — starting…'}
            </p>
            {working.done > 0 && <progress value={working.done} max={working.shots} />}
          </>
        ) : session.shared?.distributedMode === 'expand' && session.hostedShards > 0 ? (
          <p className="note">
            hosting {session.hostedShards} state-vector shard{session.hostedShards === 1 ? '' : 's'}
            {' '}within a {session.memoryGiB} GiB contribution
          </p>
        ) : (
          <p className="note">waiting for work from the host</p>
        )}
        <p className="field-hint">
          {session.contributed.toLocaleString()} shot{session.contributed === 1 ? '' : 's'}{' '}
          contributed so far
        </p>
      </section>
    </>
  );
}
