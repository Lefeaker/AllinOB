import type { StorageAreaService } from '../../platform/interfaces/storage';
import {
  collectSessionDraftScreenshotRefs,
  readSessionDraftReferenceIndex
} from '../../content/sessionDrafts/sessionDraftReferenceIndex';
import { normalizeSessionDraftPageUrl } from '../../content/sessionDrafts/sessionDraftKeys';
import { normalizeSessionDraftEnvelope } from '../../content/sessionDrafts/sessionDraftEnvelopeCodec';
import {
  isRestorableSessionDraftStatus,
  type SessionDraftEnvelope,
  type SessionDraftOwnerContext
} from '../../content/sessionDrafts/sessionDraftTypes';
import {
  getSessionDraftEnvelopeOwnerContext,
  isSameSessionDraftOwnerContext
} from '../../content/sessionDrafts/sessionDraftTabContext';
import type { SessionDraftOperationContext } from '../../content/sessionDrafts/sessionDraftRepositoryMessages';
import { matchesVideoScreenshotCacheRef } from '../../content/video/videoScreenshotCacheIndex';
import type { VideoScreenshotCacheBlobEntry } from '../../content/video/videoScreenshotCacheStore';
import { canonicalJsonStringify } from '../../shared/serialization/canonicalJson';
import { readLiveRestoreStorageLease } from './restoreStorageLeaseStore';
import { createVideoScreenshotRequestFingerprint } from './videoScreenshotCacheFingerprint';
import { serializeVideoScreenshot } from './videoScreenshotCacheSerialization';
import {
  RESTORE_STORAGE_PROTOCOL_STATE_INVALID,
  RESTORE_STORAGE_REFERENCE_LEASE_REQUIRED,
  type SessionDraftRepositoryServiceDependencies
} from './sessionDraftRepositoryServiceTypes';

export async function validateNewSessionDraftReferences(
  previous: SessionDraftEnvelope | null,
  next: SessionDraftEnvelope,
  context: SessionDraftOperationContext,
  dependencies: SessionDraftRepositoryServiceDependencies
) {
  const previousRefs = new Map<
    string,
    ReturnType<typeof collectSessionDraftScreenshotRefs>[number]
  >();
  for (const ref of previous ? collectSessionDraftScreenshotRefs(previous) : []) {
    previousRefs.set(ref.key, ref);
  }
  const newRefs = collectSessionDraftScreenshotRefs(next).filter((ref) => {
    const previousRef = previousRefs.get(ref.key);
    return !previousRef || canonicalJsonStringify(previousRef) !== canonicalJsonStringify(ref);
  });
  if (newRefs.length === 0) return newRefs;
  const now = Date.now();
  const lease = await readLiveRestoreStorageLease(dependencies.local, context.operationId, now);
  const durableRefFingerprints = await readCrossDraftReferenceFingerprints(
    dependencies.local,
    context.draftKey,
    next,
    dependencies.requestOwnerContext,
    now
  );
  for (const ref of newRefs) {
    const blobResult = await dependencies.screenshots.get(ref.key);
    const blob = blobResult.status === 'found' ? blobResult.entry : null;
    const leaseMatchesOperation =
      lease?.epoch === context.epoch &&
      lease.draftKey === context.draftKey &&
      lease.baseRevision === context.baseRevision &&
      lease.draftRevision === context.nextRevision &&
      lease.screenshotKeys.includes(ref.key);
    const blobFingerprint =
      leaseMatchesOperation && blob ? await fingerprintStoredScreenshot(blob) : null;
    const leaseAuthorizes =
      blobFingerprint !== null && lease?.screenshotFingerprints[ref.key] === blobFingerprint;
    const durableDraftAuthorizes = durableRefFingerprints
      .get(ref.key)
      ?.has(canonicalJsonStringify(ref));
    if (
      (!leaseAuthorizes && !durableDraftAuthorizes) ||
      !blob ||
      blob.expiresAt <= now ||
      !matchesVideoScreenshotCacheRef(blob, ref)
    ) {
      throw new Error(RESTORE_STORAGE_REFERENCE_LEASE_REQUIRED);
    }
  }
  return newRefs;
}

async function fingerprintStoredScreenshot(
  blob: VideoScreenshotCacheBlobEntry
): Promise<string | null> {
  try {
    const serialized = await serializeVideoScreenshot({
      id: blob.id,
      fileName: blob.fileName,
      mimeType: blob.mimeType,
      capturedAt: blob.capturedAt,
      content: { kind: 'blob', blob: blob.blob, byteLength: blob.byteLength }
    });
    return await createVideoScreenshotRequestFingerprint(serialized);
  } catch {
    return null;
  }
}

async function readCrossDraftReferenceFingerprints(
  area: Pick<StorageAreaService, 'getAll'>,
  currentDraftKey: string,
  next: SessionDraftEnvelope,
  requestOwnerContext: SessionDraftOwnerContext | null | undefined,
  now: number
): Promise<Map<string, Set<string>>> {
  if (!requestOwnerContext) return new Map();
  const snapshot = await readSessionDraftReferenceIndex(area);
  const fingerprints = new Map<string, Set<string>>();
  for (const draft of snapshot.drafts) {
    if (
      draft.key === currentDraftKey ||
      draft.envelope.mode !== next.mode ||
      draft.envelope.pageKey !== next.pageKey ||
      !hasSameNormalizedPage(draft.envelope, next) ||
      !isRestorableSessionDraftStatus(draft.envelope.status) ||
      draft.envelope.expiresAt <= now ||
      !isSameSessionDraftOwnerContext(
        getSessionDraftEnvelopeOwnerContext(draft.envelope),
        requestOwnerContext
      )
    ) {
      continue;
    }
    for (const ref of collectSessionDraftScreenshotRefs(draft.envelope)) {
      const values = fingerprints.get(ref.key) ?? new Set<string>();
      values.add(canonicalJsonStringify(ref));
      fingerprints.set(ref.key, values);
    }
  }
  return fingerprints;
}

function hasSameNormalizedPage(left: SessionDraftEnvelope, right: SessionDraftEnvelope): boolean {
  try {
    return (
      normalizeSessionDraftPageUrl(left.mode, left.pageUrl) ===
      normalizeSessionDraftPageUrl(right.mode, right.pageUrl)
    );
  } catch {
    return false;
  }
}

export async function readStoredSessionDraftEnvelope(
  area: Pick<StorageAreaService, 'get'>,
  draftKey: string
): Promise<SessionDraftEnvelope | null> {
  const raw = await area.get(draftKey);
  if (raw === undefined) return null;
  const envelope = normalizeSessionDraftEnvelope(raw);
  if (!envelope) {
    throw new Error(RESTORE_STORAGE_PROTOCOL_STATE_INVALID);
  }
  return envelope;
}
