/* @vitest-environment node */

import { describe, expect, it } from 'vitest';
import { createMemoryStorageArea } from '@platform/preview/memoryStorage';
import { createSessionDraftStorageKey } from '@content/sessionDrafts/sessionDraftKeys';
import {
  createSessionDraftCursorStorageKey,
  createSessionDraftTombstoneStorageKey,
  type SessionDraftCursor,
  type SessionDraftTombstone
} from '@content/sessionDrafts/sessionDraftLifecycleRecords';
import type {
  SessionDraftOwnerContext,
  SessionDraftStatus,
  VideoSessionDraftEnvelope
} from '@content/sessionDrafts/sessionDraftTypes';
import type { VideoScreenshotCacheBlobEntry } from '@content/video/videoScreenshotCacheStore';
import {
  createVideoScreenshotCacheStorageKey,
  type VideoScreenshotCacheRef
} from '@content/video/videoScreenshotCacheTypes';
import { asType } from '../../utils/typeHelpers';
import { validateNewSessionDraftReferences } from '../../../src/background/services/sessionDraftSaveReferences';
import type { SessionDraftRepositoryServiceDependencies } from '../../../src/background/services/sessionDraftRepositoryServiceTypes';
import { createVideoScreenshotRequestFingerprint } from '../../../src/background/services/videoScreenshotCacheFingerprint';
import { serializeVideoScreenshot } from '../../../src/background/services/videoScreenshotCacheSerialization';

const PAGE_KEY = 'page-cross-draft';
const PAGE_URL = 'https://video.example/cross-draft';
const OWNER: SessionDraftOwnerContext = { tabId: 7, windowId: 3, frameId: 0 };

function ref(id: string, expiresAt = Date.now() + 60_000): VideoScreenshotCacheRef {
  return {
    schemaVersion: 1,
    key: createVideoScreenshotCacheStorageKey({
      pageKey: PAGE_KEY,
      captureId: `capture-${id}`,
      screenshotId: id
    }),
    pageKey: PAGE_KEY,
    captureId: `capture-${id}`,
    id,
    fileName: `${id}.jpg`,
    mimeType: 'image/jpeg',
    byteLength: 5,
    capturedAt: Date.now() - 1_000,
    expiresAt
  };
}

function draft(
  draftId: string,
  refs: readonly VideoScreenshotCacheRef[],
  options: {
    ownerContext?: SessionDraftOwnerContext | null;
    status?: SessionDraftStatus;
    expiresAt?: number;
    pageKey?: string;
    pageUrl?: string;
  } = {}
): VideoSessionDraftEnvelope {
  const now = Date.now();
  return {
    schemaVersion: 1,
    draftId,
    mode: 'video',
    pageKey: options.pageKey ?? PAGE_KEY,
    pageUrl: options.pageUrl ?? PAGE_URL,
    pageTitle: 'Cross-draft refs',
    createdAt: now - 1_000,
    updatedAt: now,
    expiresAt: options.expiresAt ?? now + 60_000,
    status: options.status ?? 'active',
    payload: {
      ...(options.ownerContext === null ? {} : { ownerContext: options.ownerContext ?? OWNER }),
      captures: refs.map((screenshotRef, index) => ({
        kind: 'timestamp',
        id: screenshotRef.captureId,
        timeSec: index,
        url: PAGE_URL,
        comment: '',
        createdAt: now - 500 + index,
        screenshotRequested: true,
        screenshotRef
      }))
    }
  };
}

function key(envelope: VideoSessionDraftEnvelope): string {
  return createSessionDraftStorageKey({
    mode: envelope.mode,
    pageKey: envelope.pageKey,
    draftId: envelope.draftId
  });
}

function entry(screenshotRef: VideoScreenshotCacheRef): VideoScreenshotCacheBlobEntry {
  return {
    ...screenshotRef,
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now() - 1_000,
    blob: new Blob(['frame'], { type: screenshotRef.mimeType })
  };
}

