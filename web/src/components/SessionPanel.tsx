/**
 * The sidebar's session card(s), in all three roles.
 *
 * Solo: one button — share this session. Host: the room code, the link to
 * hand out, and how many machines are helping. Viewer: where this page is
 * connected, and what its machine is working on right now — the whole point
 * of joining being that your computer contributes shots while you watch.
 */
import { useState } from 'react';
import type { Session } from '../net/session';
import { Info } from './Info';

export function SessionPanel({ session }: { session: Session }) {
  const [copied, setCopied] = useState(false);

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
    return (
      <section className="card">
        <h2 className="card-title">Sharing</h2>
        <p className="session-room">
          Room <strong>{session.room}</strong>
        </p>
        <div className="share-row">
          <input
            readOnly
            value={session.link ?? ''}
            aria-label="Share link"
            onClick={(e) => e.currentTarget.select()}
          />
          <button
            className="btn"
            onClick={() => {
              if (!session.link) return;
              void navigator.clipboard.writeText(session.link).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="note">
          {session.workers() === 0
            ? 'no one connected yet — send the link'
            : `${session.workers()} machine${session.workers() === 1 ? '' : 's'} helping with the shots`}
        </p>
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
