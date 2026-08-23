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
import { expandCapacity, shotCapacity } from '../net/capacity';
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
}: {
  session: Session;
  mode: DistributedMode;
  onMode: (mode: DistributedMode) => void;
  shots: number;
  qubitCeiling: number;
  maxShardQubits: number | null;
}) {
  const [copied, setCopied] = useState(false);
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
        <button className="btn btn-primary" onClick={() => void session.share()}>
          Share this session
        </button>
        <p className="field-hint">
          Others watch this run live and their machines help take the shots.
        </p>
        {session.error && <p className="error">{session.error}</p>}
      </section>
    );
  }

  if (session.role === 'host') {
    const helpers = session.workers();
    const shot = shotCapacity(shots, helpers);
    const expand = expandCapacity(helpers + 1, maxShardQubits ?? 26);
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
            : `${session.workers()} machine${session.workers() === 1 ? '' : 's'} helping with the shots`}
        </p>
        <label className="field">
          <span className="field-label">Distributed mode</span>
          <select value={mode} onChange={(e) => onMode(e.target.value as DistributedMode)}>
            <option value="shots">Shots — pooled measurement</option>
            <option value="expand" disabled>Expand — not implemented yet</option>
          </select>
        </label>
        <dl className="capacity-list">
          <div>
            <dt>Machines</dt>
            <dd>{shot.machines} ({helpers} helping)</dd>
          </div>
          <div>
            <dt>Shot capacity</dt>
            <dd>
              {shots.toLocaleString()} total · {shot.smallestShare.toLocaleString()}
              {shot.smallestShare === shot.largestShare
                ? ''
                : `–${shot.largestShare.toLocaleString()}`} each
            </dd>
          </div>
          <div>
            <dt>Register capacity</dt>
            <dd>{qubitCeiling} qubits (unchanged in Shots)</dd>
          </div>
        </dl>
        <details className="capacity-details">
          <summary>Expand capacity preview</summary>
          <p className="field-hint">
            {expand.usableShards} usable shard{expand.usableShards === 1 ? '' : 's'} across the
            largest power-of-two group: up to {expand.maxQubits} qubits, {bytes(expand.bytesPerShard)}{' '}
            per machine ({bytes(expand.totalBytes)} total state). Expand transport is planned but not
            connected yet.
          </p>
        </details>
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