async function setup(options: {
  sourceRef?: VideoScreenshotCacheRef | undefined;
  nextOldRef: VideoScreenshotCacheRef;
  oldBlob?: VideoScreenshotCacheBlobEntry | undefined;
  sourceOwnerContext?: SessionDraftOwnerContext | null | undefined;
  requestOwnerContext?: SessionDraftOwnerContext | null | undefined;
  sourceStatus?: SessionDraftStatus | undefined;
  sourceExpiresAt?: number | undefined;
  sourcePageKey?: string | undefined;
  sourcePageUrl?: string | undefined;
  lifecycleRecords?:
    | 'deleted'
    | 'cursor-only'
    | 'tombstone-only'
    | 'malformed-cursor'
    | 'malformed-tombstone'
    | undefined;
}) {
  const local = createMemoryStorageArea();
  const newRef = ref('new-leased');
  const next = draft('current-new-identity', [options.nextOldRef, newRef]);
  const context = {
    operationId: 'operation-cross-draft-ref',
    epoch: 1,
    draftKey: key(next),
    baseRevision: 0,
    nextRevision: 1
  };
  if (options.sourceRef) {
    const source = draft('restored-exact-source', [options.sourceRef], {
      ownerContext: options.sourceOwnerContext === undefined ? OWNER : options.sourceOwnerContext,
      ...(options.sourceStatus ? { status: options.sourceStatus } : {}),
      ...(options.sourceExpiresAt === undefined ? {} : { expiresAt: options.sourceExpiresAt }),
      ...(options.sourcePageKey ? { pageKey: options.sourcePageKey } : {}),
      ...(options.sourcePageUrl ? { pageUrl: options.sourcePageUrl } : {})
    });
    const sourceKey = key(source);
    await local.set(sourceKey, source);
    const cursorKey = createSessionDraftCursorStorageKey(sourceKey);
    const tombstoneKey = createSessionDraftTombstoneStorageKey(sourceKey);
    const cursor = {
      schemaVersion: 1,
      epoch: 1,
      state: 'deleted',
      draftKey: sourceKey,
      revision: 1,
      lastOperationId: 'delete-source'
    } satisfies SessionDraftCursor;
    const tombstone = {
      schemaVersion: 1,
      epoch: 1,
      state: 'deleted',
      draftKey: sourceKey,
      revision: 1,
      operationId: 'delete-source'
    } satisfies SessionDraftTombstone;
    if (options.lifecycleRecords === 'deleted') {
      await local.setMany({ [cursorKey]: cursor, [tombstoneKey]: tombstone });
    } else if (options.lifecycleRecords === 'cursor-only') {
      await local.set(cursorKey, cursor);
    } else if (options.lifecycleRecords === 'tombstone-only') {
      await local.set(tombstoneKey, tombstone);
    } else if (options.lifecycleRecords === 'malformed-cursor') {
      await local.setMany({ [cursorKey]: 'malformed', [tombstoneKey]: tombstone });
    } else if (options.lifecycleRecords === 'malformed-tombstone') {
      await local.setMany({ [cursorKey]: cursor, [tombstoneKey]: 'malformed' });
    }
  }
  const newBlob = entry(newRef);
  const serializedNewBlob = await serializeVideoScreenshot({
    id: newBlob.id,
    fileName: newBlob.fileName,
    mimeType: newBlob.mimeType,
    capturedAt: newBlob.capturedAt,
    content: { kind: 'blob', blob: newBlob.blob, byteLength: newBlob.byteLength }
  });
  const newFingerprint = await createVideoScreenshotRequestFingerprint(serializedNewBlob);
  await local.set(`aiob.restoreStorage.lease.v1.${context.operationId}`, {
    schemaVersion: 1,
    operationId: context.operationId,
    epoch: context.epoch,
    draftKey: context.draftKey,
    baseRevision: context.baseRevision,
    draftRevision: context.nextRevision,
    screenshotKeys: [newRef.key],
    screenshotFingerprints: { [newRef.key]: newFingerprint },
    createdAt: Date.now() - 1,
    expiresAt: Date.now() - 1 + 15 * 60 * 1_000
  });
  const blobs = new Map(
    [options.oldBlob, newBlob]
      .filter((value): value is VideoScreenshotCacheBlobEntry => value !== undefined)
      .map((value) => [value.key, value])
  );
  const dependencies = asType<SessionDraftRepositoryServiceDependencies>({
    local,
    ...(options.requestOwnerContext === null
      ? {}
      : { requestOwnerContext: options.requestOwnerContext ?? OWNER }),
    screenshots: {
      get(screenshotKey: string) {
        const found = blobs.get(screenshotKey);
        return Promise.resolve(found ? { status: 'found', entry: found } : { status: 'missing' });
      }
    }
  });
  return { local, next, context, dependencies, newRef };
}

