export const RESTORE_STORAGE_LEASE_TTL_MS = 15 * 60 * 1_000;

export interface RestoreStorageLease {
  schemaVersion: 1;
  operationId: string;
  epoch: number;
  draftKey: string;
  baseRevision: number;
  draftRevision: number;
  screenshotKeys: string[];
  screenshotFingerprints: Record<string, string>;
  createdAt: number;
  expiresAt: number;
}
