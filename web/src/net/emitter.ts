/**
 * A minimal typed event emitter.
 *
 * The networking layer is event-shaped (a signaling message arrives, a peer
 * connects, a control frame lands) but the DOM's EventTarget forces every
 * payload through `CustomEvent.detail` and erases its type on the way. This
 * keeps the same shape — `on(type, fn)`, payloads per event — with the types
 * intact, and works identically under Node for the unit tests.
 */
type Listener<T> = (detail: T) => void;

export class Emitter<Events extends Record<string, unknown>> {
  #listeners = new Map<string, Set<Listener<never>>>();

  /** Subscribe; returns the matching unsubscribe. */
  on<K extends keyof Events & string>(type: K, fn: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(fn as Listener<never>);
    return () => set.delete(fn as Listener<never>);
  }

  emit<K extends keyof Events & string>(type: K, detail: Events[K]): void {
    const set = this.#listeners.get(type);
    if (!set) return;
    // Copied so a listener that unsubscribes (or subscribes) mid-dispatch
    // cannot affect this dispatch.
    for (const fn of [...set]) (fn as Listener<Events[K]>)(detail);
  }
}
