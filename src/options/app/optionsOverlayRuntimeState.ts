export interface OptionsOverlayRuntimeStatePort<Snapshot = unknown> {
  getSnapshot(): Snapshot;
  setSnapshot(snapshot: Snapshot): void;
  subscribe(listener: (snapshot: Snapshot) => void): () => void;
}

export type OptionsOverlayAppDataSnapshot = Readonly<Record<string, unknown>>;

export function createOptionsOverlayRuntimeState<Snapshot>(
  initialSnapshot: Snapshot
): OptionsOverlayRuntimeStatePort<Snapshot> {
  let snapshot = initialSnapshot;
  const listeners = new Set<(value: Snapshot) => void>();

  return {
    getSnapshot: () => snapshot,
    setSnapshot(nextSnapshot) {
      if (Object.is(snapshot, nextSnapshot)) {
        return;
      }
      snapshot = nextSnapshot;
      listeners.forEach((listener) => listener(nextSnapshot));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
