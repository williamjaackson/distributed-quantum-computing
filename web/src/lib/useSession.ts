/**
 * The shared session, adapted to React.
 *
 * One Session for the page's lifetime. It is a mutable object with its own
 * subscription counter, so `useSyncExternalStore` re-renders the app whenever
 * anything about the session changes and components read its fields directly.
 *
 * The role is decided here, once, from the URL: a page opened via a share
 * link (`?j=CODE`) joins that room as a read-only viewer; anything else
 * starts solo and may become a host by sharing. `?s=` overrides the signaling
 * server address for the rare setup where the relay is not on the page's own
 * origin.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Session } from '../net/session';

export function useSession(): Session {
  const [session] = useState(() => {
    const params = new URLSearchParams(location.search);
    return new Session({ signalUrl: params.get('s') ?? undefined });
  });
  useSyncExternalStore(
    session.subscribe,
    () => session.version,
    () => session.version,
  );
  useEffect(() => {
    const code = new URLSearchParams(location.search).get('j');
    if (code) void session.join(code.trim().toUpperCase());
  }, [session]);
  return session;
}
