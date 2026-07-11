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
  const pendingSnapshots: Snapshot[] = [];
  let dispatching = false;

  function setSnapshot(nextSnapshot: Snapshot): void {
    const latestSnapshot = pendingSnapshots.at(-1) ?? snapshot;
    if (Object.is(latestSnapshot, nextSnapshot)) {
      return;
    }
    pendingSnapshots.push(nextSnapshot);
    if (dispatching) {
      return;
    }

    dispatching = true;
    try {
      while (pendingSnapshots.length > 0) {
        const queuedSnapshot = pendingSnapshots.shift() as Snapshot;
        snapshot = queuedSnapshot;
        [...listeners].forEach((listener) => listener(queuedSnapshot));
      }
    } finally {
      dispatching = false;
    }
  }

  return {
    getSnapshot: () => snapshot,
    setSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