describe('cross-draft durable screenshot reference validation', () => {
  it.each([
    { label: 'missing', fingerprint: undefined },
    { label: 'mismatched', fingerprint: 'a'.repeat(64) }
  ])('rejects a $label lease fingerprint for a new screenshot ref', async ({ fingerprint }) => {
    const oldRef = ref(`old-${fingerprint ? 'mismatch' : 'missing'}`);
    const rig = await setup({ nextOldRef: oldRef });
    const leaseKey = `aiob.restoreStorage.lease.v1.${rig.context.operationId}`;
    const lease = await rig.local.get<Record<string, unknown>>(leaseKey);
    if (!lease) throw new Error('expected lease fixture');
    await rig.local.set(leaseKey, {
      ...lease,
      screenshotFingerprints: fingerprint ? { [rig.newRef.key]: fingerprint } : {}
    });
    const previous = draft('previous-current', [oldRef]);

    await expect(
      validateNewSessionDraftReferences(previous, rig.next, rig.context, rig.dependencies)
    ).rejects.toThrow('RESTORE_STORAGE_REFERENCE_LEASE_REQUIRED');
  });

  it.each([
    { label: 'active source', sourceStatus: 'active' as const, sourcePageUrl: PAGE_URL },
    {
      label: 'restorable hash-variant source',
      sourceStatus: 'restorable' as const,
      sourcePageUrl: `${PAGE_URL}#restored-position`
    }
  ])('accepts an exact durable old ref from a same-owner $label', async (sourceOptions) => {
    const oldRef = ref(`old-durable-${sourceOptions.sourceStatus}`);
    const rig = await setup({
      sourceRef: oldRef,
      nextOldRef: oldRef,
      oldBlob: entry(oldRef),
      sourceStatus: sourceOptions.sourceStatus,
      sourcePageUrl: sourceOptions.sourcePageUrl
    });

    await expect(
      validateNewSessionDraftReferences(null, rig.next, rig.context, rig.dependencies)
    ).resolves.toEqual(
      [oldRef, rig.newRef].sort((left, right) => left.key.localeCompare(right.key))
    );
  });

  it.each([
    {
      label: 'no durable source',
      configure: () => {
        const oldRef = ref('old-no-source');
        return { nextOldRef: oldRef, oldBlob: entry(oldRef) };
      }
    },
    {
      label: 'durable metadata mismatch',
      configure: () => {
        const nextOldRef = ref('old-mismatch');
        return {
          sourceRef: { ...nextOldRef, fileName: 'different.jpg' },
          nextOldRef,
          oldBlob: entry(nextOldRef)
        };
      }
    },
    {
      label: 'missing blob',
      configure: () => {
        const oldRef = ref('old-missing');
        return { sourceRef: oldRef, nextOldRef: oldRef };
      }
    },
    {
      label: 'expired blob',
      configure: () => {
        const oldRef = ref('old-expired', Date.now() - 1);
        return { sourceRef: oldRef, nextOldRef: oldRef, oldBlob: entry(oldRef) };
      }
    },
    {
      label: 'ownerless durable source',
      configure: () => {
        const oldRef = ref('old-ownerless');
        return {
          sourceRef: oldRef,
          nextOldRef: oldRef,
          oldBlob: entry(oldRef),
          sourceOwnerContext: null
        };
      }
    },
    {
      label: 'different owner',
      configure: () => {
        const oldRef = ref('old-other-owner');
        return {
          sourceRef: oldRef,
          nextOldRef: oldRef,
          oldBlob: entry(oldRef),
          sourceOwnerContext: { tabId: 99, windowId: 3, frameId: 0 }
        };
      }
    },
    {
      label: 'missing request owner',
      configure: () => {
        const oldRef = ref('old-no-request-owner');
        return {
          sourceRef: oldRef,
          nextOldRef: oldRef,
          oldBlob: entry(oldRef),
          requestOwnerContext: null
        };
      }
    },
    ...(['discarded', 'exported'] as const).map((sourceStatus) => ({
      label: `${sourceStatus} source`,
      configure: () => {
        const oldRef = ref(`old-${sourceStatus}`);
        return {
          sourceRef: oldRef,
          nextOldRef: oldRef,
          oldBlob: entry(oldRef),
          sourceStatus
        };
      }
    })),
    {
      label: 'expired source',
      configure: () => {
        const oldRef = ref('old-expired-source');
        return {
          sourceRef: oldRef,
          nextOldRef: oldRef,
          oldBlob: entry(oldRef),
          sourceExpiresAt: Date.now() - 1
        };
      }
    },
    {
      label: 'different page source',
      configure: () => {
        const oldRef = ref('old-other-page');
        return {
          sourceRef: oldRef,
          nextOldRef: oldRef,
          oldBlob: entry(oldRef),
          sourcePageKey: 'other-page',
          sourcePageUrl: 'https://video.example/other-page'
        };
      }
    },
    {
      label: 'tombstoned source',
      configure: () => {
        const oldRef = ref('old-tombstoned');
        return {
          sourceRef: oldRef,
          nextOldRef: oldRef,
          oldBlob: entry(oldRef),
          lifecycleRecords: 'deleted' as const
        };
      }
    },
    ...(['cursor-only', 'tombstone-only', 'malformed-cursor', 'malformed-tombstone'] as const).map(
      (lifecycleRecords) => ({
        label: `${lifecycleRecords} lifecycle authority`,
        configure: () => {
          const oldRef = ref(`old-${lifecycleRecords}`);
          return {
            sourceRef: oldRef,
            nextOldRef: oldRef,
            oldBlob: entry(oldRef),
            lifecycleRecords
          };
        }
      })
    )
  ])('rejects an unleased old ref with $label', async ({ configure }) => {
    const rig = await setup(configure());

    await expect(
      validateNewSessionDraftReferences(null, rig.next, rig.context, rig.dependencies)
    ).rejects.toThrow('RESTORE_STORAGE_REFERENCE_LEASE_REQUIRED');
  });
});
