import { useEffect, useState } from 'react';
import { EngineClient } from './engineClient';
import type { EngineInfo } from './protocol';

/**
 * Own one worker for the lifetime of the mount.
 *
 * The client is created *inside* the effect rather than in a ref during render,
 * so StrictMode's deliberate mount/unmount/remount cycle builds a fresh worker
 * on remount. Holding it in a ref would leave the second mount pointing at the
 * worker the first mount's cleanup already terminated.
 */
export function useEngine() {
  const [client, setClient] = useState<EngineClient | null>(null);
  const [info, setInfo] = useState<EngineInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const c = new EngineClient();
    let alive = true;
    setClient(c);
    setError(null);

    c.call<EngineInfo>({ kind: 'info' })
      .then((i) => alive && setInfo(i))
      .catch((e: Error) => alive && setError(e.message));

    return () => {
      alive = false;
      c.terminate();
    };
  }, []);

  return { client, info, error };
}
